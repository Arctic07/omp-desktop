/**
 * What a conversation's work adds up to, as pure readings of a record.
 *
 * One fact, one home: three surfaces ask "is this conversation still doing something", and each needs
 * a different width of the answer — the rail's mark is the turn, the field's stop is the agent still
 * answering (the turn or a live child), and the lifetime gates (letting a record go, shedding it,
 * closing its session) must also count the engine's own background work. Those three readings live
 * here together so they cannot drift into three spellings, and so a surface that needs one of them
 * does not reach into the store to get it.
 *
 * Structural rather than the record itself, the way `state/idle-record.ts`'s view of it is: what these
 * rules say is a fact about four numbers and a list, and a test of them needs no store.
 */

import type { BackgroundJob } from '@/api/session-types'

/** The part of a conversation record these readings are taken from. */
export interface WorkReadings {
  /** The turn this side opened, if a frame of it is still standing here. */
  turnId: string | null
  runtime: {
    /** Absent in a snapshot from a host that never reported the field: nothing is running then. */
    isStreaming?: boolean
    /** A context compaction or handoff: a model call with no turn behind it. */
    isCompacting?: boolean
    pendingAsyncWork?: boolean
    cancellableSubagents?: number
    backgroundJobs?: readonly BackgroundJob[]
  } | null
}

/**
 * Whether a conversation has a turn in flight.
 *
 * Two readings, because a conversation can be attached mid-turn: `turnId` is the frame that opened
 * the turn here, and the runtime snapshot is what the engine reports about a turn that was already
 * running when this process arrived. This is the definition of "running" every surface draws — the
 * rail's mark, the transcript's streaming row, the composer's send/stop pair.
 */
export function isStreaming(record: WorkReadings | null): boolean {
  if (!record) return false
  return record.turnId !== null || record.runtime?.isStreaming === true
}

/**
 * Whether a conversation still has work nothing here must cut short: the turn, the engine's own
 * background work, or a child it can still cancel.
 *
 * This is the **lifetime** gate — it decides whether a record may be let go of, shed or closed
 * (`session-store.ts`) — and it is deliberately wider than the turn. A dev server a conversation
 * started, or a detached `task` batch, keeps `pendingAsyncWork` (or the child count) true long after
 * the answer is finished, and the session holding that work has to stay open for it.
 *
 * It is **not** the rail's word for "running": background work is not a turn, and a row marked
 * `running` for a job that outlives its answer never settles ({@link runningSessionsKey}, 2026-10-30
 * user report: 输出完毕了 左侧对话还是显示运行中图标).
 */
export function isWorking(record: WorkReadings): boolean {
  if (isStreaming(record)) return true
  // A compaction is a model call the engine is paying for: closing or shedding the session under
  // it ends work the reader asked for, even though no turn is streaming.
  if (record.runtime?.isCompacting === true) return true
  if (record.runtime?.pendingAsyncWork === true) return true
  return (record.runtime?.cancellableSubagents ?? 0) > 0
}

/**
 * Whether the agent is still answering here — the turn, or a child this host can still cancel.
 *
 * This is what the composer's send/stop pair is drawn on, and it is deliberately wider than
 * {@link isStreaming} by exactly one leg: a `task` child is the agent working in another branch,
 * whose own rows carry no stop, and a batch that outlives its turn ends through the field's stop.
 *
 * A plain background job is left out. `session_abort` does end one, but a job is a `bash`/`eval`
 * call that outlived its wait — a dev server an agent started keeps running for hours after the
 * answer, with no further engine event to settle anything. Drawing the field as "still generating"
 * for it makes a finished conversation unable to read as finished, and the job is already named in
 * the conversation's own background block, whose row carries the stop that ends it (2026-11-03,
 * user report: 结束了但是输入框还是agent输出中的样子, a turn footer under a field still showing the
 * stop square).
 *
 * Still narrower than {@link isWorking}: the engine's pending background work is left out because
 * `session_abort` cannot reach it, so a control drawn on it would press, do nothing and report
 * nothing.
 */
export function isStoppable(record: WorkReadings | null): boolean {
  if (record === null) return false
  if (isStreaming(record)) return true
  // A compaction is the engine's own work with no turn over it: `session_abort` reaches it through
  // the engine's abort, so the field draws the stop instead of looking idle through a model call.
  if (record.runtime?.isCompacting === true) return true
  return (record.runtime?.cancellableSubagents ?? 0) > 0
}

/**
 * The conversations the rail draws as running, as one key its selector can compare by identity.
 *
 * The mark is **the turn**, and nothing else: a conversation is running while the engine is answering
 * in it. It is not {@link isWorking}, because that gate also counts work that outlives the answer —
 * a dev server someone started, a detached `task` batch, a child still cancelable — and a row wearing
 * a spinner for those never settles while the job lives, so "running" stops meaning anything. What is
 * left of that work after the turn is drawn where it belongs: the conversation's own background block,
 * whose rows carry the stop that ends it.
 *
 * A joined string rather than a Set for the same reason the rail's other keys are: `useStoreSelector`
 * may only return a field or a reference the state already holds, and a fresh Set on every store
 * write would re-render the rail on every streamed frame. Sorting makes the key stable against
 * `records`' insertion order.
 */
export function runningSessionsKey(records: Readonly<Record<string, WorkReadings>>): string {
  const ids: string[] = []
  for (const [id, record] of Object.entries(records)) {
    if (isStreaming(record)) ids.push(id)
  }
  return ids.sort().join(',')
}
