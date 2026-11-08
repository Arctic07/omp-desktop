/**
 * When a conversation's turn counts as stuck, as pure readings.
 *
 * Kept apart from the watchdog (`state/session-stall.ts`) so the one decision that can destroy work
 * — a forced stop — is a pure function with its own tests rather than a branch inside a timer.
 *
 * **Only a turn in flight can be stuck.** A detached background job or a live child may run without
 * printing for hours; that is a service doing its job, not a hang, and it has its own stop. An
 * engine retry is a silence on purpose, and a dialog is the engine waiting on the reader. What is
 * left — a turn that is streaming or admitted, with nothing else in flight — is the only shape a
 * forced stop is allowed to end.
 */

import type { SessionRetry } from "@/api/session-types";
import { isStreaming, type WorkReadings } from "./work-readings.ts";

/** When the forced stop runs without the reader answering the stall row. */
export const STALL_RECLAIM_MS = 10 * 60_000;

/**
 * The facts these rules read, as a record carries them (structurally, so tests need no store).
 *
 * The turn bit and the runtime's work flags are `state/work-readings.ts`'s view of the same record,
 * extended with the two facts only a stuck turn needs: the engine's retry and the dialogs it is
 * waiting on.
 */
export interface StallReadings extends WorkReadings {
  dialogs: readonly unknown[];
  runtime:
    | (NonNullable<WorkReadings["runtime"]> & {
        retry?: SessionRetry | null;
        lastEventAt?: number;
      })
    | null;
}

/**
 * How long the conversation has produced nothing, from the later of this process's own frame clock
 * and the host's `lastEventAt`. Zero when neither ever reported anything.
 */
export function silenceOf(readings: StallReadings, localActivityAt: number, now: number): number {
  const heard = Math.max(localActivityAt, readings.runtime?.lastEventAt ?? 0);
  return heard === 0 ? 0 : Math.max(0, now - heard);
}

/** Whether this silence is a stuck turn rather than a legitimate quiet one. */
export function isReclaimable(readings: StallReadings): boolean {
  // The turn bit is the one shared reading of "a turn is in flight" (`state/work-readings.ts`);
  // without it a job that runs for hours would read as a stuck turn, and the forced stop below
  // would kill a service doing its job.
  if (!isStreaming(readings)) return false;
  const runtime = readings.runtime;
  if (runtime?.retry !== null && runtime?.retry !== undefined) return false;
  if (readings.dialogs.length > 0) return false;
  if (runtime?.pendingAsyncWork === true) return false;
  if ((runtime?.backgroundJobs?.length ?? 0) > 0) return false;
  if ((runtime?.cancellableSubagents ?? 0) > 0) return false;
  return true;
}

/** What one sweep knows about the automatic step for one conversation. */
export interface AutoReclaimInput {
  /** How long the conversation has produced nothing. */
  readonly silence: number;
  /** The snooze a *keep waiting* set, or 0. */
  readonly snoozeUntil: number;
  readonly now: number;
  /** Whether this is the conversation on screen. */
  readonly onScreen: boolean;
}

/**
 * Whether the automatic forced stop may run for one conversation now.
 *
 * The conversation on screen is never taken down this way, however long its silence: the reader is
 * there, the stall row is the decision they were given (`home/ConversationStall.tsx`), and ending a
 * turn under them is the one act this watch must not choose for them — a turn waiting on a slow
 * provider is indistinguishable from a wedged one, and the reader's own stop is one press away. A
 * conversation nobody is looking at is still reclaimed, so a stuck turn cannot hold an engine
 * session forever.
 *
 * *Keep waiting* silences both conversations the same way; it is the reader's answer, not a
 * dismissal of the row.
 */
export function autoReclaimDue(input: AutoReclaimInput): boolean {
  if (input.onScreen) return false;
  return input.silence >= STALL_RECLAIM_MS && input.snoozeUntil <= input.now;
}
