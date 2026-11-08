/**
 * `/btw`: side questions, run by this host through the engine's own controller.
 *
 * The engine ships a non-terminal implementation (`modes/rpc/rpc-btw.ts`) for exactly this: one
 * side question at a time against the main session, streamed as deltas, checkpointed into the
 * session's BTW sidecar. This module owns the mapping to the desktop's own frame and the per
 * conversation controller; the question, the ephemeral turn and the history are the engine's.
 *
 * The answer is a *side* conversation: it never enters the main transcript. The frame carries the
 * streamed text so the side panel can draw it, and a record snapshot on every lifecycle change so
 * the panel's ending (complete, cancelled, error) is the engine's own.
 */

import type { AgentSession } from '@oh-my-pi/pi-coding-agent'
import { RpcBtwController } from '@oh-my-pi/pi-coding-agent/modes/rpc/rpc-btw'

/** One frame the side panel reads. */
export type BtwFrame =
  | { readonly type: 'btw'; readonly kind: 'delta'; readonly delta: string }
  | {
      readonly type: 'btw'
      readonly kind: 'record'
      readonly question: string
      readonly answer: string
      readonly status: string
      readonly error?: string
    }
  | { readonly type: 'btw'; readonly kind: 'cleared' }

/** Where the frames go: the conversation's own event pipe. */
export type BtwEmit = (frame: BtwFrame) => void

/** One controller per conversation, created with the sink its frames should reach. */
const controllers = new WeakMap<AgentSession, RpcBtwController>()

function controllerOf(session: AgentSession, emit: BtwEmit): RpcBtwController {
  let controller = controllers.get(session)
  if (controller !== undefined) return controller
  controller = new RpcBtwController(session, (frame) => {
    if (frame.type === 'btw_delta') {
      emit({ type: 'btw', kind: 'delta', delta: frame.delta })
      return
    }
    if (frame.type === 'btw_record') {
      const record = frame.record
      emit({
        type: 'btw',
        kind: 'record',
        question: record.question,
        answer: record.answer,
        status: record.status,
        ...(record.error === undefined ? {} : { error: record.error }),
      })
      return
    }
    // The controller's third frame is its own notice (a checkpoint failure); it rides the host's
    // notice channel rather than the side panel, because it is about the topic store, not the answer.
    emit({ type: 'btw', kind: 'record', question: '', answer: '', status: 'error', error: frame.message })
  })
  controllers.set(session, controller)
  return controller
}

/** Whether a side question is in flight for this conversation. */
export function btwRunning(session: AgentSession): boolean {
  return controllers.has(session)
}

/**
 * Asks one side question.
 *
 * The controller refuses a second question while one is running, with its own words; the caller
 * does not need a second guard.
 */
export async function askBtw(
  session: AgentSession,
  question: string,
  emit: BtwEmit,
): Promise<void> {
  await controllerOf(session, emit).ask(question)
}

/** One follow-up in the same topic. */
export async function continueBtw(
  session: AgentSession,
  question: string,
  recordId: string,
  emit: BtwEmit,
): Promise<void> {
  await controllerOf(session, emit).ask(question, recordId)
}

/** Cancels the running or starting question; false when there was none. */
export function cancelBtw(session: AgentSession): boolean {
  return controllers.get(session)?.cancel() ?? false
}

/** Tells the panel to drop what it is showing. */
export function clearBtw(session: AgentSession, emit: BtwEmit): void {
  controllers.delete(session)
  emit({ type: 'btw', kind: 'cleared' })
}

/** The newest topics, oldest first, for `/btw` with no question. */
export async function btwHistory(
  session: AgentSession,
  emit: BtwEmit,
): Promise<readonly { question: string; answer: string; status: string }[]> {
  const records = await controllerOf(session, emit).history()
  return [...records].reverse().map((record) => ({
    question: record.question,
    answer: record.answer,
    status: record.status,
  }))
}

/** Before the session is replaced or the process exits: land every checkpoint. */
export async function closeBtw(session: AgentSession): Promise<void> {
  const controller = controllers.get(session)
  if (controller === undefined) return
  controllers.delete(session)
  await controller.close().catch(() => {
    // Closing a side conversation is best-effort at teardown; the session it belonged to is going
    // away, and failing the teardown over an unsaved side answer would lose more than the answer.
  })
}
