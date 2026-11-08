/**
 * The results a stop must not be answered with.
 *
 * Killing a session's children ends their runs, and the engine hands every settled job's result
 * back to the session that owns it as an `async-result` follow-up (`session/agent-session.ts`'s
 * delivery sink, registered on the session's yield queue under `session/async-job-delivery.ts`'s
 * message type). A follow-up that lands on an otherwise idle session is not a note: the engine
 * reads a pending async wake as a scheduling pause rather than a terminal stop and continues the
 * loop on it (`session/agent-session.ts:4231-4237`). Left as it was, one press of stop aborted the
 * turn, the children's own obsolete results arrived a moment later and started a fresh turn, and the
 * work only ended when the user pressed stop a second time on that turn - which is the reported
 * symptom this module exists to remove.
 *
 * Both halves are the engine's own primitives, and both are needed:
 *
 * - `subagents.ts`'s `cancel` names the children the stop ended, and those ids are the job ids of
 *   their runs (`async/job-control.ts:383`: "job id == agent id for task spawns"), which is what
 *   `acknowledgeDeliveries` silences - the same call the engine's own foreground snapshots use to
 *   say "this job's result is already accounted for".
 * - A result that was parked on the queue before the press is the same wake by the other route,
 *   and the stop is the one press that may not be answered with another turn. `clear` drops
 *   exactly that kind, leaving any other queue untouched.
 *
 * Nothing is lost by it: a silenced result stays readable at `agent://<id>` and its job body stays
 * on the manager for a later jobs snapshot (`async/job-control.ts`), so the model can still recover
 * it if the user asks - it just no longer gets to decide, on its own, that the stopped run should
 * continue.
 */

import type { AgentSession } from './sdk.ts'

/**
 * Silences the wake-ups one stop would otherwise produce.
 *
 * `endedIds` are the children this stop took off the session's roster; `messageType` is the
 * engine's own word for the delivered-result follow-up. Answers how many results it silenced, which
 * the stop reports in its own log line and counts as work it ended: a result parked before the press
 * is a wake the stop took away just as much as a job it killed, and it is the only one of the two
 * that leaves no other trace (`clear` answers nothing, so the queue is asked first).
 */
export function silenceStoppedResults(
  session: AgentSession,
  messageType: string,
  endedIds: readonly string[],
): number {
  const parked = session.yieldQueue.has(messageType) ? 1 : 0
  const dropped = endedIds.length > 0
    ? session.asyncJobManager?.acknowledgeDeliveries([...endedIds]) ?? 0
    : 0
  session.yieldQueue.clear(messageType)
  return dropped + parked
}
