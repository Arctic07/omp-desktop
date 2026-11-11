/**
 * The conversation that stopped producing anything, and the one action that ends it.
 *
 * A turn can wedge after the engine has taken it: the host keeps reading the session as busy, the
 * transcript stops moving, and every surface that draws "working" keeps drawing it. Pressing stop is
 * the first answer, but an engine stuck inside a frame it cannot abort is exactly what the host's
 * own forced stop exists for (`session_force_stop`): it disposes that one session, keeps its
 * transcript, and lets the next open load it back. This module decides when to offer that step and
 * when to take it, and it is the only caller of the forced stop.
 *
 * **Detection is local, action is the host's.** The clock is this process's frame arrivals
 * (`state/session-activity.ts`) with the host's own `lastEventAt` as the baseline for a conversation
 * opened mid-turn. That is deliberately more than the state snapshot: a long healthy turn publishes
 * its snapshot only at the edges, and reading silence off a snapshot would reclaim a conversation
 * that is streaming perfectly well. Its row follows the same reading: `forgetStalled` takes it down
 * on the next activity note, not on the next sweep.
 *
 * **What counts as stuck is narrow, because a wrong reclaim is destructive.** Only a turn in flight
 * is considered, and only when nothing legitimate could explain the quiet: no engine retry (a
 * backoff is silent by design), no dialog waiting on the reader, no detached background job, no
 * pending async work and no live child. A background shell may legitimately run for hours, so it is
 * never reclaimed for being quiet; it has its own stop in the background tasks tab.
 *
 * **The reader can override the hard step.** At {@link STALL_NOTICE_MS} the composer draws the row
 * with *reclaim* and *keep waiting*; keeping waits {@link STALL_SNOOZE_MS}. Without an answer the
 * forced stop runs at the window `stall-rules.ts::STALL_RECLAIM_MS` for a conversation nobody is
 * looking at — so a stuck turn cannot hold a live engine session forever — while the conversation on
 * screen is never taken down automatically: the reader is there, the row is the decision they were
 * given, and a turn waiting on a slow provider looks exactly like a wedged one
 * (`stall-rules.ts::autoReclaimDue`).
 */

import { sessionForceStop } from '@/api/agent'
import { toApiError } from '@/api/client'
import {
  forgetSessionActivity,
  lastSessionActivity,
  onSessionHeard,
  sessionSnoozed,
  snoozeSession,
} from '@/state/session-activity'
import { asIdle } from '@/state/idle-record'
import {
  setRecord,
  type SessionRecord,
} from '@/state/session-record'
import { afterReclaim, sessionStore } from '@/state/session-store'
import { restoreWithdrawnPrompts } from '@/state/restored-prompts'
import { autoReclaimDue, isReclaimable, silenceOf, withoutStalledRow } from '@/state/stall-rules'
import { createStore } from '@/state/store'
import { pushNotice } from '@/state/transcript'

/** When the row appears, and when the forced stop runs without the reader answering it. */
export const STALL_NOTICE_MS = 3 * 60_000
/** How long *keep waiting* silences the automatic step. */
export const STALL_SNOOZE_MS = 30 * 60_000
/** How often the watch looks; a conversation's silence changes on a human timescale. */
const STALL_SWEEP_MS = 10_000

/** The conversations over the notice threshold, and the activity time their silence is measured from. */
export interface StallWatchState {
  readonly stalled: Readonly<Record<string, number>>
}

export const stallWatchStore = createStore<StallWatchState>({ stalled: {} })

/** The last moment this side or the host heard from a conversation. */
function lastHeard(record: SessionRecord): number {
  return Math.max(lastSessionActivity(record.id), record.runtime?.lastEventAt ?? 0)
}

/** The reclaims already on their way, so one sweep cannot start two for the same conversation. */
const reclaiming = new Set<string>()

let timer: number | null = null
/** The subscription that takes a row down the moment its conversation writes again. */
let stopHeard: (() => void) | null = null

/** Start the watch. One timer for the process; a second call is a no-op. */
export function startStallWatch(): void {
  if (timer !== null) return
  stopHeard = onSessionHeard(forgetStalled)
  timer = window.setInterval(sweepStalls, STALL_SWEEP_MS)
  sweepStalls()
}

/** Stop the watch, for the process ending or a test tearing one down. */
export function stopStallWatch(): void {
  if (timer === null) return
  stopHeard?.()
  stopHeard = null
  window.clearInterval(timer)
  timer = null
  stallWatchStore.set({ stalled: {} })
}

/**
 * Take one conversation's row down because it produced something.
 *
 * The row's premise is that nothing arrived, so the first activity note is the fact that ends it.
 * Waiting for the next sweep would leave the warning over an answer that had already resumed
 * writing, which is the defect the row then states against itself. Only a present id is rewritten
 * (`stall-rules.ts::withoutStalledRow`), so a note for a conversation with nothing drawn costs one
 * lookup and no store write.
 */
function forgetStalled(sessionId: string): void {
  const current = stallWatchStore.get().stalled
  const next = withoutStalledRow(current, sessionId)
  if (next !== current) stallWatchStore.set({ stalled: next })
}

/** The reader's answer to the row: no automatic step for this conversation for a while. */
export function keepWaiting(sessionId: string): void {
  snoozeSession(sessionId, Date.now() + STALL_SNOOZE_MS)
  publishStalled()
}

/**
 * Take one conversation's host session down, and put its history back where the reader can read it.
 *
 * Two callers ask for the same act for two different reasons, and the difference is only in what the
 * reader is told: the watch takes a conversation nobody is looking at down after a silence it
 * answered for nobody ({@link origin} `'watch'`), and the composer's own forced stop does it at a
 * reader's press, right under a stop that came back saying work was still running (`'reader'`). What
 * is torn down, counted, reopened and reported is the same either way.
 *
 * The record is reset here before the reopen because the host has just released the session and no
 * `turn_finished` frame will ever arrive for the turn that was taken down: leaving `turnId` and
 * `isStreaming` standing would keep every "working" surface on after the work is gone. The reopen
 * (active conversation) or release (one nobody is looking at) is the store's own step.
 *
 * A refusal is reported as the notice it is, and the automatic step backs off for the same window
 * *keep waiting* uses: a host that cannot answer will not be pressed every ten seconds.
 */
export async function reclaimSession(
  sessionId: string,
  origin: 'watch' | 'reader' = 'watch',
): Promise<boolean> {
  if (reclaiming.has(sessionId)) return false
  reclaiming.add(sessionId)
  try {
    const outcome = await sessionForceStop(sessionId)
    forgetSessionActivity(sessionId)
    // The forced stop withdraws the queue exactly as an ordinary one does; its words go back to the
    // reader rather than into the void.
    if (outcome.restored.length > 0) restoreWithdrawnPrompts(sessionId, outcome.restored)
    const restored = outcome.restored.length
    setRecord(sessionId, (record) => {
      const idle = asIdle(record)
      return {
        ...idle,
        notices: pushNotice(
          idle.notices,
          'info',
          origin === 'reader' ? 'force_stopped' : 'stalled_reclaimed',
          origin === 'reader'
            ? 'The conversation was force-stopped. Its history is still here.'
            : 'The conversation stopped responding and was reclaimed.',
        ),
      }
    })
    if (restored > 0) {
      setRecord(sessionId, (record) => ({
        ...record,
        notices: pushNotice(
          record.notices,
          'info',
          'stop_restored_prompts',
          `${String(restored)} unsent message(s) were returned to the composer.`,
        ),
      }))
    }
    if (outcome.forced) afterReclaim(sessionId)
    return true
  } catch (error) {
    const failure = toApiError(error)
    setRecord(sessionId, (record) => ({
      ...record,
      notices: pushNotice(
        record.notices,
        'error',
        origin === 'reader' ? 'force_stop_failed' : 'stalled_reclaim_failed',
        failure.message,
      ),
    }))
    snoozeSession(sessionId, Date.now() + STALL_SNOOZE_MS)
    return false
  } finally {
    reclaiming.delete(sessionId)
    sweepStalls()
  }
}

/** One look at every conversation this process holds. */
function sweepStalls(): void {
  const now = Date.now()
  const activeId = sessionStore.get().activeId
  const next: Record<string, number> = {}
  for (const record of Object.values(sessionStore.get().records)) {
    if (!isReclaimable(record)) continue
    const silence = silenceOf(record, lastSessionActivity(record.id), now)
    if (silence < STALL_NOTICE_MS) {
      // The conversation moved again: both the row and a *keep waiting* from an earlier silence are
      // about a stretch of quiet that is over.
      if (sessionSnoozed(record.id) > 0) snoozeSession(record.id, 0)
      continue
    }
    const snooze = sessionSnoozed(record.id)
    const heard = lastHeard(record)
    if (snooze <= now) next[record.id] = heard
    if (
      !reclaiming.has(record.id) &&
      autoReclaimDue({ silence, snoozeUntil: snooze, now, onScreen: record.id === activeId })
    ) {
      void reclaimSession(record.id)
    }
  }
  const current = stallWatchStore.get().stalled
  if (!sameStalled(current, next)) stallWatchStore.set({ stalled: next })
}

/** Rewrite the row's state after a reader action, without waiting for the next sweep. */
function publishStalled(): void {
  const now = Date.now()
  const next: Record<string, number> = {}
  for (const record of Object.values(sessionStore.get().records)) {
    if (!isReclaimable(record)) continue
    if (silenceOf(record, lastSessionActivity(record.id), now) < STALL_NOTICE_MS) continue
    if (sessionSnoozed(record.id) > now) continue
    next[record.id] = lastHeard(record)
  }
  stallWatchStore.set({ stalled: next })
}

function sameStalled(left: Readonly<Record<string, number>>, right: Readonly<Record<string, number>>): boolean {
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => left[key] === right[key])
}
