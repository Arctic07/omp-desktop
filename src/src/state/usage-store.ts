/**
 * Token and cost accounting over this desktop's own session files.
 *
 * Two answers, because the page shows two: the lifetime figures and the activity grid come from the
 * whole history (`rangeDays: null`), and the trend chart and the model breakdown come from the
 * window the reader picked. Both are the same command with a different window, so both are read
 * here rather than by the two halves of the page.
 *
 * Neither read walks the history: the host keeps a per-file index of the store's usage and parses
 * only the files that changed, so a page open is a stat per file and both answers are built from
 * the same index. `refresh` still asks again - it is how the button picks up the turns written since
 * the page was drawn.
 */

import { engineUsage } from '@/api/capabilities'
import type { EngineUsageView } from '@/api/capabilities-types'
import { createKeyedResource, createResource } from '@/state/resource'

/** The whole history: the summary strip and the activity grid. */
export const lifetimeResource = createResource<EngineUsageView>(() => engineUsage(null))

/** One window: the trend chart and the model breakdown. */
export const windowResource = createKeyedResource<number, EngineUsageView>((days) =>
  engineUsage(days),
)

/** Read what the page needs for one window. Idempotent for the window already answered. */
export function readUsage(rangeDays: number): void {
  void lifetimeResource.read()
  void windowResource.read(rangeDays)
}

/** The page's own refresh: ask again for both, past the host's memo. */
export function refreshUsage(rangeDays: number): void {
  void lifetimeResource.read({ force: true })
  void windowResource.read(rangeDays, { force: true })
}
