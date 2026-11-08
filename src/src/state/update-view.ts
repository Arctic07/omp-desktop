/**
 * The pure rules of the update surface: which control a status earns, and whether the title bar's
 * pill is on screen at all.
 *
 * They live beside the store rather than inside a component because two surfaces read them — the
 * title bar and the About page — and because a status is external input: a phase this build does not
 * know must not silently enable an install.
 */

import type { UpdateStatus } from '@/api/update'

/** The one act a status earns, or `null` while there is nothing to press. */
export type UpdateAction = 'check' | 'install' | 'relaunch'

export function updateAction(status: UpdateStatus | null): UpdateAction | null {
  if (status === null) return null
  switch (status.phase) {
    case 'available':
      return 'install'
    case 'ready':
      return 'relaunch'
    // A failed download still holds the announced version: pressing again retries that download
    // rather than asking the feed for a new answer.
    case 'error':
      return status.version === null ? 'check' : 'install'
    case 'idle':
    case 'current':
      return 'check'
    case 'checking':
    case 'downloading':
      return null
    case 'unsupported':
      // A development build has no installed copy to replace; there is nothing to ask.
      return null
    default:
      return assertNever(status.phase)
  }
}

/**
 * The statuses the title bar pill can draw. The runtime predicate below excludes an `error` with no
 * announced version; the type keeps the pill's switches over a closed four-member union.
 */
export type PillStatus = UpdateStatus & {
  phase: 'available' | 'downloading' | 'ready' | 'error'
}

/** Whether the title bar draws the update pill after 帮助. */
export function updatePillVisible(status: UpdateStatus | null): status is PillStatus {
  if (status === null) return false
  return (
    status.phase === 'available' ||
    status.phase === 'downloading' ||
    status.phase === 'ready' ||
    // A failed download still holds the announced version, so the pill stays as the retry the
    // reader already pressed for; a failed check has nothing to retry and stays on About.
    (status.phase === 'error' && status.version !== null)
  )
}

/** A download's percentage, clamped to the range a progress reading may claim. */
export function clampedPercent(progress: number | null): number | null {
  if (progress === null || !Number.isFinite(progress)) return null
  return Math.min(100, Math.max(0, Math.round(progress)))
}

/** A closed union this repository owns: a new member is a compile error until it is drawn. */
function assertNever(value: never): never {
  throw new Error(`unhandled update phase: ${String(value)}`)
}
