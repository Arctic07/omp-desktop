/**
 * Handing queued prompts over, and the head row the reader interrupts with.
 *
 * A prompt the reader wrote while the agent was working is not sent when they write it: it waits for
 * the turn to end, and one row leaves per turn — sending the head opens the next turn, and that
 * turn's own end is what brings the row after it. That rule is here rather than in the store because
 * it is about the queue's own traffic, and it is the part with state a component must never see.
 *
 * The head row has a second way out: the reader presses it, which ends the running turn and then
 * releases that row as the next one. Ending the turn first is what makes it a send rather than a
 * steer — `session_prompt` with `streamingBehavior: 'steer'` only joins the live run, and the engine
 * injects it at the next model-call or tool-batch boundary, so the answer already streaming keeps
 * coming (2026-10-29 reader report: "I bumped my queued message, the output above kept going").
 *
 * The send and the ending are injected rather than imported: this module would otherwise have to
 * reach into `session-send.ts`, which reaches back here for the promotion, and the two would be one
 * module with a cycle in it.
 */

import type { ChatAttachmentRef, StreamingBehavior } from '@/api/session-types'
import type { QueuedPrompt } from './prompt-queue.ts'
import {
  requeuePromptFor,
  takeQueuedHeadFor,
  takeQueuedPromptById,
} from './prompt-queue-store.ts'

/** One prompt on its way to the engine: the store's own send, with its row and its failure handling. */
export type PromptSender = (
  sessionId: string,
  text: string,
  attachments: ChatAttachmentRef[],
  behavior: StreamingBehavior | null,
) => Promise<void>

/**
 * Ending one conversation's running turn, so a row the reader pressed can go out behind it.
 *
 * Resolves once that turn is over — the host answers an abort only when the engine is idle — and
 * rejects when it could not be ended; the row then belongs back in the queue, unsent.
 */
export type TurnInterrupter = (sessionId: string) => Promise<void>

/**
 * The conversations with a queued row being handed over right now.
 *
 * A delivery is a round trip wide, and the queue's own promotion and the reader's press can both
 * want a row, so one delivery per conversation at a time: a second prompt racing the first into the
 * same turn is not the order the reader wrote.
 */
const delivering = new Set<string>()

/** Conversations whose turn ended while a delivery was still on its way. */
const reArm = new Set<string>()

/** Conversations ending a turn so that the row the reader pressed can go out right after it. */
const interrupting = new Set<string>()

/**
 * Hand over one row, with the conversation's delivery guard held for the whole send.
 *
 * A turn that ended while this row was on its way is this row's own turn — the thing the queue was
 * waiting for has happened — so the row after it goes out as soon as the send returns. That is what
 * keeps the queue moving when a turn is shorter than a round trip.
 */
async function deliverRow(
  sessionId: string,
  row: QueuedPrompt,
  send: PromptSender,
): Promise<void> {
  delivering.add(sessionId)
  try {
    await send(sessionId, row.text, [...row.attachments], null)
  } finally {
    delivering.delete(sessionId)
  }
  if (reArm.has(sessionId)) await deliverQueuedPrompts(sessionId, send)
}

/**
 * Hand a conversation's queue head over, now that the turn it waited for has ended.
 *
 * One row per turn end, in order: sending the head opens the next turn, and that turn's own end is
 * what brings the row after it. The row leaves the queue as the send starts, so the reader's own row
 * in the transcript is its record from then on — and a refused prompt is reported beside that row
 * rather than left waiting for a turn end that may never come.
 */
export async function deliverQueuedPrompts(sessionId: string, send: PromptSender): Promise<void> {
  if (delivering.has(sessionId)) {
    reArm.add(sessionId)
    return
  }
  // Consuming the re-arm is what makes it mean one turn: each end of a turn releases exactly one row.
  reArm.delete(sessionId)
  const head = takeQueuedHeadFor(sessionId)
  if (head === null) return
  await deliverRow(sessionId, head, send)
}

/**
 * End the running turn, then release one queued row as the next one — the reader's press on the
 * queue's head row.
 *
 * False when the row is no longer waiting, or when this conversation already has a delivery or an
 * interrupt on its way: the press asked for one row leaving now, and a second act racing the first
 * is not what it said.
 *
 * The row leaves the queue before the turn is ended and returns to its head if that ending fails: a
 * press the engine never got to act on must leave the words where the reader wrote them.
 */
export async function interruptQueuedPrompt(
  sessionId: string,
  id: number,
  interrupt: TurnInterrupter,
  send: PromptSender,
): Promise<boolean> {
  if (delivering.has(sessionId) || interrupting.has(sessionId)) return false
  const row = takeQueuedPromptById(id)
  if (row === null) return false
  interrupting.add(sessionId)
  try {
    try {
      await interrupt(sessionId)
    } catch (error) {
      requeuePromptFor(row)
      throw error
    }
    await send(sessionId, row.text, [...row.attachments], null)
    return true
  } finally {
    interrupting.delete(sessionId)
  }
}
