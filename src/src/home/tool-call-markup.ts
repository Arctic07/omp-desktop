/**
 * A tool call the engine never parsed, read back out of the answer channel.
 *
 * The engine gives a model one way to call a tool, and the provider writes it as markup: DeepSeek's
 * `｜DSML｜` envelope, or the `<function_calls>` / `<invoke>` / `<parameter>` spelling other dialects
 * use. When the model writes that envelope wrong — the opener is missing, the delimiter is dropped,
 * a closer is duplicated — nothing parses it, and the fragment arrives as the step's *words*: the
 * transcript draws `<parameter name="i">…</parameter>` where an answer belongs, and the turn ends
 * with nothing said (2026-11-01, `me/deepseek-v4.1-flash`: four steps in one run, three of which the
 * engine recognized and answered with its own "the markup was malformed, re-issue the call" prompt).
 *
 * A model also writes the legacy spelling the dialect prompts forbid: the tool's name as the root
 * element and one child element per argument (`<Browser><action>screenshot</action></Browser>`),
 * which the engine does not parse at all (2026-11-04). That is the same fact as the fragment — a
 * call that never ran — and it is read here for the same reason: the markup is not an answer.
 *
 * What the engine's own repair leaves behind is the same fragment: it removes the delimited markup it
 * recognizes and the plain `<parameter>` text stays in the message it recorded. Both shapes are one
 * fact — the step's text is an envelope, not an answer — and this module reads only that fact. It
 * answers null for anything else, because a step that *writes about* the markup (a bug report, a
 * patch, a quoted example) is prose and its words are its answer.
 *
 * A third spelling is the same fact with the arguments on the opening tag: a model names the tool
 * and writes each argument as an attribute (`<ask i="…" questions="[…]">`), sometimes cut before its
 * `>`. The engine's healer reads that spelling only inside its own section wrapper, so a call that
 * lost the wrapper stays in the step's words — beside a prose answer, where no envelope reading can
 * claim the whole message (`stripToolCallMarkup`).
 */

// Relative, with its extension: this module is read by the test runner as well as by the bundler.
import { codeSegments, lineEndAt, startsLine } from './code-ranges.ts'

/** One call an envelope named, and the arguments it wrote as child elements. */
export interface StrayCall {
  /**
   * The tool the envelope named, when the fragment kept the opener that names one.
   *
   * Absent whenever the opening tags were the part the model lost, which is the common shape: what
   * survives is a `<parameter>` — the argument, without the call that carried it.
   */
  name: string | null
  /** The arguments the call wrote, keyed by the element that carried each. */
  args: Readonly<Record<string, string>>
}

/** What one step wrote instead of an answer: a tool-call envelope nothing executed. */
export interface StrayToolCall {
  /** The first named call's tool, when the fragment kept an opener that names one. */
  name: string | null
  /** The first named call's arguments. */
  args: Readonly<Record<string, string>>
  /** Every call the envelope named, in the order it wrote them. */
  calls: readonly StrayCall[]
  /** The fragment, verbatim: what the step wrote, kept so a note can say what was aimed at. */
  raw: string
}

/**
 * The element names a tool-call envelope is made of.
 *
 * `parameter` alone is enough with `invoke`: a fragment that lost its call still says, by its
 * argument element, that it is a call. The remaining names are the wrappers the dialects put around
 * it (`tool_calls`, `function_calls`, minimax's `tool_call`).
 */
const VOCABULARY: Record<string, true> = {
  tool_calls: true,
  tool_call: true,
  function_calls: true,
  invoke: true,
  parameter: true,
}

/** An element name with an optional dialect prefix: `parameter`, `antml:invoke`, `minimax:tool_call`. */
const NAME = /^(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)$/

/** One tag found in a step's text. */
interface Tag {
  /** The element name, without its dialect prefix. */
  name: string
  /** Whether the tag closes the element rather than opening it. */
  closing: boolean
  /** Whether the tag closes itself (`<invoke name="x"/>`). */
  selfClosing: boolean
  /** The whole `<…>` slice, which is all this reading needs of its attributes. */
  raw: string
  /** The opening tag's `name` attribute, when it carries one. */
  attribute: string | null
}

/**
 * DeepSeek's dialect delimiter, which sits between the angle bracket and the element name
 * (`<｜DSML｜parameter name="i">`). It is part of the spelling, not of the name.
 */
const DSML = /^[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*/i

/** The tag starting at `at`, or null when the text has no tag there. */
function tagAt(text: string, at: number): Tag | null {
  const end = text.indexOf('>', at + 1)
  if (end === -1) return null
  const raw = text.slice(at, end + 1)
  const body = raw.slice(1, -1).trim().replace(DSML, '')
  const closing = body.startsWith('/')
  const spelling = (closing ? body.slice(1) : body).trim().replace(DSML, '')
  // A closing tag has to be a name and nothing else; an opening one may carry attributes, and a tag
  // whose head is not a single word (`<3`, `<http://…>`) is not envelope markup at all.
  const head = closing ? spelling : (spelling.split(/\s/, 1)[0] ?? '')
  const match = NAME.exec(head)
  if (match === null) return null
  const attribute = /(?:^|\s)name\s*=\s*"([^"]*)"/.exec(spelling)?.[1] ?? null
  return { name: match[1]!, closing, selfClosing: !closing && raw.endsWith('/>'), raw, attribute }
}

/**
 * A tool-call envelope the engine did not execute, or null when this text is anything else.
 *
 * Three readings, in this order. The dialect spelling is the one the engine's own prompts teach
 * (`<invoke>` / `<parameter>`), and its fragments are read as they were before. The attribute
 * spelling puts the arguments on the opening tag (`<ask i="…" questions="[…]">`), and a fragment
 * cut before its end is claimed only when it has its line to itself. The legacy spelling is the
 * one a model falls back to when it writes a call as markup on its own (`<Browser>…</Browser>`
 * with one child element per argument); it is read whole-text and only when every top-level
 * element is a call, so a sentence beside one — or a tag shown inside a code fence — stays prose.
 */
export function readStrayToolCall(text: string): StrayToolCall | null {
  const source = text.trim()
  if (source === '' || !source.includes('<')) return null
  return (
    readDialectEnvelope(source) ??
    readAttributeEnvelope(source) ??
    readLegacyEnvelope(source)
  )
}

/**
 * The dialect spelling, read the way the fragments were read before: every non-space character
 * outside a parameter is a tag from the vocabulary, and a parameter's body is arbitrary text.
 */
function readDialectEnvelope(source: string): StrayToolCall | null {
  let cursor = 0
  const calls: StrayCall[] = []
  let current: { name: string | null; args: Record<string, string> } | null = null
  let parameterName: string | null = null
  let sawElement = false
  let inParameter = false
  while (cursor < source.length) {
    if (inParameter) {
      // An argument's body is arbitrary text, so only its own closer ends it. A closer that never
      // arrived is the fragment still being written: its body is what it has said so far.
      const close = source.indexOf('</parameter', cursor)
      if (close === -1) break
      const end = source.indexOf('>', close)
      if (end === -1) return null
      if (current !== null && parameterName !== null) {
        current.args[parameterName] = source.slice(cursor, close).trim()
      }
      cursor = end + 1
      inParameter = false
      parameterName = null
      continue
    }
    const at = source.indexOf('<', cursor)
    if (at === -1) {
      // Words outside any element are an answer, not a call.
      if (source.slice(cursor).trim() !== '') return null
      break
    }
    if (source.slice(cursor, at).trim() !== '') return null
    const tag = tagAt(source, at)
    if (tag === null || VOCABULARY[tag.name] !== true) return null
    if (!tag.closing) {
      sawElement = true
      if (tag.name === 'invoke') {
        current = { name: tag.attribute, args: {} }
        calls.push(current)
      } else if (tag.name === 'parameter') {
        if (current === null) {
          current = { name: null, args: {} }
          calls.push(current)
        }
        inParameter = true
        parameterName = tag.attribute
      }
    }
    cursor = at + tag.raw.length
  }
  if (!sawElement) return null
  const named = calls.find((call) => call.name !== null) ?? calls[0]
  return {
    name: named?.name ?? null,
    args: named?.args ?? {},
    calls,
    raw: source,
  }
}

/** The wrappers a legacy envelope may put around its calls. */
const LEGACY_WRAPPERS: Record<string, true> = {
  tool_calls: true,
  tool_call: true,
  function_calls: true,
}

/**
 * The element names a message uses as its own text, never as a call: the engine's wrappers, the
 * model's own sections, the reasoning envelopes read by `reasoning-echo.ts`, and the HTML elements a
 * message could quote whole. A legacy root from this list is prose — `<div><span>…</span></div>` is
 * a page, not a call.
 */
const NOT_A_CALL: Record<string, true> = {
  // Engine and dialect vocabulary.
  'tool_calls': true,
  'tool_call': true,
  'function_calls': true,
  'invoke': true,
  'parameter': true,
  'parameters': true,
  'tool_response': true,
  'function_results': true,
  'result': true,
  'error': true,
  'stdout': true,
  'stderr': true,
  'tool_name': true,
  'task-result': true,
  'meta': true,
  'output': true,
  'preview': true,
  'abort-reason': true,
  // Engine wrappers and the model's own blocks.
  'system-notice': true,
  'system-reminder': true,
  'system-notification': true,
  'system-injection': true,
  'irc': true,
  'important': true,
  'analysis': true,
  'summary': true,
  'thought': true,
  'thinking': true,
  'previous_reasoning': true,
  // HTML and SVG elements.
  'html': true,
  'head': true,
  'body': true,
  'div': true,
  'span': true,
  'p': true,
  'a': true,
  'b': true,
  'i': true,
  'u': true,
  's': true,
  'em': true,
  'strong': true,
  'code': true,
  'pre': true,
  'br': true,
  'hr': true,
  'ul': true,
  'ol': true,
  'li': true,
  'dl': true,
  'dt': true,
  'dd': true,
  'table': true,
  'thead': true,
  'tbody': true,
  'tr': true,
  'td': true,
  'th': true,
  'img': true,
  'svg': true,
  'path': true,
  'g': true,
  'circle': true,
  'rect': true,
  'line': true,
  'polygon': true,
  'polyline': true,
  'defs': true,
  'use': true,
  'symbol': true,
  'button': true,
  'input': true,
  'textarea': true,
  'select': true,
  'option': true,
  'form': true,
  'label': true,
  'h1': true,
  'h2': true,
  'h3': true,
  'h4': true,
  'h5': true,
  'h6': true,
  'blockquote': true,
  'script': true,
  'style': true,
  'template': true,
  'slot': true,
  'iframe': true,
  'video': true,
  'audio': true,
  'canvas': true,
  'details': true,
  'mark': true,
  'small': true,
  'sub': true,
  'sup': true,
  'kbd': true,
  'samp': true,
  'var': true,
  'abbr': true,
  'cite': true,
  'q': true,
  'time': true,
  'figure': true,
  'figcaption': true,
  'main': true,
  'section': true,
  'article': true,
  'header': true,
  'footer': true,
  'nav': true,
  'aside': true,
  'dialog': true,
  'picture': true,
  'source': true,
  'track': true,
  'map': true,
  'area': true,
  'base': true,
  'link': true,
  'title': true,
  'noscript': true,
}

/**
 * The legacy spelling: a root element named for the tool, one child element per argument, and
 * nothing outside the elements. Multiple calls may follow one another; a dialect wrapper may hold
 * them instead.
 */
function readLegacyEnvelope(source: string): StrayToolCall | null {
  const calls = readLegacyCalls(source)
  if (calls === null) return null
  return { name: calls[0]!.name, args: calls[0]!.args, calls, raw: source }
}

/** The calls a stretch of text holds, or null when it holds anything else. */
function readLegacyCalls(source: string): StrayCall[] | null {
  const calls: StrayCall[] = []
  let cursor = 0
  while (cursor < source.length) {
    while (cursor < source.length && /\s/.test(source[cursor]!)) cursor += 1
    if (cursor >= source.length) break
    if (source[cursor] !== '<') return null
    const tag = tagAt(source, cursor)
    if (tag === null || tag.closing) return null
    const name = tag.name
    if (tag.selfClosing) {
      if (NOT_A_CALL[name.toLowerCase()] === true) return null
      calls.push({ name, args: {} })
      cursor += tag.raw.length
      continue
    }
    const close = matchingClose(source, cursor + tag.raw.length, name)
    if (close === null) return null
    const body = source.slice(cursor + tag.raw.length, close.at)
    if (LEGACY_WRAPPERS[name] === true) {
      const inner = readLegacyCalls(body)
      if (inner === null) return null
      calls.push(...inner)
    } else {
      if (NOT_A_CALL[name.toLowerCase()] === true) return null
      const args = readCallArguments(body)
      if (args === null) return null
      calls.push({ name, args })
    }
    cursor = close.end
  }
  return calls.length > 0 ? calls : null
}

/** The arguments a call's body writes as child elements, or null when the body is anything else. */
function readCallArguments(body: string): Record<string, string> | null {
  const args: Record<string, string> = {}
  let cursor = 0
  while (cursor < body.length) {
    while (cursor < body.length && /\s/.test(body[cursor]!)) cursor += 1
    if (cursor >= body.length) break
    if (body[cursor] !== '<') return null
    const tag = tagAt(body, cursor)
    if (tag === null || tag.closing || tag.selfClosing) return null
    const close = matchingClose(body, cursor + tag.raw.length, tag.name)
    if (close === null) return null
    const inner = body.slice(cursor + tag.raw.length, close.at)
    if (tag.name === 'parameters') {
      const nested = readCallArguments(inner)
      if (nested === null) return null
      Object.assign(args, nested)
    } else {
      args[tag.attribute ?? tag.name] = inner.trim()
    }
    cursor = close.end
  }
  return Object.keys(args).length > 0 ? args : null
}

/** The matching closer of the element opened before `from`, or null when it never closes. */
function matchingClose(
  text: string,
  from: number,
  name: string,
): { at: number; end: number } | null {
  let depth = 0
  let cursor = from
  while (cursor < text.length) {
    const at = text.indexOf('<', cursor)
    if (at === -1) return null
    const tag = tagAt(text, at)
    if (tag === null) {
      cursor = at + 1
      continue
    }
    if (tag.name === name) {
      if (tag.closing) {
        if (depth === 0) return { at, end: at + tag.raw.length }
        depth -= 1
      } else if (!tag.selfClosing) {
        depth += 1
      }
    }
    cursor = at + tag.raw.length
  }
  return null
}

/* ------------------------------------------------- the spelling with attributes for arguments */

/**
 * One call written as a tag whose arguments are its attributes: `<ask i="…" questions="[…]">`.
 *
 * The argument value may be the JSON the tool takes, and a degraded model writes it with the same
 * quote character the attribute opened with (`questions="[{"id": "merge"}]"`). Its quotes are read
 * by the JSON shape rather than by the attribute's own delimiter; everything else reads as a plain
 * quoted string. A model that stops mid-write leaves the tag unclosed, and the line is where its
 * value stopped: the fragment ends there.
 */
interface AttributeCall {
  /** The element name, as written. */
  name: string
  /** The attributes it had written, in order; a value that was cut keeps what was there. */
  args: Record<string, string>
  /** Just past the opener's last character (`>` or `/>`), or `-1` when it never closed. */
  end: number
  /** Whether the opener closed itself (`<ask …/>`), so no body or closer follows. */
  selfClosing: boolean
}

/** An attribute name: `i`, `questions`, `old_string`. */
const ATTRIBUTE_NAME = /[A-Za-z_][\w.:-]*/y

/** The argument the engine adds to a call for its own tracing; a tag carrying it is a call. */
const INTENT_ARGUMENTS: Record<string, true> = { i: true, intent: true }

/**
 * The value of the attribute whose `=` ends before `at`.
 *
 * A quoted value ends at its own quote, except for a JSON body: `{`/`[` is read to its matching
 * bracket first — across lines too, a pretty-printed argument is still one value — so the quotes
 * *inside* it do not end the attribute early (exactly what a model reusing its quote character
 * produces). `end` is `-1` when the value was cut: what it has written runs to the end of its line,
 * and the tag is unfinished.
 */
function attributeValue(text: string, at: number): { value: string; end: number } | null {
  const quote = text[at]
  if (quote !== '"' && quote !== "'") {
    const bare = /[^\s>]*/y
    bare.lastIndex = at
    const match = bare.exec(text)
    if (match === null || match[0].length === 0) return null
    return { value: match[0], end: at + match[0].length }
  }
  const line = lineEndAt(text, at)
  const body = at + 1
  if (text[body] === '{' || text[body] === '[') {
    const balanced = jsonEnd(text, body, text.length)
    if (balanced !== -1) {
      // The model's own quote may close the attribute after the value, or it may have reused that
      // character inside the JSON and left the attribute unclosed.
      const closes = text[balanced] === quote
      return { value: text.slice(body, balanced), end: closes ? balanced + 1 : balanced }
    }
    return { value: text.slice(body, line), end: -1 }
  }
  const closing = text.indexOf(quote, body)
  if (closing === -1 || closing >= line) return { value: text.slice(body, line), end: -1 }
  return { value: text.slice(body, closing), end: closing + 1 }
}

/**
 * Just past the bracket that closes the one opened before `from`, or -1 when the value is cut.
 *
 * Only the bracket shape is read: a JSON string's own quotes are skipped, so a comma, a bracket, or
 * a quote inside one does not move the depth. A bracket left open at `limit` is the write stopping.
 */
function jsonEnd(text: string, from: number, limit: number): number {
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (let at = from; at < limit; at += 1) {
    const char = text[at]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{' || char === '[') stack.push(char)
    else if (char === '}' || char === ']') {
      stack.pop()
      if (stack.length === 0) return at + 1
    }
  }
  return -1
}

/** The attribute spelling's opener starting at `at`, or null when the text has no tag there. */
function attributeCallAt(text: string, at: number): AttributeCall | null {
  if (text[at] !== '<') return null
  // A closing tag opens nothing, and `<http://…>`'s head is not a name.
  const head = /([A-Za-z_][\w.-]*)/y
  head.lastIndex = at + 1
  const name = head.exec(text)?.[1]
  if (name === undefined) return null
  let cursor = at + 1 + name.length
  // A name followed by anything but a blank is not this spelling: the arguments are attributes.
  if (!/\s/.test(text[cursor] ?? '')) return null
  const args: Record<string, string> = {}
  while (cursor < text.length) {
    while (/\s/.test(text[cursor] ?? '')) cursor += 1
    if (text[cursor] === '>') return { name, args, end: cursor + 1, selfClosing: false }
    if (text[cursor] === '/' && text[cursor + 1] === '>') {
      return { name, args, end: cursor + 2, selfClosing: true }
    }
    ATTRIBUTE_NAME.lastIndex = cursor
    const attribute = ATTRIBUTE_NAME.exec(text)?.[0]
    if (attribute === undefined) return null
    cursor += attribute.length
    const afterName = cursor
    while (/\s/.test(text[cursor] ?? '')) cursor += 1
    if (text[cursor] !== '=') {
      // A bare attribute (`disabled`) states nothing a call needs; it is still part of the tag.
      args[attribute] = ''
      cursor = afterName
      continue
    }
    cursor += 1
    while (/\s/.test(text[cursor] ?? '')) cursor += 1
    const read = attributeValue(text, cursor)
    if (read === null) return null
    args[attribute] = read.value
    // The model stopped inside this value: the tag has no `>` and the text has no more tag in it.
    if (read.end < 0) return { name, args, end: -1, selfClosing: false }
    cursor = read.end
  }
  // The opener is cut before its `>`: the fragment is still being written, and it is a call.
  return { name, args, end: -1, selfClosing: false }
}

/** Whether this tag is a call rather than an element a message could write as its own text. */
function isAttributeCall(call: AttributeCall): boolean {
  if (NOT_A_CALL[call.name.toLowerCase()] === true) return false
  const values = Object.entries(call.args).filter(([, value]) => value !== '')
  if (values.length === 0) return false
  // The intent is the field the engine traces a call by; a JSON value is an argument a sentence
  // does not carry as an attribute. One of the two is what a call written this way always has.
  return values.some(
    ([key, value]) =>
      INTENT_ARGUMENTS[key] === true || value.trimStart().startsWith('[') || value.trimStart().startsWith('{'),
  )
}

/**
 * The whole text when it is one call in the attribute spelling, or null when it is anything else.
 *
 * The spellings are read in the order the recordings needed them: a call whose arguments are on the
 * tag is the one a degraded model writes when it drops its section wrapper, and it is the shape that
 * reached a reader's bubble verbatim (2026-11-09).
 */
function readAttributeEnvelope(source: string): StrayToolCall | null {
  const call = attributeCallAt(source, 0)
  if (call === null || !isAttributeCall(call)) return null
  let end = call.end
  if (end < 0) {
    // The write stopped inside an argument, so the fragment owns its line and nothing after it.
    // A message that carries an answer under that line is prose plus a fragment, not a call.
    end = lineEndAt(source, 0)
    if (source.slice(end).trim() !== '') return null
  } else if (!call.selfClosing) {
    const closer = closerAt(source, end, call.name)
    // A body of child elements is the legacy spelling, whose arguments those elements are; this
    // reading carries every argument on the opener and nothing between it and its closer.
    if (closer === null) return null
    if (source.slice(end, closer.at).trim() !== '') return null
    end = closer.end
  }
  // Words outside the element are an answer that mentions a call, not the call.
  if (source.slice(end).trim() !== '') return null
  const named = { name: call.name, args: call.args }
  return { name: named.name, args: named.args, calls: [named], raw: source }
}

/**
 * The closer that ends this element, or `null` when it never closes.
 *
 * The name is matched whole: `</askers>` does not close `<ask>`, the same exactness `matchingClose`
 * keeps for the two-element spelling.
 */
function closerAt(text: string, from: number, name: string): { at: number; end: number } | null {
  const wanted = name.toLowerCase()
  let cursor = from
  while (cursor < text.length) {
    const at = text.indexOf('</', cursor)
    if (at === -1) return null
    const tag = tagAt(text, at)
    if (tag !== null && tag.closing && tag.name.toLowerCase() === wanted) {
      return { at, end: at + tag.raw.length }
    }
    cursor = at + 2
  }
  return null
}

/**
 * This text with a call a model wrote as markup taken out, leaving the prose around it.
 *
 * The engine strips the call markup it recognizes before a message is committed, but a call the
 * model appended to its own answer — often cut before the closing `>` — survives in the step's
 * words, and the transcript drew the whole tag as prose over an answer that had actually been
 * delivered (2026-11-09: a finished answer followed by `<ask i="…" questions="[…"` and then the
 * ask dialog, the call having been re-issued properly). The markup is not one of the words: the
 * call it stands for is already drawn where calls are — the tool row the engine ran, or the card a
 * stray fragment gets — and code keeps whatever it quotes.
 *
 * A fragment runs from its opener to its closer when it has one, to its own `/>` when it closes
 * itself, and otherwise to the end of its line (the attribute spelling, whose arguments end with
 * the tag) or of its paragraph (the element spellings, whose body runs on). An element spelling is
 * read from a complete opening tag: an opener cut before its `>` carries no argument to read and
 * stays prose. A call that never said where it ends is only claimed at the head of a line, and
 * mid-sentence those bytes are a sentence about the markup.
 */
export function stripToolCallMarkup(text: string): string {
  if (!text.includes('<')) return text
  return codeSegments(text)
    .map((segment, index) => (index % 2 === 1 ? segment : stripCallFragments(segment)))
    .join('')
}

/** One stretch of prose with every call fragment in it taken out. */
function stripCallFragments(text: string): string {
  const cuts: Array<readonly [number, number]> = []
  let cursor = 0
  while (cursor < text.length) {
    const at = text.indexOf('<', cursor)
    if (at === -1) break
    const cut = callRange(text, at)
    if (cut === null) {
      cursor = at + 1
      continue
    }
    cuts.push(cut)
    cursor = cut[1]
  }
  if (cuts.length === 0) return text
  let out = ''
  let last = 0
  for (const [start, end] of cuts) {
    out += text.slice(last, start)
    const before = out.at(-1)
    const after = text[end]
    // The two sides read as one sentence when both are words: a call written mid-line takes the
    // space the tag stood between, and a call on its own line takes the break.
    if (before !== undefined && after !== undefined && /\S/.test(before) && /\S/.test(after)) {
      out += ' '
    }
    last = end
  }
  return out + text.slice(last)
}

/**
 * The fragment the call opens at `at`, or null when the tag there is not one.
 *
 * Three spellings are read, and each is claimed only where the recordings show it: an attribute
 * call anywhere once it says where it ends, an attribute call that was cut only at the head of its
 * line, and an element spelling only at the head of its line.
 */
function callRange(text: string, at: number): readonly [number, number] | null {
  const attribute = attributeCallAt(text, at)
  if (attribute !== null && isAttributeCall(attribute)) {
    if (attribute.selfClosing) {
      return fragmentRange(text, at, attribute.name, attribute.end, attribute.selfClosing, 'line')
    }
    const closer = attribute.end < 0 ? null : closerAt(text, attribute.end, attribute.name)
    if (closer === null && !startsLine(text, at)) return null
    return fragmentRange(text, at, attribute.name, attribute.end, attribute.selfClosing, 'line')
  }
  return vocabularyRange(text, at)
}

/**
 * The names that spell a call in the dialect vocabulary rather than an element of a page: the
 * wrappers a model writes around a call, and the argument and call elements inside it.
 */
const CALL_VOCABULARY: Record<string, true> = {
  tool_calls: true,
  tool_call: true,
  function_calls: true,
  invoke: true,
  parameter: true,
  parameters: true,
  // The spelling a model fell back to when it lost the wrapper's name (2026-11-04).
  tool_invoke: true,
}

/**
 * A fragment of the dialect or legacy element spelling, cut only when its tag starts its line.
 *
 * That is the same rule `reasoning-echo` reads envelopes by: a model appends the call it forgot to
 * emit at the head of a line, while a message *mentioning* the markup writes it mid-sentence. A
 * legacy root (any element that is not a page element) also counts, but only when its body is the
 * argument elements a call carries — a block of prose with a closing tag is not one.
 */
function vocabularyRange(text: string, at: number): readonly [number, number] | null {
  const tag = tagAt(text, at)
  if (tag === null || tag.closing) return null
  if (!startsLine(text, at)) return null
  const closedAt = at + tag.raw.length
  if (CALL_VOCABULARY[tag.name] !== true) {
    if (NOT_A_CALL[tag.name.toLowerCase()] === true || tag.selfClosing) return null
    const closer = closerAt(text, closedAt, tag.name)
    if (closer === null) return null
    // An unknown root is only a call when its arguments carry the intent: a prose element that
    // happens to hold child elements (`<example><details>…</details></example>`) carries none.
    const args = readCallArguments(text.slice(closedAt, closer.at))
    if (args === null || (args.i === undefined && args.intent === undefined)) return null
  }
  return fragmentRange(text, at, tag.name, closedAt, tag.selfClosing, 'paragraph')
}

/** Where the fragment that opens at `at` ends, with the blanks that belong to it. */
function fragmentRange(
  text: string,
  at: number,
  name: string,
  closedAt: number,
  selfClosing: boolean,
  fallback: 'line' | 'paragraph',
): readonly [number, number] {
  // A tag alone on its line goes with that line: the break it stood on is not a blank to keep. A
  // tag between words takes the spaces it stood between, so the two sides join once.
  const aloneOnLine = startsLine(text, at)
  const lineStart = text.lastIndexOf('\n', at - 1) + 1
  let start = at
  if (aloneOnLine) start = lineStart
  else while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) start -= 1
  let end = closedAt
  if (!selfClosing) {
    const closer = closedAt < 0 ? null : closerAt(text, closedAt, name)
    if (closer !== null) end = closer.end
    else if (closedAt < 0) end = fallback === 'line' ? lineEndAt(text, at) : text.length
    else if (fallback === 'line') end = lineEndAt(text, closedAt)
    else {
      // The element spelling with an opener and no closer: the dangling call runs to the paragraph
      // break, which it takes with it — the break is what separated it from the prose.
      const blank = /\n[ \t]*\r?\n/g
      blank.lastIndex = closedAt
      const match = blank.exec(text)
      end = match === null ? text.length : match.index + match[0].length
    }
  }
  const lineEnd = text.indexOf('\n', end)
  const rest = lineEnd === -1 ? text.slice(end) : text.slice(end, lineEnd)
  if (rest.trim() === '') {
    if (aloneOnLine) end = lineEnd === -1 ? text.length : lineEnd + 1
  } else while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end += 1
  return [start, end]
}
