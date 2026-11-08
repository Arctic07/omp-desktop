/** Markdown subset parser for the assistant transcript, ported from the Vue front end's
 *  `src/utils/markdown.ts` (same rules, same exported names, same memo).
 *
 *  Pure and dependency-free: the same text always yields the same tree, so streaming can re-parse the
 *  whole buffer on every delta without flip-flopping the blocks that already rendered. Raw HTML never
 *  becomes an element: it stays a `text` node, as in the reference renderer. */

export type MarkdownInline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: MarkdownInline[] }
  | { kind: 'emphasis'; children: MarkdownInline[] }
  | { kind: 'delete'; children: MarkdownInline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; children: MarkdownInline[] }

export type MarkdownBlock =
  | { kind: 'paragraph'; children: MarkdownInline[] }
  | { kind: 'heading'; depth: 1 | 2 | 3 | 4 | 5 | 6; children: MarkdownInline[] }
  | { kind: 'code'; language: string; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: MarkdownBlock[][] }
  | { kind: 'quote'; blocks: MarkdownBlock[] }
  | { kind: 'rule' }
  | { kind: 'table'; header: MarkdownInline[][]; rows: MarkdownInline[][][]; align: ('start' | 'center' | 'end')[] }

const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/
const INLINE_MARKER = /[\\`*_~[<]/g
const AUTOLINK = /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>]*$/
const WORD = /[\p{L}\p{N}]/u
const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*(.*)$/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/
const THEMATIC = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/
const QUOTE = /^ {0,3}>[ \t]?(.*)$/
const LIST_ITEM = /^( {0,3})([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/
const LIST_MARKER_AT_START = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]/
const ALIGNMENT_CELL = /^:?-+:?$/
const HEADING_DEPTHS = [1, 2, 3, 4, 5, 6] as const
/** Clickable destination protocols. A colon cannot appear in an `Object.prototype` name, so this lookup cannot hit an inherited key. */
const LINK_PROTOCOLS: Readonly<Record<string, true>> = { 'http:': true, 'https:': true, 'mailto:': true }

/** Protocol allowlist: a relative, fragment or script URL yields '' and renders as plain text. */
export function sanitizeHref(url: string): string {
  try {
    return LINK_PROTOCOLS[new URL(url).protocol] === true ? url : ''
  } catch {
    return ''
  }
}

/** Parse options. */
export interface MarkdownParseOptions {
  /** Whether the result may be kept for the next caller; defaults to true. The one caller that passes
   *  false is the still-growing tail of a streaming answer — see the cache below. */
  retain?: boolean
}

/** Parse memo, keyed by the newline-normalised source text.
 *
 *  The transcript feed is virtualised: sliding the window unmounts a row and rebuilds it later, and
 *  every rebuild re-parses the same answer — a millisecond or more of main-thread time per long row
 *  of real prose, several at the tail — once per remount. The key is exactly the string the parser
 *  consumes, so a hit and a miss are indistinguishable to the caller: same key means same parser input
 *  means the same tree, byte for byte. `\r\n` and `\r` therefore share an entry with `\n`, which is
 *  what the normalisation inside the parser already guarantees.
 *
 *  The cache is bounded on both axes. Sixty-four entries cover the virtual window's overscan with
 *  room to spare, and a source past 256 K characters is parsed but refused, so a single pathological
 *  paste cannot pin the whole capacity. A hit re-inserts its entry, which makes the Map's insertion
 *  order a recency order and the entry dropped at capacity the least recently used one.
 *
 *  Text that is still being written is parsed but never kept (`retain: false`). Every delta of a
 *  streaming answer is a fresh key that will not be asked for again, so retaining them would only
 *  evict the settled rows — and the settled rows are exactly what repeated scrolling has to hit. A
 *  retention flag is not part of the key on purpose: it says who may store the tree, never what the
 *  tree is, so a reader that is not streaming and a writer that is still streaming share one entry
 *  instead of growing the cache with a second copy of the same text.
 *
 *  Sharing one tree between callers is safe because the tree is only ever read: `Markdown` walks it
 *  while rendering and nothing mutates a block, an inline node or a children array. */
const MARKDOWN_CACHE_CAPACITY = 64
const MARKDOWN_CACHE_MAX_LENGTH = 256 * 1024
const markdownCache = new Map<string, MarkdownBlock[]>()

export function parseMarkdown(text: string, options?: MarkdownParseOptions): MarkdownBlock[] {
  const source = text.replace(/\r\n?/g, '\n')
  const cached = markdownCache.get(source)
  if (cached !== undefined) {
    markdownCache.delete(source)
    markdownCache.set(source, cached)
    return cached
  }

  const blocks = parseBlocks(source.split('\n'))
  if (options?.retain !== false && source.length <= MARKDOWN_CACHE_MAX_LENGTH) {
    if (markdownCache.size >= MARKDOWN_CACHE_CAPACITY) {
      const oldest = markdownCache.keys().next().value
      if (oldest !== undefined) {
        markdownCache.delete(oldest)
      }
    }
    markdownCache.set(source, blocks)
  }
  return blocks
}

export function parseInline(text: string): MarkdownInline[] {
  const nodes: MarkdownInline[] = []
  let plain = ''
  let index = 0
  const flush = (): void => {
    pushText(nodes, plain)
    plain = ''
  }
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') {
      const escapable = ESCAPABLE.test(text[index + 1] ?? '')
      plain += escapable ? text[index + 1] : '\\'
      index += escapable ? 2 : 1
      continue
    }
    if (char === '`') {
      const run = runLength(text, index, '`')
      const close = findBacktickRun(text, index + run, run)
      if (close === -1) {
        plain += '`'.repeat(run)
        index += run
        continue
      }
      flush()
      nodes.push({ kind: 'code', text: codeText(text.slice(index + run, close)) })
      index = close + run
      continue
    }
    if (char === '*' || char === '_' || char === '~') {
      const run = runLength(text, index, char)
      const width = char === '~' ? (run >= 2 ? 2 : 0) : run >= 3 ? 3 : run
      const wordBoundary = char === '_'
      const opens = width > 0 && !isBlank(text[index + run] ?? ' ') && (!wordBoundary || !WORD.test(text[index - 1] ?? ''))
      const close = opens ? findClosing(text, index + run, char, width, wordBoundary) : -1
      if (close === -1) {
        plain += char.repeat(run)
        index += run
        continue
      }
      flush()
      const inner = parseInline(text.slice(index + run, close))
      // A run of three opens bold-italic, and the inner emphasis closes first, as CommonMark does.
      if (char === '~') nodes.push({ kind: 'delete', children: inner })
      else if (width === 3) nodes.push({ kind: 'emphasis', children: [{ kind: 'strong', children: inner }] })
      else if (width === 2) nodes.push({ kind: 'strong', children: inner })
      else nodes.push({ kind: 'emphasis', children: inner })
      index = close + width
      continue
    }
    if (char === '[') {
      const labelEnd = findLabelEnd(text, index + 1)
      const destination = labelEnd === -1 ? null : linkDestination(text, labelEnd + 1)
      if (destination !== null) {
        flush()
        nodes.push({ kind: 'link', href: destination.href, children: parseInline(text.slice(index + 1, labelEnd)) })
        index = destination.end
        continue
      }
      plain += '['
      index += 1
      continue
    }
    if (char === '<') {
      const end = text.indexOf('>', index + 1)
      const value = end === -1 ? '' : text.slice(index + 1, end)
      if (AUTOLINK.test(value)) {
        flush()
        nodes.push({ kind: 'link', href: value, children: [{ kind: 'text', text: value }] })
        index = end + 1
        continue
      }
      plain += '<'
      index += 1
      continue
    }
    // Plain text: skip to the next marker instead of copying character by character.
    INLINE_MARKER.lastIndex = index
    const stop = INLINE_MARKER.exec(text)?.index ?? text.length
    plain += text.slice(index, stop)
    index = stop
  }
  flush()
  return nodes
}

interface BlockResult { block: MarkdownBlock; next: number }

function parseBlocks(lines: readonly string[]): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  let index = 0
  while (index < lines.length) {
    const result = isBlank(lines[index]) ? null : blockAt(lines, index)
    if (result === null) {
      index += 1
      continue
    }
    blocks.push(result.block)
    index = result.next
  }
  return blocks
}

/** Block that starts at `index`, or null when the line is plain paragraph text. */
function blockAt(lines: readonly string[], index: number): BlockResult | null {
  const line = lines[index]
  const fence = FENCE.exec(line)
  if (fence !== null) return parseFence(lines, index, fence)
  const heading = HEADING.exec(line)
  if (heading !== null) {
    const children = parseInline(heading[2] ?? '')
    return { block: { kind: 'heading', depth: HEADING_DEPTHS[heading[1].length - 1], children }, next: index + 1 }
  }
  if (THEMATIC.test(line)) return { block: { kind: 'rule' }, next: index + 1 }
  if (QUOTE.test(line)) return parseQuote(lines, index)
  const item = listEntry(line)
  if (item !== null) return parseList(lines, index, item)
  return parseTable(lines, index) ?? parseParagraph(lines, index)
}

/** Fenced code; an unterminated fence runs to the end, which the streaming tail grows into. */
function parseFence(lines: readonly string[], start: number, match: RegExpExecArray): BlockResult {
  const marker = match[2]
  const text: string[] = []
  let index = start + 1
  while (index < lines.length) {
    const body = lines[index].trimStart()
    const run = runLength(body, 0, marker[0])
    const closes = lines[index].length - body.length <= 3 && run >= marker.length && body.slice(run).trim() === ''
    if (closes) {
      index += 1
      break
    }
    text.push(lines[index])
    index += 1
  }
  const language = (match[3] ?? '').trim().split(/\s+/)[0] ?? ''
  return { block: { kind: 'code', language, text: text.join('\n') }, next: index }
}

/** One level of `>` nesting is stripped here; deeper nesting falls out of the recursion. */
function parseQuote(lines: readonly string[], start: number): BlockResult {
  const inner: string[] = []
  let index = start
  while (index < lines.length) {
    const match = QUOTE.exec(lines[index])
    if (match === null) break
    inner.push(match[1] ?? '')
    index += 1
  }
  return { block: { kind: 'quote', blocks: parseBlocks(inner) }, next: index }
}

interface ListEntry {
  ordered: boolean
  /** Bullet character, or `.` / `)` for an ordered list: a change starts a new list. */
  marker: string
  number: number
  indent: number
  /** Column where the item's own content starts, used to de-indent continuation lines. */
  contentIndent: number
  text: string
}

function listEntry(line: string): ListEntry | null {
  const match = LIST_ITEM.exec(line)
  if (match === null) return null
  const raw = match[2]
  const ordered = raw !== '-' && raw !== '+' && raw !== '*'
  const spaces = match[3].length
  const gap = Math.min(spaces, 4)
  return {
    ordered,
    marker: ordered ? raw[raw.length - 1] : raw,
    number: ordered ? Number.parseInt(raw, 10) : 1,
    indent: match[1].length,
    contentIndent: match[1].length + raw.length + gap,
    text: ' '.repeat(spaces - gap) + match[4],
  }
}

/** Items of matching marker kind and indent; an item's content is de-indented and parsed as its own block list, so nesting recurses. */
function parseList(lines: readonly string[], start: number, first: ListEntry): BlockResult {
  const items: MarkdownBlock[][] = []
  let index = start
  while (index < lines.length) {
    const entry = listEntry(lines[index])
    if (entry === null) break
    if (entry.ordered !== first.ordered || entry.marker !== first.marker || entry.indent !== first.indent) break
    const content = [entry.text]
    let cursor = index + 1
    while (cursor < lines.length) {
      const line = lines[cursor]
      const previous = content[content.length - 1]
      if (isBlank(line)) content.push('')
      else if (line.length - line.trimStart().length >= entry.contentIndent) content.push(line.slice(entry.contentIndent))
      // Lazy continuation: an unindented plain line keeps the open paragraph inside the item.
      else if (!isBlank(previous) && !LIST_MARKER_AT_START.test(previous) && !startsBlock(lines, cursor)) {
        content.push(line)
      } else break
      cursor += 1
    }
    while (content.length > 0 && isBlank(content[content.length - 1])) content.pop()
    items.push(parseBlocks(content))
    index = cursor
  }
  return { block: { kind: 'list', ordered: first.ordered, start: first.number, items }, next: index }
}

/** Pipe table: header row plus a same-width delimiter row; body rows are cut to the header width. */
function parseTable(lines: readonly string[], start: number): BlockResult | null {
  if (!lines[start].includes('|') || start + 1 >= lines.length) return null
  const align = parseAlignments(lines[start + 1])
  if (align === null) return null
  const header = splitCells(lines[start])
  if (header.length !== align.length) return null
  const rows: MarkdownInline[][][] = []
  let index = start + 2
  while (index < lines.length && lines[index].includes('|') && !startsBlock(lines, index)) {
    const cells = splitCells(lines[index]).slice(0, align.length)
    while (cells.length < align.length) cells.push('')
    rows.push(cells.map(parseInline))
    index += 1
  }
  return { block: { kind: 'table', header: header.map(parseInline), rows, align }, next: index }
}

function parseAlignments(line: string): ('start' | 'center' | 'end')[] | null {
  if (!line.includes('|')) return null
  const cells = splitCells(line)
  if (cells.length === 0 || !cells.every((cell) => ALIGNMENT_CELL.test(cell))) return null
  return cells.map((cell) => (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'end' : 'start'))
}

/** Cells of a pipe table row. `\|` stays escaped so inline parsing turns it back into a pipe. */
function splitCells(line: string): string[] {
  let value = line.trim()
  if (value.startsWith('|')) value = value.slice(1)
  if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1)
  return value.split(/(?<!\\)\|/).map((cell) => cell.trim())
}

/** Cut by the next blank line or block start. Trailing spaces — the source's hard-break marker — are
 *  dropped: the transcript renders soft and hard breaks alike as one newline inside the text. */
function parseParagraph(lines: readonly string[], start: number): BlockResult {
  const text: string[] = []
  let index = start
  while (index < lines.length && !isBlank(lines[index]) && (index === start || !startsBlock(lines, index))) {
    text.push(lines[index].replace(/[ \t]+$/, ''))
    index += 1
  }
  return { block: { kind: 'paragraph', children: parseInline(text.join('\n')) }, next: index }
}

function startsBlock(lines: readonly string[], index: number): boolean {
  const line = lines[index]
  if (FENCE.test(line) || HEADING.test(line) || THEMATIC.test(line) || QUOTE.test(line)) return true
  if (listEntry(line) !== null) return true
  return index + 1 < lines.length && line.includes('|') && parseAlignments(lines[index + 1]) !== null
}

function findBacktickRun(text: string, from: number, length: number): number {
  let index = from
  while (index < text.length) {
    const run = runLength(text, index, '`')
    if (run === length) return index
    index += run > 0 ? run : 1
  }
  return -1
}

/** Start index of the closing run of a marker opened before `from`, or -1 while it is still unclosed
 *  (an unterminated marker stays literal). A longer run is consumed from its tail, so `**a *b***` closes the inner emphasis first. */
function findClosing(text: string, from: number, char: string, length: number, wordBoundary: boolean): number {
  let index = from
  while (index < text.length) {
    const run = runLength(text, index, char)
    const start = index + run - length
    const closes = start > from && !isBlank(text[start - 1]) && (!wordBoundary || !WORD.test(text[start + length] ?? ''))
    if (run >= length && closes) return start
    index += run > 0 ? run : 1
  }
  return -1
}

/** Index of the `]` closing a link label; `[` nesting is counted and escapes are skipped. */
function findLabelEnd(text: string, from: number): number {
  let depth = 0
  let index = from
  while (index < text.length) {
    const char = text[index]
    if (char === ']' && depth === 0) return index
    depth += char === '[' ? 1 : char === ']' ? -1 : 0
    index += char === '\\' ? 2 : 1
  }
  return -1
}

/** Destination of `[label](destination)`, or null while missing or empty. A trailing title is dropped. */
function linkDestination(text: string, start: number): { href: string; end: number } | null {
  if (text[start] !== '(') return null
  let raw = ''
  let depth = 0
  let index = start + 1
  while (index < text.length) {
    const char = text[index]
    const escaped = char === '\\' && index + 1 < text.length
    if (char === ')' && depth === 0) {
      const first = raw.trim().split(/\s+/)[0] ?? ''
      const href = first.startsWith('<') && first.endsWith('>') ? first.slice(1, -1) : first
      return href === '' ? null : { href, end: index + 1 }
    }
    depth += char === '(' ? 1 : char === ')' ? -1 : 0
    raw += escaped ? text[index + 1] : char
    index += escaped ? 2 : 1
  }
  return null
}

/** Inline code collapses to one line and loses one surrounding space; everything else stays verbatim. */
function codeText(raw: string): string {
  const value = raw.replace(/\n/g, ' ')
  const padded = value.length > 1 && value.startsWith(' ') && value.endsWith(' ') && value.trim() !== ''
  return padded ? value.slice(1, -1) : value
}

function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim() === ''
}

function runLength(text: string, start: number, char: string): number {
  let end = start
  while (end < text.length && text[end] === char) end += 1
  return end - start
}

function pushText(nodes: MarkdownInline[], text: string): void {
  if (text === '') return
  const last = nodes[nodes.length - 1]
  if (last !== undefined && last.kind === 'text') {
    last.text += text
    return
  }
  nodes.push({ kind: 'text', text })
}
