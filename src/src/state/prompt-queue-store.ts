/**
 * The queue of prompts a reader wrote while the agent was still working, as this process holds it.
 *
 * One store, one list, and every writer going through the rules in `prompt-queue.ts`: this file is
 * the binding, not a second set of rules. The id counter lives here because it is the store's own
 * bookkeeping — the rules only need ids to be stable, not where they come from.
 */

import { createStore } from './store.ts'
import type { ChatAttachmentRef } from '@/api/session-types'
import {
  dropQueuedPrompt,
  enqueuePrompt,
  forgetQueuedPrompts,
  queuedFor,
  requeuePrompt,
  takeQueuedHead,
  type QueuedPrompt,
} from './prompt-queue.ts'

export {
  MAX_QUEUED_PROMPTS,
  resolveSubmitMode,
  type ComposerSubmitGesture,
  type QueuedPrompt,
  type SubmitMode,
} from './prompt-queue.ts'

export const promptQueueStore = createStore<readonly QueuedPrompt[]>([])

let nextId = 0

/**
 * Hold one message until its session's turn ends. False when that session's queue is full.
 *
 * The files are copied into the row: the composer's own list is replaced the moment the message is
 * queued, and a row that pointed at the list it came from would be a row whose files left with the
 * draft.
 */
export function enqueuePromptFor(
  sessionId: string,
  text: string,
  attachments: readonly ChatAttachmentRef[],
): boolean {
  nextId += 1
  const next = enqueuePrompt(promptQueueStore.get(), sessionId, text, [...attachments], nextId)
  if (next === null) {
    nextId -= 1
    return false
  }
  promptQueueStore.set(next)
  return true
}

/**
 * The row one turn's end releases: the session's head, oldest first, released to the caller.
 *
 * Null is a session with nothing waiting — which is also what a second call for the same turn end
 * answers, because taking the head is the release.
 */
export function takeQueuedHeadFor(sessionId: string): QueuedPrompt | null {
  const { head, queue } = takeQueuedHead(promptQueueStore.get(), sessionId)
  if (head === null) return null
  promptQueueStore.set(queue)
  return head
}

/** One named row, taken out of the queue; null when it is no longer waiting. */
export function takeQueuedPromptById(id: number): QueuedPrompt | null {
  const queue = promptQueueStore.get()
  const taken = queue.find((prompt) => prompt.id === id) ?? null
  if (taken === null) return null
  promptQueueStore.set(dropQueuedPrompt(queue, id))
  return taken
}

/** Put a taken row back at its session's head; the press that took it never got to send it. */
export function requeuePromptFor(row: QueuedPrompt): void {
  promptQueueStore.set(requeuePrompt(promptQueueStore.get(), row))
}

export function removeQueuedPrompt(id: number): void {
  promptQueueStore.set(dropQueuedPrompt(promptQueueStore.get(), id))
}

/** Forget a session's queue entirely; the session's own release path calls this. */
export function clearQueuedPrompts(sessionId: string): void {
  promptQueueStore.set(forgetQueuedPrompts(promptQueueStore.get(), sessionId))
}

/** The messages queued for one session, for a component that renders them. */
export function queuedPromptsFor(
  queue: readonly QueuedPrompt[],
  sessionId: string | null,
): readonly QueuedPrompt[] {
  return sessionId === null ? [] : queuedFor(queue, sessionId)
}

/**
 * Whether a session is holding messages the reader is waiting to have sent.
 *
 * The session store asks this before it sheds a conversation: a queue is work the reader has already
 * asked for, so a conversation carrying one is not recyclable. That is what bounds the queue — at
 * most `RETAINED_RECORDS` conversations, each holding at most `MAX_QUEUED_PROMPTS` — and it is why
 * the release point is the conversation's own (`clearQueuedPrompts`, called where the record goes).
 */
export function hasQueuedPrompts(sessionId: string): boolean {
  return promptQueueStore.get().some((prompt) => prompt.sessionId === sessionId)
}
