/**
 * stderr logging with credential/path redaction.
 *
 * stdout carries protocol frames only, so every diagnostic goes to stderr. Text that may quote
 * engine output is sanitized first: the same shapes the Rust host redacts again on its side.
 */

const KEY_PREFIXES = ['sk-', 'sk_', 'ghp_', 'github_pat_', 'xoxb-', 'AIza']
const ENTROPY_MIN = 40
const OUTPUT_LIMIT = 4_000

/** POSIX roots that name a user or a machine, matching the Rust redactor's home-path case. */
const POSIX_ROOTS = ['/home/', '/Users/', '/root/', '/var/', '/etc/', '/opt/', '/usr/', '/tmp/']

/**
 * Characters re-emitted after `<path>` when the redacted run ends in them.
 *
 * A path is consumed up to the next whitespace, which also swallows whatever quoted or
 * parenthesised it (`"…jsonl":`, `cwd=…)`). Putting the trailing punctuation back keeps messages
 * readable without exposing anything: the redacted run was replaced whole, and punctuation
 * carries no path content.
 */
const TRAILING_PUNCTUATION = new Set(['"', "'", ')', '>', ',', ';', '}', ']', ':', '.'])
const MAX_TRAILING_PUNCTUATION = 4

/** True when the run of characters at `index` looks like a long generated credential. */
function looksLikeCredential(text: string, start: number): number {
  let end = start
  let upper = 0
  let lower = 0
  let digit = 0
  while (end < text.length) {
    const character = text[end]
    if (character === undefined || !/[A-Za-z0-9_\-+/]/.test(character)) break
    if (character >= 'A' && character <= 'Z') upper += 1
    else if (character >= 'a' && character <= 'z') lower += 1
    else if (character >= '0' && character <= '9') digit += 1
    end += 1
  }
  const length = end - start
  if (length < ENTROPY_MIN) return 0
  return upper > 0 && lower > 0 && digit > 0 ? length : 0
}

/**
 * The single redactor for every string this host prints or ships (contract §2.8).
 *
 * `keepPaths` exists for one kind of text: a discovery warning whose whole payload is the config
 * file it names (`mcp.ts`). A credential is a credential wherever it appears, so the key, Bearer
 * and entropy branches run either way; a path is redacted only where the sentence is about
 * something else, because there it is noise the reader has no business with. In `keepPaths` mode a
 * path-shaped run is emitted whole - including through the entropy branch, which would otherwise
 * swallow a long file name such as a timestamped session id.
 */
function redact(input: string, keepPaths: boolean): string {
  const out: string[] = []
  let written = 0
  let index = 0
  while (index < input.length && written < OUTPUT_LIMIT) {
    const character = input[index] as string
    // A drive letter is only a path when it starts a word. `xd://`, `local://`, `agent://` and
    // `https://` all reach the same `d:` / `l:` / `t:` / `s:` shape from inside a scheme, and the
    // run that follows is a tool name or a host rather than a file: redacting it turned the tool
    // list into `~ x<path>` and a mount notice into `x<path>: unmounted …`. Two rules keep the two
    // apart - the letter must open the word (not sit inside one), and the colon must not be the
    // scheme separator (`://`, which no drive uses).
    const isDrivePath =
      /[A-Za-z]/.test(character) &&
      input[index + 1] === ':' &&
      (input[index + 2] === '\\' || input[index + 2] === '/') &&
      input[index + 3] !== '/' &&
      (index === 0 || !/[A-Za-z0-9_.+-]/.test(input[index - 1] as string))
    const isUncPath = character === '\\' && input[index + 1] === '\\'
    const isPosixPath = character === '/' && POSIX_ROOTS.some(root => input.startsWith(root, index))
    if (isDrivePath || isUncPath || isPosixPath) {
      const start = index
      while (index < input.length && !/\s/.test(input[index] as string)) index += 1
      const run = input.slice(start, index)
      if (keepPaths) {
        out.push(run)
        written += run.length
        continue
      }
      let keep = 0
      while (keep < run.length && keep < MAX_TRAILING_PUNCTUATION && TRAILING_PUNCTUATION.has(run[run.length - 1 - keep] as string)) {
        keep += 1
      }
      out.push(`<path>${run.slice(run.length - keep)}`)
      written += 6 + keep
      continue
    }
    const prefix = KEY_PREFIXES.find(candidate => input.startsWith(candidate, index))
    if (prefix !== undefined) {
      while (index < input.length && !/[\s"',;]/.test(input[index] as string)) index += 1
      out.push('<redacted>')
      written += 10
      continue
    }
    if (input.startsWith('Bearer ', index)) {
      index += 'Bearer '.length
      while (index < input.length && !/[\s"',;]/.test(input[index] as string)) index += 1
      out.push('Bearer <redacted>')
      written += 17
      continue
    }
    const credentialLength = looksLikeCredential(input, index)
    if (credentialLength > 0) {
      index += credentialLength
      out.push('<redacted>')
      written += 10
      continue
    }
    out.push(character)
    written += 1
    index += 1
  }
  return out.join('')
}

/** Redaction for diagnostics and errors: credentials and paths both go. */
export function sanitizeMessage(input: string): string {
  return redact(input, false)
}

/** Redaction for text whose meaning *is* the file it names: credentials go, paths stay. */
export function sanitizeConfigMessage(input: string): string {
  return redact(input, true)
}

/** stderr sink: one line per record, never on stdout. */
export function logLine(message: string): void {
  process.stderr.write(`[host] ${sanitizeMessage(message)}\n`)
}

/** Logs an error with its sanitized message; the stack is deliberately not printed. */
export function logError(scope: string, error: unknown): void {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  logLine(`${scope}: ${detail}`)
}
