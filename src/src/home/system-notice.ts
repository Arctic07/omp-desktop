/**
 * The engine's wrapper tags, and the background-job deliveries it writes inside them, read as the
 * facts they carry.
 *
 * The engine puts context a reader is meant to see inside angle brackets: `<system-notice>` around a
 * background job's delivery or around a user's own mid-turn interjection, `<system-reminder>` around
 * a nudge it injected, `<system-injection>` / `<system-notification>` around a retry or an isolation
 * note. Drawn as prose those tags are only text — nothing on this side reads them as elements — and
 * a delivery's `<task-result>`, `<meta>` and `<output>` arrive as a wall of angle brackets. This
 * module reads that text back into the facts it carries and decides nothing else: no React, no DOM,
 * no styling. `components/agents/system-notice.tsx` is the surface that draws what this returns.
 *
 * The engine's `<irc>` envelope is read by the same pass (`irc-message.ts` reads its body): a peer
 * agent's message is also harness-tagged text, and the reader gets the same wall of brackets
 * without it.
 *
 * `<important>` is the one tag a model wraps around a *line* of its own: a finding, a status it is
 * handing back. `MODEL_TAGS` collects it with the section tags a model names in its own answer
 * (`analysis` around its scratch work, `summary` around what it concluded), and `ANSWER_ENVELOPES`
 * holds the `final` envelope a model wraps the whole answer in. None of them is engine context, so
 * no delivery is read out of them and their bodies are the message's own words; they are read here
 * because the same pass already owns "a harness tag at the start of a line", and because every
 * consumer that asks this module for a message's prose has to know what to do with them.
 *
 * It is a port of the Vue front end's `src/utils/systemNotices.ts` and `src/utils/jobDeliveries.ts`,
 * kept behaviour for behaviour, including their tolerances: the shape is written by another program
 * and this side only reads it, so a missing element leaves its field empty rather than dropping the
 * job, and a delivery this build does not recognize answers `null` so the caller draws the text as
 * it always did.
 *
 * A transcript row draws one message in three steps, in this order:
 *
 * 1. `parseJobDelivery(text)` answers non-null: the whole message is one delivery, and it is drawn
 *    as a delivery card. This is asked first because a delivery is also a `<system-notice>` block,
 *    and the card states more than the frame around that block would.
 * 2. `splitSystemNotices(text)` finds wrapper blocks: each notice part is drawn as a notice card,
 *    and the text parts beside them as they always were.
 * 3. neither: the message is prose, drawn as it was before any of this existed.
 */

// Relative, with its extension: this module is read by the test runner as well as by the bundler.
import { codeSegments } from './code-ranges.ts'
import { parseIrcMessage, type ParsedIrcMessage } from './irc-message.ts'
import { stripToolCallMarkup } from './tool-call-markup.ts'

/**
 * The tags a model writes for itself.
 *
 * `important` marks a line it wants read as more than prose; `analysis` and `summary` are the
 * sections it names when it answers a "think, then write the summary" request — the pair a transcript
 * of this kind shows as a study of its own scratch work and the answer it produced. None of them is
 * engine vocabulary (a grep of `@oh-my-pi/**` finds no such element); they are the model shaping its
 * own text, read here because the same pass already owns "a harness tag at the start of a line".
 */
export const MODEL_TAGS = ['analysis', 'important', 'summary'] as const

export type ModelTag = (typeof MODEL_TAGS)[number]

/**
 * The envelope a model wraps its whole answer in, rather than a section of it.
 *
 * `final` is not engine vocabulary either — a grep of `@oh-my-pi/**` finds no such element — and the
 * model that writes it opens the envelope before its answer and closes it after the last line, or
 * writes the closer inline at the end of it (measured 2026-11-08, `me/deepseek-v4.1-flash`). It is
 * never read as a block: the message body already frames the answer, so a card would draw a second
 * frame around the whole bubble to say what the bubble says. Only `stripModelTags` reads it, and
 * only to take the tags off.
 */
const ANSWER_ENVELOPES = ['final'] as const

/** Every tag `stripModelTags` takes off: the blocks it also draws, and the answers it only unwraps. */
const STRIPPED_TAGS = [...MODEL_TAGS, ...ANSWER_ENVELOPES]

/**
 * Every wrapper this side draws as a block.
 *
 * `irc` is the odd one: the others are the engine talking to the reader, while this one is a peer
 * agent's message the engine relayed into the transcript. It is read by the same pass because it is
 * the same kind of thing — a harness tag around text — and drawn by its own card because its facts
 * are its own (who wrote it, whether it interrupted the turn, how to answer it).
 *
 * The model tags (`MODEL_TAGS`) are the same shape and not the engine's vocabulary: a block around
 * the model's own words rather than context around the message.
 */
export type SystemNoticeTag =
  | ModelTag
  | 'irc'
  | 'system-notice'
  | 'system-reminder'
  | 'system-notification'
  | 'system-injection'

/** A run of a job's closing sentence: the engine's prose, or the backticked code inside it. */
export type NoticeSpan = { kind: 'text'; text: string } | { kind: 'code'; text: string }

/** One job's result, as its element, its separator and the sentence beside it spell it. */
export interface ParsedJob {
  /** The job's id, as the headline, the separator or the element's `id` attribute names it. */
  id: string
  /** The agent type it ran as, when the element named one. */
  agent: string
  /** Its outcome in the engine's own word: `completed`, `failed`, `cancelled`, `aborted`, … . */
  status: string
  /** How long it ran, as the engine printed it (e.g. `12.7s`). */
  duration: string
  /** Why it was cut short, when the engine wrote a reason. */
  abortReason: string | null
  /** What it returned: its `<output>` or its `<preview>`, or the whole result when it wrote neither. */
  output: string
  /**
   * Where the untruncated result is, when the engine cut it short.
   *
   * A result over the engine's ceiling is written as `<preview full-output="agent://ID">` rather
   * than `<output>`: what the card can draw is the head of it, and this is the rest of it.
   */
  fullOutput: string | null
  /** How the job failed, when it ended with an `<error>` element instead of an output. */
  error: string | null
  /** The engine's own `<meta>` summary (lines and size), when it wrote one. */
  meta: string | null
  /** The sentences the engine put after the element: what the job became, and where its payload is. */
  note: string
  /** The note, split at the backticks the engine writes around a command or a path inside it. */
  noteSpans: readonly NoticeSpan[]
}

/** A whole delivery: what the engine said happened, and one entry per job. */
export interface ParsedJobDelivery {
  /** The engine's opening sentence(s): how many jobs finished and what to do with them. */
  summary: string
  jobs: readonly ParsedJob[]
}

/** One wrapper's own content, with the tags themselves taken off. */
export interface ParsedSystemNotice {
  tag: SystemNoticeTag
  /** The block's own content, tags removed. */
  text: string
  /** The delivery this block carries, or `null` when it is a notice of any other kind. */
  delivery: ParsedJobDelivery | null
  /** The peer message this block carries, or `null` when it is not an `irc` block. */
  irc: ParsedIrcMessage | null
}

/** A message's text, as prose and the blocks the engine wrapped inside it, in the order it wrote them. */
export type SystemNoticePart =
  | { kind: 'text'; text: string }
  | ({ kind: 'notice' } & ParsedSystemNotice)

/**
 * One wrapper, from its opening tag to the first matching closing tag.
 *
 * The opening tag has to begin a line: the engine writes a block at the start of what it injects,
 * while prose *about* one of them (``a `<system-notice>` block``) carries the tag mid-sentence and
 * stays prose. What follows the closing tag is not this pattern's business — the engine puts a
 * user's own words after a notice it wrapped — so the text around the block is read as text.
 *
 * Two readings worth stating, because neither is obvious. A tag that is never closed matches nothing
 * at all, so its text stays the text it was. And when an unclosed opening tag is followed by a
 * properly closed block of the same tag, the pattern reads from the *first* opening tag to that
 * closing one, so the unclosed tag ends up inside the block's own text. That is the Vue front end's
 * reading, and this port keeps it rather than inventing a second one.
 *
 * A third: the closing tag may be written more than once. A model that opens `<important>` and then
 * closes it twice (its own typo, seen in real output) meant one block, and the extra `</important>`
 * is not prose the reader should be shown — so trailing repeats of the same closing tag, whitespace
 * between them, are taken with the block.
 */
const NOTICE_BLOCK =
  /^[ \t]*<(analysis|important|summary|irc|system-notice|system-reminder|system-notification|system-injection)>([\s\S]*?)<\/\1>(?:[ \t\r\n]*<\/\1>)*/gm

/**
 * The text's parts, or one text part when it carries no block at all.
 *
 * Whitespace-only leftovers between and around blocks are dropped, and the text left over beside a
 * block is trimmed of the separator line breaks the engine put there — a caller draws those parts
 * side by side, where a blank line would read as an empty paragraph of the reader's own words. Text
 * at the very start of a message is the reader's own, so it only loses what trails into a block.
 *
 * One tolerance worth stating because it is not obvious: a block whose opening tag is never closed
 * is not a block, and if a later, properly closed block of the same tag follows it, the pattern
 * reads from the first opening tag to that closing one — the unclosed tag becomes part of the
 * block's own text. That is the Vue front end's reading, and this port keeps it.
 */
export function splitSystemNotices(text: string): readonly SystemNoticePart[] {
  const parts: SystemNoticePart[] = []
  let cursor = 0
  for (const match of text.matchAll(NOTICE_BLOCK)) {
    const at = match.index ?? 0
    const raw = text.slice(cursor, at)
    const before = parts.length === 0 ? raw.trimEnd() : raw.trim()
    if (before !== '') {
      parts.push({ kind: 'text', text: before })
    }
    parts.push(readNotice(match[1] as SystemNoticeTag, match[2].trim()))
    cursor = at + match[0].length
  }
  const tail = text.slice(cursor)
  // With no block found the whole text is one part, untouched: the caller's plain-text rendering
  // keeps the text it was given, byte for byte.
  const after = parts.length === 0 ? tail : tail.trim()
  if (after !== '') {
    parts.push({ kind: 'text', text: after })
  }
  return parts
}

/** Whether this text carries a wrapper block at all: the row's own test for drawing parts. */
export function hasSystemNotices(text: string): boolean {
  return splitSystemNotices(text).some(part => part.kind === 'notice')
}

/** One block, with the delivery and the peer message it may carry read as the block is read. */
function readNotice(tag: SystemNoticeTag, text: string): SystemNoticePart {
  // A delivery arrives inside the engine's own wrapper; a peer's message arrives inside `irc`; the
  // model's own blocks carry its words and nothing else.
  const engineWrapped = !isModelTag(tag) && tag !== 'irc'
  return {
    kind: 'notice',
    tag,
    text,
    delivery: engineWrapped ? parseJobDelivery(text) : null,
    irc: tag === 'irc' ? parseIrcMessage(text) : null,
  }
}

/** Whether this tag is one the model writes for itself rather than one the engine wrapped. */
export function isModelTag(tag: SystemNoticeTag): tag is ModelTag {
  return (MODEL_TAGS as readonly string[]).includes(tag)
}

/** The tags this side strips, as one alternation: `STRIPPED_TAGS` is the list, this is its spelling. */
const STRIPPED_TAG_PATTERN = `(?:${STRIPPED_TAGS.join('|')})`

/** A tag that had a line to itself takes that line's break with it, leaving no empty paragraph. */
const STRIPPED_TAG_LINE = new RegExp(`^[ \\t]*</?${STRIPPED_TAG_PATTERN}>[ \\t]*(?:\\r?\\n)?`, 'gm')

/** One inline tag with the blanks it stood between; what replaces it depends on its two neighbours. */
const STRIPPED_TAG_INLINE = new RegExp(`([ \\t]*)(</?${STRIPPED_TAG_PATTERN}>)([ \\t]*)`, 'g')

/**
 * This text with the model's tags taken out of its prose; code keeps what it quotes.
 *
 * Two vocabularies are stripped, in this order: a call the model wrote as markup
 * (`stripToolCallMarkup` — a call is drawn where calls are, never as its own brackets), then the
 * model's own tags. Every shape the tags arrive in is the same fact: the tag is markup.
 *
 * - An answer is drawn while it is still being written, and a callout cannot be drawn for half a
 *   block: the opener sits on the screen for seconds before its closer arrives.
 * - A model closes a tag twice, writes a closer with no opener, or writes one section's closer and
 *   the next section's opener with nothing between them (`</analysis>` then `<summary>`).
 * - A reader wraps a sentence of their own in the tag, inline rather than as a block
 *   (`important未用beui适配输出 <important> … </important>`). `NOTICE_BLOCK` needs a line of its own,
 *   so nothing reads that pair as a block, and without this the reader's own bubble shows brackets.
 * - A model wraps its whole answer in one (`ANSWER_ENVELOPES`): no block is read for it, so the
 *   opening and the closing are both punctuation around the words the bubble already frames.
 *
 * An inline tag joins its two sides with the space it stood in when both sides are words
 * (`inline <important>the point</important> of it`), and takes its blanks with it when they are not
 * — a tag at the end of a sentence or a line leaves no double space behind.
 *
 * Code is exempt: a span or a fence showing `<important>` is showing an example of the markup, and
 * an example is what it meant to show.
 */
export function stripModelTags(text: string): string {
  return codeSegments(stripToolCallMarkup(text))
    .map((segment, index) => {
      if (index % 2 === 1) return segment
      // A tag on a line of its own goes with that line, before the inline rule sees it: the line's
      // own break is the space it would otherwise join with.
      return segment
        .replace(STRIPPED_TAG_LINE, '')
        .replace(
          STRIPPED_TAG_INLINE,
          (match: string, _left: string, _tag: string, _right: string, offset: number, whole: string) => {
            const before = offset > 0 ? whole[offset - 1] : '\n'
            const after = whole[offset + match.length] ?? '\n'
            return /\S/.test(before) && /\S/.test(after) ? ' ' : ''
          },
        )
    })
    .join('')
}

/**
 * A message's prose: what the reader would write down if they copied it as words.
 *
 * The engine's wrappers are context around the message rather than the message — a reminder, a
 * delivery, a peer's message — so they are dropped, and a rail card or the composer's history reads
 * what was said. The model's own blocks are the opposite: their bodies *are* what was said, and the
 * tag is only how the model marked them, so their words stay and their brackets do not.
 */
export function messageProse(text: string): string {
  return splitSystemNotices(text)
    .filter(part => part.kind === 'text' || isModelTag(part.tag))
    .map(part => stripModelTags(part.text))
    .filter(part => part !== '')
    .join('\n\n')
}

/** The wrapper these deliveries are written inside; a single-job one may arrive without it. */
const NOTICE_PATTERN = /^<system-notice>\s*\n?([\s\S]*?)\s*\n?<\/system-notice>$/

/**
 * How every one of these deliveries opens, wrapper or not.
 *
 * The engine has two layouts — one job per `── Job <id> (<id>) ──` block, and a single job written
 * straight under the headline — and this is what they share. It is also what keeps the reading from
 * firing on prose that merely quotes a `<task-result>`: a message about one of these deliveries, a
 * transcript pasted into the conversation, is not one.
 */
const DELIVERY_OPENING = /^(?:Background jobs?\b|\d+ background jobs?\b)/i

/**
 * `── Job BackendScout (BackendScout) ──`, in either the box-drawing or the ASCII hyphen.
 *
 * The parenthesized label is the engine's own addition and only a `task` has one, so a batch of
 * background shells separates as `── Job bg_17 ──`, the dashes closing either form.
 */
const JOB_SEPARATOR = /^[─-]{2,}\s*Job\s+(\S+)(?:\s*\((.+?)\))?\s*[─-]{2,}$/u

/** `Background job bg_18 has completed. …`: the headline a single job with no element is named by. */
const PLAIN_JOB_HEADLINE = /^Background job\s+(\S+)\s+has completed\b/i

/** The job's own element, with the attributes this side reads. */
const TASK_RESULT_OPEN = /<task-result\b([^>]*)>/i
const TASK_RESULT_CLOSE = /<\/task-result>/i

/**
 * The attribute reader's pattern, kept at module scope because it is a `g` regex and reused: `exec`
 * on a `g` regex carries `lastIndex` between calls, so `readAttributes` resets it before it starts.
 */
const ATTRIBUTE = /([a-zA-Z][\w-]*)="([^"]*)"/g

const ABORT_REASON = /<abort-reason>([\s\S]*?)<\/abort-reason>/i
/** A result the engine cut short: the head of the payload, and where all of it lives. */
const PREVIEW = /<preview\b([^>]*)>([\s\S]*?)<\/preview>/i
/** A subagent that failed writes its failure here rather than an output. */
const ERROR = /<error>([\s\S]*?)<\/error>/i
/** A result the engine merged into another before it reached the parent. */
const MERGE_SUMMARY = /<merge-summary>([\s\S]*?)<\/merge-summary>/i
const META = /<meta\b([^>]*?)\/?>/i
const OUTPUT = /<output>([\s\S]*?)<\/output>/i
/** The one fenced block the note's `preview:` introduces; `replace` resets a global pattern's cursor, so sharing it is safe. */
const FENCE = /```[\s\S]*?```/g

/**
 * The delivery in this text, or `null` when it is not one.
 *
 * A text qualifies on its wrapper and on at least one job: a `<task-result>` element, a `── Job … ──`
 * separator, or — a single job written without an element, which is how a background shell comes
 * back — a headline that names it. A notice the engine wrote for something else — an aside, an
 * advisor card — keeps its own rendering rather than being forced into this one, and so does prose
 * that merely quotes a delivery.
 */
export function parseJobDelivery(text: string): ParsedJobDelivery | null {
  const trimmed = text.trim()
  const wrapped = NOTICE_PATTERN.exec(trimmed)
  const body = (wrapped === null ? trimmed : wrapped[1]).trim()
  if (!DELIVERY_OPENING.test(body)) {
    return null
  }
  const lines = body.split('\n')
  // A job with no element is named by the headline above its result, and that headline is the first
  // thing the engine writes — which is what keeps a message *quoting* a delivery (the headline sits
  // mid-sentence, or under the wrapper's own first line) out of this reading.
  const plainJobId = PLAIN_JOB_HEADLINE.exec(lines[0].trim())?.[1]
  if (
    plainJobId === undefined &&
    !/<task-result\b/i.test(body) &&
    !lines.some(line => JOB_SEPARATOR.test(line.trim()))
  ) {
    return null
  }
  const summary: string[] = []
  const blocks: Array<{ id: string; lines: string[] }> = []
  for (const line of lines) {
    const separator = JOB_SEPARATOR.exec(line.trim())
    if (separator !== null) {
      blocks.push({ id: separator[1], lines: [] })
      continue
    }
    if (blocks.length === 0) {
      // No separator has been seen yet: everything up to the first job is the headline, and the job
      // from there on — a delivery that names one job is written that way, with its element when it
      // has one and its own result when it does not.
      if (line.includes('<task-result')) {
        blocks.push({ id: '', lines: [] })
      } else if (plainJobId !== undefined && !PLAIN_JOB_HEADLINE.test(line)) {
        blocks.push({ id: plainJobId, lines: [] })
      } else {
        summary.push(line)
        continue
      }
    }
    blocks[blocks.length - 1].lines.push(line)
  }
  if (blocks.length === 0) {
    // Every delivery carries at least one job; a headline with nothing under it is a quotation.
    return null
  }
  return {
    summary: summary.join('\n').trim(),
    jobs: blocks.map(block => readJob(block.id, block.lines.join('\n'))),
  }
}

/** One job, from the element it carries and the sentences the engine put around it. */
function readJob(id: string, block: string): ParsedJob {
  const named = TASK_RESULT_OPEN.exec(block)
  if (named === null) {
    // A job the engine wrote without an element of its own — a background shell — carries nothing
    // but its result: no outcome, no duration, and the whole body is what it printed.
    return {
      id,
      agent: '',
      status: '',
      duration: '',
      abortReason: null,
      output: block.trim(),
      fullOutput: null,
      error: null,
      meta: null,
      note: '',
      noteSpans: [],
    }
  }
  const attributes = readAttributes(named[1])
  const element = block.replace(TASK_RESULT_OPEN, '').replace(TASK_RESULT_CLOSE, '')
  // What the engine says about the result, with everything this side draws for itself taken out:
  // the closing sentences about the transcript and the structured output, and nothing else. A fenced
  // block is dropped with the `preview:` that introduces it — an empty payload drawn as an empty
  // code card is what this reading exists to stop — while the `agent://` path in that same sentence
  // stays, because that is where the payload actually is.
  const note = element
    .replace(ABORT_REASON, '')
    .replace(META, '')
    .replace(OUTPUT, '')
    // A truncated result's preview and a failure's own sentence are drawn as fields; the merge
    // summary is a sentence about what happened to the result and stays in the note as words.
    .replace(PREVIEW, '')
    .replace(ERROR, '')
    .replace(MERGE_SUMMARY, (_element, inner: string) => inner)
    .replace(FENCE, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .join('\n')
    .replace(/preview:\s*$/, '')
    .trim()
  // A result the engine cut short carries a preview instead of an output: the head of the payload
  // in the element's body, and the whole of it in the element's own `full-output` attribute.
  const preview = PREVIEW.exec(element)
  return {
    id: attributes.id !== undefined && attributes.id !== '' ? attributes.id : id,
    agent: attributes.agent ?? '',
    status: attributes.status ?? '',
    duration: attributes.duration ?? '',
    abortReason: readElement(element, ABORT_REASON),
    output: readElement(element, OUTPUT) ?? preview?.[2].trim() ?? '',
    fullOutput: readAttributes(preview?.[1] ?? '')['full-output'] || null,
    error: readElement(element, ERROR),
    meta: readMeta(element),
    note,
    noteSpans: splitCodeSpans(note),
  }
}

/**
 * A sentence's backtick spans, read as code.
 *
 * The closing sentence is drawn as text, and nothing between the engine and this reading turns its
 * backticks into code spans, so the one piece of markup the engine uses inside it — the backticks
 * around `` `write agent://ContentEgret` `` — would otherwise arrive as literal backticks. Only
 * single-line spans are read: the parse strips fenced blocks before this sees them, so a backtick
 * that runs past the end of a line is not one of these.
 */
function splitCodeSpans(text: string): readonly NoticeSpan[] {
  if (text === '') {
    return []
  }
  const spans: NoticeSpan[] = []
  let cursor = 0
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const start = match.index ?? 0
    if (start > cursor) {
      spans.push({ kind: 'text', text: text.slice(cursor, start) })
    }
    spans.push({ kind: 'code', text: match[1] })
    cursor = start + match[0].length
  }
  if (cursor < text.length) {
    spans.push({ kind: 'text', text: text.slice(cursor) })
  }
  return spans
}

/** The inner text of one element, trimmed, or `null` when the element is not there or holds nothing. */
function readElement(text: string, pattern: RegExp): string | null {
  const inner = pattern.exec(text)?.[1]
  if (inner === undefined) {
    return null
  }
  const trimmed = inner.trim()
  return trimmed === '' ? null : trimmed
}

/** The `<meta>` element's own attributes, as one readable line: `lines=1 size=0B`. */
function readMeta(text: string): string | null {
  const attributes = readAttributes(META.exec(text)?.[1] ?? '')
  const parts = Object.entries(attributes).map(([key, value]) => `${key}=${value}`)
  return parts.length === 0 ? null : parts.join(' ')
}

/** The attributes of one element, empty when it has none. An absent one reads as `undefined`. */
function readAttributes(source: string): Record<string, string | undefined> {
  const found: Record<string, string | undefined> = {}
  ATTRIBUTE.lastIndex = 0
  let match = ATTRIBUTE.exec(source)
  while (match !== null) {
    found[match[1]] = match[2]
    match = ATTRIBUTE.exec(source)
  }
  return found
}
