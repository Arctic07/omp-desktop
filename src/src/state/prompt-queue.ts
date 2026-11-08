/**
 * What a submitted prompt does while a turn is already running — the rules, and nothing holding them.
 *
 * The engine's `session_prompt` takes one decision from this side: whether the message is injected
 * into the turn that is running now (`steer`). There is no third option — a plain prompt while a turn
 * runs is refused — so "wait for the turn to end" is a queue this side keeps, and that is the second
 * decision. The reader's preference (`busyBehavior`) picks which one plain Enter means, and the
 * Ctrl/Cmd chord is the other one.
 *
 * The queue is per session and bounded: a reader who sends faster than the agent works is holding a
 * handful of messages, not a backlog, and a composer that silently swallowed the ninth would be
 * worse than one that keeps the draft. So an enqueue answers whether it took the message, and a
 * refusal leaves the words in the field.
 *
 * Every function here takes the list and returns the next one; the store that holds it is
 * `prompt-queue-store.ts`. Keeping the rules separate is what makes them testable without a DOM,
 * which is the same seam `transcript.ts` and `session-store.ts` are split along.
 */

import type { BusyBehavior } from './app-settings'
import type { ChatAttachmentRef } from '@/api/session-types'

/** What one submitted prompt does right now. */
export type SubmitMode = 'send' | 'queue' | 'steer'

/**
 * Which chord asked for a submission: plain Enter — which is also the send control, since a press on
 * it delivers exactly what Enter would — or its Ctrl/Cmd chord.
 */
export type ComposerSubmitGesture = 'enter' | 'accelerated'

/**
 * The preference, read against the turn that is running and the chord that asked.
 *
 * With nothing running there is nothing to decide: both chords are a plain prompt. While a turn runs,
 * the reader's choice says what plain Enter means — wait for the turn to end, or interrupt it — and
 * the Ctrl/Cmd chord takes the other mode, so the gesture that was not chosen is still reachable
 * without leaving the keyboard.
 */
export function resolveSubmitMode(
  preferred: BusyBehavior,
  running: boolean,
  gesture: ComposerSubmitGesture,
): SubmitMode {
  if (!running) return 'send'
  if (gesture === 'enter') return preferred === 'interrupt' ? 'steer' : 'queue'
  return preferred === 'interrupt' ? 'queue' : 'steer'
}

export interface QueuedPrompt {
  /** Stable per message, so a row can be removed while its neighbours stay. */
  id: number
  sessionId: string
  text: string
  /**
   * The files the message carries.
   *
   * They belong to the row rather than to the composer that wrote it: the composer's own list is
   * cleared the moment the message is queued — it is no longer the draft on screen — and the prompt
   * that goes out at its turn's end is the prompt as it was written, files and all.
   */
  attachments: readonly ChatAttachmentRef[]
}

/**
 * How many messages one session may hold.
 *
 * Bounded on purpose (`rules.md#resource-bounds-and-release-points`): the queue is a short-lived buffer between a fast reader and a
 * slow turn, so its ceiling is small and its release point is the drain that empties it.
 */
export const MAX_QUEUED_PROMPTS = 8

/** The messages queued for one session, oldest first. */
export function queuedFor(
  queue: readonly QueuedPrompt[],
  sessionId: string,
): readonly QueuedPrompt[] {
  return queue.filter((prompt) => prompt.sessionId === sessionId)
}

/** Hold one message until its session's turn ends. Null when that session's queue is full. */
export function enqueuePrompt(
  queue: readonly QueuedPrompt[],
  sessionId: string,
  text: string,
  attachments: readonly ChatAttachmentRef[],
  id: number,
): QueuedPrompt[] | null {
  if (queuedFor(queue, sessionId).length >= MAX_QUEUED_PROMPTS) return null
  return [...queue, { id, sessionId, text, attachments }]
}

/**
 * The one row a turn's end releases — the session's head, oldest first — and the queue without it.
 *
 * Exactly one, because sending the head opens the next turn and that turn's own end is what brings
 * the row after it: the queue moves at the pace of the turns, not at the pace of the reader. Taking
 * is also the release, so the same turn ending twice finds the queue one row shorter rather than the
 * same row twice. Null is a session with nothing waiting.
 */
export function takeQueuedHead(
  queue: readonly QueuedPrompt[],
  sessionId: string,
): { head: QueuedPrompt | null; queue: QueuedPrompt[] } {
  const head = queue.find((prompt) => prompt.sessionId === sessionId) ?? null
  if (head === null) return { head: null, queue: [...queue] }
  return { head, queue: queue.filter((prompt) => prompt.id !== head.id) }
}

/**
 * Put a taken row back at its session's head.
 *
 * Taking is the release (`prompt-queue-store.ts::takeQueuedPromptById`), so a press that ends
 * without a send hands the row back itself. The head rather than the tail: only the head can be
 * taken that way, so that is the place the reader wrote it.
 */
export function requeuePrompt(queue: readonly QueuedPrompt[], row: QueuedPrompt): QueuedPrompt[] {
  const at = queue.findIndex((prompt) => prompt.sessionId === row.sessionId)
  if (at === -1) return [...queue, row]
  return [...queue.slice(0, at), row, ...queue.slice(at)]
}

export function dropQueuedPrompt(queue: readonly QueuedPrompt[], id: number): QueuedPrompt[] {
  return queue.filter((prompt) => prompt.id !== id)
}

/** Forget a session's queue entirely; the session's own release path calls this. */
export function forgetQueuedPrompts(
  queue: readonly QueuedPrompt[],
  sessionId: string,
): QueuedPrompt[] {
  return queue.filter((prompt) => prompt.sessionId !== sessionId)
}
