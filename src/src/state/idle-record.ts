/**
 * What a conversation reads as once the side that owns the work says there is none.
 *
 * A conversation's "still working" is assembled from this side's own bookkeeping (the turn a frame
 * opened here, the clock it started) and from the host's snapshot (streaming, a retry, background
 * work, children). The snapshot is not ordered against the engine's own edges: the desktop asks the
 * host for a fresh one on the edges it cares about (`replay::refresh_state`, one round trip each)
 * and publishes whatever comes back, so a snapshot built while the turn was running can land after
 * the ending that disproves it. What is left is a conversation that draws 「工作中…」 with a stop
 * button, and a stop that answers there is nothing to stop - which is the truth, and used to leave
 * the drawing standing forever (2026-10-26, user report: 31 minutes of "working" over a finished
 * answer, four presses of a stop that had nothing to end).
 *
 * So the stop's answer is a *write*, not only a report. `session_abort` reads the same facts the
 * eviction and release gates read, names what it could not end in `remaining`, and an empty list is
 * the authority saying this conversation has nothing in flight: the readings that say otherwise are
 * stale by definition, and this is the record they leave behind.
 *
 * The common shape of that staleness is fixed where it is created - `foldTranscript` refuses a
 * snapshot whose own clock is older than the ending it would contradict (`state/transcript.ts`, the
 * `state` arm). This rule is the backstop for the case that leaves nothing to compare against: an
 * ending frame this process never received at all, where the stop's empty answer is the only witness
 * that the turn is over.
 *
 * Kept apart from the stores that call it (`state/session-send.ts` for the reader's own stop,
 * `state/session-stall.ts` for the forced one) because it is one rule about the data, and because a
 * rule that silently lowers every "working" surface is worth testing without a desktop.
 */

import type { SessionRetry } from '../api/session-types.ts'
import type { WorkReadings as Work } from './work-readings.ts'

/**
 * The part of a conversation record this rule reads and writes.
 *
 * Structural rather than the record itself: the record lives beside the store that owns it, and a
 * test of this rule must not need one. The work flags are `state/work-readings.ts`'s view of the same
 * record, extended with what only an ending needs: when the turn began, the reader's stop mark, and
 * the retry the engine is waiting out.
 */
export interface WorkReadings extends Work {
  /** When that turn began, as the host stamped it. */
  turnStartedAt: number | null
  /** Whether the reader's stop was taken for it. */
  stopRequested: boolean
  runtime:
    | (NonNullable<Work["runtime"]> & { retry?: SessionRetry | null })
    | null
}

/** Whether every reading here already says "nothing in flight". */
function quiet(readings: WorkReadings): boolean {
  if (readings.turnId !== null || readings.turnStartedAt !== null || readings.stopRequested) return false
  const runtime = readings.runtime
  if (runtime === null) return true
  return (
    !runtime.isStreaming &&
    runtime.retry == null &&
    !runtime.pendingAsyncWork &&
    runtime.cancellableSubagents === 0 &&
    (runtime.backgroundJobs?.length ?? 0) === 0
  )
}

/**
 * The same record, reading as idle: no turn, no stop mark, and a snapshot with nothing in flight.
 *
 * A record that already reads idle is answered as itself, so the caller's store write can compare
 * identity and skip the render (`state/session-record.ts::setRecord`).
 *
 * The turn's *ending* is deliberately not written here. What a turn came to is the engine's own
 * record of it (the answer's `stopReason` in the transcript), and a conversation whose ending frame
 * never arrived has no outcome this side could state without inventing one. What the reader is owed
 * is the row no longer claiming to run.
 */
export function asIdle<T extends WorkReadings>(record: T): T {
  if (quiet(record)) return record
  const runtime = record.runtime
  // Every field written below is a reading of the same interface, so the caller's record type still
  // describes the result; TypeScript cannot narrow that through a generic, hence the one cast.
  return {
    ...record,
    turnId: null,
    turnStartedAt: null,
    stopRequested: false,
    runtime:
      runtime === null
        ? null
        : {
            ...runtime,
            isStreaming: false,
            retry: undefined,
            pendingAsyncWork: false,
            cancellableSubagents: 0,
            backgroundJobs: [],
          },
  } as T
}
