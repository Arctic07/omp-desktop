/**
 * The syntax-highlighting worker.
 *
 * Tokenizing is the expensive half of colouring source: a 96 KiB file takes shiki 0.8–2 s, and on
 * the UI thread that is a frozen window for as long as it runs. Moving the highlighter here keeps
 * the reader's scroll and typing responsive; the main thread only receives the finished token lines.
 *
 * The bundle is fine-grained on purpose. `shiki`'s convenience entry pulls the full grammar table
 * (and every grammar's chunk) into the build; `shiki/core` plus the curated loaders in
 * `code-language.ts` ships only the mainstream set the UI can actually name. Themes are imported
 * the same way, so the two the application draws with are the only two in the assets.
 *
 * Caches are bounded on both axes for the same reason they are on the old in-page highlighter: a
 * streamed tool result is a new string on every update frame, so an unbounded cache keeps a token
 * tree per intermediate state. The worker drops least-recently-used entries first.
 */

import {
  createHighlighterCore,
  type HighlighterCore,
} from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'

import {
  resolveCodeLanguage,
  type AgentCodeLanguage,
  type AgentCodeTokenLines,
  type CodeHighlightRequest,
  type CodeHighlightResponse,
  type CodeLanguage,
} from './code-language'
import { CODE_LANGUAGES } from './code-language-loaders'

const LIGHT_THEME = 'github-light-high-contrast'
const DARK_THEME = 'github-dark-high-contrast'

const TOKEN_CACHE_ENTRIES = 48
const TOKEN_CACHE_CHARS = 512 * 1024

interface CachedTokens {
  lines: AgentCodeTokenLines
  /** The source's length, which is what the cache is measured in. */
  chars: number
}

const tokenCache = new Map<string, CachedTokens>()
let tokenCacheChars = 0

function cachedTokens(key: string): AgentCodeTokenLines | undefined {
  const cached = tokenCache.get(key)
  if (cached === undefined) return undefined
  // Re-inserting on a hit makes the Map's insertion order a recency order.
  tokenCache.delete(key)
  tokenCache.set(key, cached)
  return cached.lines
}

function rememberTokens(key: string, chars: number, lines: AgentCodeTokenLines): void {
  const existing = tokenCache.get(key)
  if (existing !== undefined) {
    tokenCache.delete(key)
    tokenCacheChars -= existing.chars
  }
  tokenCache.set(key, { lines, chars })
  tokenCacheChars += chars
  while (tokenCache.size > TOKEN_CACHE_ENTRIES || tokenCacheChars > TOKEN_CACHE_CHARS) {
    const oldest = tokenCache.keys().next().value
    if (oldest === undefined) break
    const entry = tokenCache.get(oldest)
    tokenCache.delete(oldest)
    tokenCacheChars -= entry?.chars ?? 0
  }
}

/* Each theme's own default foreground: what it paints a token it has no rule for. Both answer with
   white, which is the one colour this application never draws text in, so those tokens are handed
   back to the page's ink. Read off the theme rather than written down here. */
const plainForeground = { light: '', dark: '' }

let highlighterPromise: Promise<HighlighterCore> | null = null

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [
      import('shiki/themes/github-light-high-contrast.mjs'),
      import('shiki/themes/github-dark-high-contrast.mjs'),
    ],
    langs: [],
    engine: createOnigurumaEngine(import('shiki/wasm')),
  }).then((highlighter) => {
    plainForeground.light = highlighter.getTheme(LIGHT_THEME).fg.toLowerCase()
    plainForeground.dark = highlighter.getTheme(DARK_THEME).fg.toLowerCase()
    return highlighter
  })
  return highlighterPromise
}

/**
 * Grammar loads in flight, shared by every request. Two files of one language opened at once would
 * otherwise both call `loadLanguage`; shiki would register the grammar twice.
 */
const languageLoads: Partial<Record<CodeLanguage, Promise<void>>> = {}

function ensureLanguage(highlighter: HighlighterCore, language: CodeLanguage): Promise<void> {
  if (highlighter.getLoadedLanguages().includes(language)) return Promise.resolve()
  const existing = languageLoads[language]
  if (existing !== undefined) return existing
  const pending = highlighter
    .loadLanguage(CODE_LANGUAGES[language]())
    .finally(() => {
      delete languageLoads[language]
    })
  languageLoads[language] = pending
  return pending
}

function themeInk(color: string | undefined, plain: string): string | undefined {
  return color && plain && color.toLowerCase() === plain ? 'var(--foreground)' : color
}

function tokenCacheKey(code: string, language: CodeLanguage): string {
  return `${language}\u0000${code}`
}

interface CodeWorkerScope {
  onmessage: ((event: MessageEvent<CodeHighlightRequest>) => void) | null
  postMessage(message: CodeHighlightResponse): void
}

const scope = self as unknown as CodeWorkerScope

function respond(id: number, lines: AgentCodeTokenLines | null): void {
  // The answer is the only thing that lets the caller's slot move on, so a throwing `postMessage`
  // (a channel closed by `terminate`, a payload that does not clone) is logged rather than thrown
  // into the queue: the main thread has its own watchdog for an answer that never arrives.
  try {
    scope.postMessage({ id, lines })
  } catch (error) {
    console.error('the highlighter worker could not answer a request', error)
  }
}

async function tokenize(
  code: string,
  language: AgentCodeLanguage,
  maxChars: number,
): Promise<AgentCodeTokenLines | null> {
  const resolved = resolveCodeLanguage(language)
  // `text`, an alias this build does not ship, an empty file, or one past the caller's bound: the
  // caller draws the source itself, which is already the correct output.
  if (resolved === null || code.length === 0 || code.length > maxChars) return null

  const key = tokenCacheKey(code, resolved)
  const cached = cachedTokens(key)
  if (cached !== undefined) return cached

  try {
    const highlighter = await getHighlighter()
    await ensureLanguage(highlighter, resolved)
    const lines = (await highlighter.codeToTokensWithThemes(code, {
      lang: resolved,
      themes: { light: LIGHT_THEME, dark: DARK_THEME },
    })).map((line) =>
      line.map((token) => ({
        content: token.content,
        offset: token.offset,
        light: themeInk(token.variants.light?.color, plainForeground.light),
        dark: themeInk(token.variants.dark?.color, plainForeground.dark),
      })),
    )
    rememberTokens(key, code.length, lines)
    return lines
  } catch {
    // A grammar this engine cannot run degrades to plain text; the file is never truncated.
    return null
  }
}

/**
 * One job, in the order the chain received it.
 *
 * `warm` and `prefetch` answer `null` too: the caller's scheduler only waits for ids it holds a slot
 * for, and a fire-and-forget answer that matches nothing is simply ignored. Their failures are
 * caught here so a missing wasm or grammar cannot reject the chain and strand later requests.
 */
async function run(request: CodeHighlightRequest): Promise<void> {
  if (request.kind === 'warm') {
    try {
      await getHighlighter()
    } catch {
      // No preview colours, but the text is still drawn — exactly the `highlight` failure path.
    }
    respond(request.id, null)
    return
  }

  if (request.kind === 'prefetch') {
    const language = resolveCodeLanguage(request.language)
    if (language !== null) {
      try {
        await ensureLanguage(await getHighlighter(), language)
      } catch {
        // The same grammar will fail the same way when the file is highlighted; nothing to add.
      }
    }
    respond(request.id, null)
    return
  }

  respond(request.id, await tokenize(request.code, request.language, request.maxChars))
}

/* Requests are handled one at a time: shiki's engine is not re-entrant, and serializing also keeps
   a burst of streamed code blocks from interleaving their grammar loads. */
let chain: Promise<void> = Promise.resolve()

/**
 * One frame, as much as the worker will act on.
 *
 * `event.data` is whatever crossed the boundary — a message from a page that is not this build, or
 * a value that did not survive structured cloning. Every field is checked before it is used, and a
 * frame that cannot be understood is dropped rather than half-processed: the caller's slot only
 * waits for an `id` it posted, so there is nobody to answer here.
 */
function readRequest(data: unknown): CodeHighlightRequest | null {
  if (data === null || typeof data !== 'object') return null
  const candidate = data as {
    id?: unknown
    kind?: unknown
    code?: unknown
    language?: unknown
    maxChars?: unknown
  }
  if (typeof candidate.id !== 'number' || !Number.isFinite(candidate.id)) return null
  const id = candidate.id
  switch (candidate.kind) {
    case 'warm':
      return { id, kind: 'warm' }
    case 'prefetch':
      if (typeof candidate.language !== 'string') return null
      return { id, kind: 'prefetch', language: candidate.language as AgentCodeLanguage }
    case 'highlight':
      if (typeof candidate.code !== 'string') return null
      if (typeof candidate.language !== 'string') return null
      if (typeof candidate.maxChars !== 'number' || !Number.isFinite(candidate.maxChars)) return null
      return {
        id,
        kind: 'highlight',
        code: candidate.code,
        language: candidate.language as AgentCodeLanguage,
        maxChars: candidate.maxChars,
      }
    default:
      return null
  }
}

scope.onmessage = (event: MessageEvent<unknown>) => {
  const request = readRequest(event.data)
  if (request === null) return
  // **Every link answers.** A rejected chain skips every later `.then`, which would leave the main
  // thread's slot waiting on a response forever (it only pumps on a message), so a failure answers
  // "plain text" for its own request and keeps the queue moving (2026-10-22, review).
  chain = chain
    .then(() => run(request))
    .catch((error) => {
      console.error('the highlighter worker could not tokenize a request', error)
      respond(request.id, null)
    })
}
