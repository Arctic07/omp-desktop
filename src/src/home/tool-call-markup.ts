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
 */

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
 * Two readings, in this order. The dialect spelling is the one the engine's own prompts teach
 * (`<invoke>` / `<parameter>`), and its fragments are read as they were before. The legacy spelling
 * is the one a model falls back to when it writes a call as markup on its own (`<Browser>…</Browser>`
 * with one child element per argument); it is read whole-text and only when every top-level element
 * is a call, so a sentence beside one — or a tag shown inside a code fence — stays prose.
 */
export function readStrayToolCall(text: string): StrayToolCall | null {
  const source = text.trim()
  if (source === '' || !source.includes('<')) return null
  return readDialectEnvelope(source) ?? readLegacyEnvelope(source)
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
