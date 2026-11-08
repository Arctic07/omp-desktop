/**
 * This run's logs: where they live, what the directory holds, and the two clears.
 *
 * Nothing here is cached on the host's behalf: the directory's contents change while the page is
 * open (this run keeps writing), so the page re-reads on arrival, and every clear answers with what
 * it freed and what it left behind rather than with an acknowledgement.
 */

import { cachesClear, logsClear, logsOverview } from '@/api/diagnostics'
import type { ClearOutcome, LogsOverview } from '@/api/diagnostics'
import { toApiError, type ApiError } from '@/api/client'
import { createResource } from '@/state/resource'

export const logsResource = createResource<LogsOverview>(() => logsOverview())

export function readLogs(force = false): Promise<void> {
  return logsResource.read({ force })
}

/** Delete the directory's files. Answers with what was freed and what stayed. */
export async function clearLogs(): Promise<{ outcome: ClearOutcome | null; error: ApiError | null }> {
  try {
    const outcome = await logsClear()
    await readLogs(true)
    return { outcome, error: null }
  } catch (error) {
    return { outcome: null, error: toApiError(error) }
  }
}

/** Clear the webview caches. Sessions, settings and credentials are untouched. */
export async function clearCaches(): Promise<{
  outcome: ClearOutcome | null
  error: ApiError | null
}> {
  try {
    const outcome = await cachesClear()
    await readLogs(true)
    return { outcome, error: null }
  } catch (error) {
    return { outcome: null, error: toApiError(error) }
  }
}
