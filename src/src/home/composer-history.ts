/**
 * The prompts of one conversation, newest first: what Up and Down walk in the composer.
 *
 * The transcript already holds every prompt the reader sent, with the files it carried where they
 * stood in the sentence, so history needs no second store: the same rows the feed draws are the
 * rows a recall restores. What is left here is the reading — engine-injected notices are not the
 * reader's words, an empty prompt is nothing to recall, and a prompt repeated back to back is one
 * entry rather than two (the same rule the engine's own input history applies).
 */

// Types are erased; the one runtime import is relative with its extension, because this module is
// read by the test runner as well as by the bundler and the runner has no alias to resolve.
import type { ChatAttachmentRef, ChatMessage } from "../api/session-types.ts";
import type { ComposerAttachment } from "../state/composer-draft.ts";
import { messageProse } from "./system-notice.ts";

/** One earlier prompt, as the composer should hold it again. */
export interface ComposerHistoryEntry {
  /** The reader's own words, engine notices removed, chip characters still in place. */
  text: string
  /** The files the prompt carried, in the order the words name them. */
  attachments: ChatAttachmentRef[]
}

/**
 * Read a conversation's prompts, newest first.
 *
 * A message that is nothing but files has no words and is still a prompt, so it is kept: the
 * attachments are the whole of it. A message whose text is only an engine notice — a reminder, a
 * delivery — is not something the reader wrote and is left out; an emphasized block is the reader's
 * own words with the model's markup around them, so its body comes back (`messageProse`).
 */
export function composerHistory(messages: readonly ChatMessage[]): ComposerHistoryEntry[] {
  const entries: ComposerHistoryEntry[] = []
  let previousKey = ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.kind !== 'user') continue
    const text = messageProse(message.text).trim()
    if (text.length === 0 && message.attachments.length === 0) continue
    const key = `${text}\u0000${message.attachments.map((attachment) => attachment.path).join('\u0000')}`
    if (key === previousKey) continue
    previousKey = key
    entries.push({ text, attachments: message.attachments })
  }
  return entries
}

/**
 * One walk through the prompts already written.
 *
 * The entries are frozen when the walk starts, so a frame arriving mid-walk cannot move the prompt
 * under the reader; `saved` is what the box held before it began (the gate only lets an empty box
 * start one, which is why it is empty — the shape keeps the restore honest if that gate ever
 * widens).
 */
export interface HistoryWalk {
  entries: readonly ComposerHistoryEntry[]
  index: number
  saved: { text: string; records: readonly ComposerAttachment[] }
}

/** What one arrow did. */
export type HistoryStep =
  | { kind: 'ignore' }
  | { kind: 'keep' }
  | { kind: 'show'; walk: HistoryWalk; entry: ComposerHistoryEntry }
  | { kind: 'restore'; saved: HistoryWalk['saved'] }

/**
 * The arrow-key state machine: what Up or Down does to a walk.
 *
 * The gate is a terminal's own: a walk starts only from an empty box, then both arrows belong to it
 * until the reader walks back past the newest prompt (which puts the saved draft back) or edits the
 * draft (the caller ends the walk). At the oldest prompt Up is consumed and changes nothing — the
 * caret does not jump into the middle of a recalled prompt. Down with no walk is the caret's key.
 */
export function stepHistoryWalk(
  walk: HistoryWalk | null,
  entries: readonly ComposerHistoryEntry[],
  direction: 'up' | 'down',
  draft: HistoryWalk['saved'],
): HistoryStep {
  if (direction === 'up') {
    if (walk === null) {
      const newest = entries[0]
      if (draft.text.length > 0 || newest === undefined) return { kind: 'ignore' }
      return {
        kind: 'show',
        walk: { entries, index: 0, saved: draft },
        entry: newest,
      }
    }
    if (walk.index >= walk.entries.length - 1) return { kind: 'keep' }
    const index = walk.index + 1
    const entry = walk.entries[index]
    if (entry === undefined) return { kind: 'keep' }
    return { kind: 'show', walk: { ...walk, index }, entry }
  }
  if (walk === null) return { kind: 'ignore' }
  if (walk.index === 0) return { kind: 'restore', saved: walk.saved }
  const index = walk.index - 1
  const entry = walk.entries[index]
  if (entry === undefined) return { kind: 'keep' }
  return { kind: 'show', walk: { ...walk, index }, entry }
}
