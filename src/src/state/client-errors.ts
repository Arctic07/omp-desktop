/**
 * The page's failure reporting, installed once before the first render.
 *
 * `lib/client-errors.ts` holds the shape and the bounds of a line; this module is the half that
 * knows where a line goes (`logs_write`) and what the window can observe - an uncaught throw, an
 * unhandled rejection - and hands the resulting reporter to the render boundary through
 * `setClientErrorReporter`.
 *
 * Installed once, before anything renders: a listener added later would miss the start of the run,
 * which is exactly when a broken build fails. `StrictMode` doubles renders but not module
 * evaluation, so the listeners are registered once.
 */

import { writeLogLine } from '@/api/diagnostics'
import { createClientErrorReporter, setClientErrorReporter } from '@/lib/client-errors'

export function installClientErrorReporting(): void {
  const report = createClientErrorReporter((message) => {
    // A refused line is the host's answer about its own budget (`PAGE_LOG_LIMIT_BYTES`), and no
    // page path can act on it: the rejection must not reach the rejection listener below, or a
    // spent budget would report itself forever.
    void writeLogLine('error', message).catch(() => undefined)
  })
  setClientErrorReporter(report)

  window.addEventListener('error', (event) => {
    // A failed resource load (`<img>`, a stylesheet, a worker script) is an `error` event without an
    // `ErrorEvent` behind it. It is not a failure this page can describe, and the element's own row
    // already states what it could not show.
    if (!(event instanceof ErrorEvent)) return
    report('uncaught error', event.error ?? event.message)
  })

  window.addEventListener('unhandledrejection', (event) => {
    report('unhandled rejection', event.reason)
  })
}
