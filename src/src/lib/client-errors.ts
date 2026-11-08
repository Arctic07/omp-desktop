/**
 * What the page does with a failure of its own.
 *
 * A render failure, an uncaught throw and an unhandled rejection all end in the webview's own
 * console, which nobody sees once the window is closed - so a user reporting "the window went
 * blank" left no trace anywhere a developer could read. `logs_write` already exists for the one
 * page-side fact this application records (`reportTerminalFace`); this module is the general form:
 * every failure the page can observe becomes one line in `app.log`, next to the application's own.
 *
 * Two bounds keep a broken page from spending the log:
 *
 * - the line is cut to [`MAX_LINE_CHARS`] characters (the host cuts again at its own byte ceiling);
 * - one message is written once ([`MAX_DISTINCT_LINES`] distinct messages per run), because a
 *   failure inside a render loop repeats on every frame and the second copy says nothing the first
 *   did not. The count of what was suppressed is not tracked: the line that closes the budget is
 *   the evidence that more happened.
 *
 * Reporting never fails the caller: a rejected `logs_write` is the host refusing a line, which is
 * not something a page error path can act on, and a throwing writer must not turn one failure into
 * two.
 */

/** Characters one line may carry. The host cuts at 2 KiB of bytes after its own prefix. */
const MAX_LINE_CHARS = 1600

/** Distinct messages one run reports. Past this, the once-only line says the budget is spent. */
const MAX_DISTINCT_LINES = 40

/** Stack frames kept per failure: enough to find the component, short enough to read as one line. */
const MAX_STACK_FRAMES = 6

/** What a reporter writes with: the level is always `error`, and the host does the redaction. */
export type ClientErrorWriter = (message: string) => void

export type ClientErrorReporter = (
  scope: string,
  error: unknown,
  detail?: string | null,
) => void

/**
 * One line for one failure: what was being drawn, the error's own name and message, and the first
 * frames of its stack.
 *
 * A newline is written as a space rather than kept: the host turns a break into `\n` anyway (one
 * record per line), and a reader looking at `app.log` should not have to un-escape the structure a
 * stack already spells with `at`.
 */
export function clientErrorLine(
  scope: string,
  error: unknown,
  detail?: string | null,
): string {
  const stack = error instanceof Error ? error.stack : undefined
  const frames = stack === undefined ? [] : stackFrames(stack)
  const parts = [`${scope}: ${describeError(error)}`, ...frames]
  if (detail !== undefined && detail !== null && detail.trim() !== '') {
    parts.push(`detail: ${detail.replace(/\s+/g, ' ').trim()}`)
  }
  const line = parts.join(' | ').replace(/[\r\n]+/g, ' ').trim()
  return line.length <= MAX_LINE_CHARS ? line : `${line.slice(0, MAX_LINE_CHARS - 1)}…`
}

/** What failed, without its frames: the identity of a failure, and the key its deduplication uses. */
function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return typeof error === 'string' ? error : safeJson(error)
}

/** The frames of a stack after its first line, which repeats the message. */
function stackFrames(stack: string): string[] {
  return stack
    .split('\n')
    .slice(1)
    .map((frame) => frame.trim())
    .filter((frame) => frame !== '')
    .slice(0, MAX_STACK_FRAMES)
}

/** An error that is not an `Error`: a rejection reason, usually. Never throws. */
function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}

/**
 * A reporter over one writer, with its own deduplication.
 *
 * Separate from [`installClientErrorReporting`] so a test can watch what would be written without
 * a window, a host, or the module's process-wide state.
 */
export function createClientErrorReporter(write: ClientErrorWriter): ClientErrorReporter {
  const seen = new Set<string>()
  let stopped = false
  return (scope, error, detail) => {
    if (stopped) return
    const line = clientErrorLine(scope, error, detail)
    // The deduplication key is the scope and the failure's own description without its frames: the
    // same invariant broken twice in one run is one record, while two different failures that share
    // a stack line are two.
    const key = `${scope}: ${describeError(error)}`
    if (seen.has(key)) return
    if (seen.size >= MAX_DISTINCT_LINES) {
      stopped = true
      safelyWrite(
        write,
        `${seen.size} distinct client errors were reported; later ones are dropped until restart`,
      )
      return
    }
    seen.add(key)
    // The host tags a page line with `page:` itself (`diagnostics::write_frontend_line`), so the
    // message travels as written.
    safelyWrite(write, line)
  }
}

/** A writer that throws is a failure of the log path, not a second failure of the page. */
function safelyWrite(write: ClientErrorWriter, message: string): void {
  try {
    write(message)
  } catch {
    // Nothing here can be reported: this *is* the reporting path.
  }
}

/** The reporter this page installed, if it has one. */
let reporter: ClientErrorReporter | null = null

/**
 * The one entry point a surface that catches its own failure calls (the render boundary).
 *
 * Silent before `state/client-errors.ts` has installed its reporter: a failure during module
 * evaluation has no channel to the host yet, and the boundary must still draw something.
 */
export function reportClientError(scope: string, error: unknown, detail?: string | null): void {
  reporter?.(scope, error, detail)
}

/**
 * Puts a reporter behind [`reportClientError`].
 *
 * Separate from the reporter itself so this module stays free of the Tauri API: the formatting and
 * the bounds are checked by a Node test, which cannot load the command surface (`state/
 * client-errors.ts` is the half that installs it, and the half a window needs).
 */
export function setClientErrorReporter(next: ClientErrorReporter): void {
  reporter = next
}
