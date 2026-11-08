/**
 * A draft another surface asks the composer to hold next.
 *
 * The composer's own text lives in the draft store (`state/composer-draft-store.ts`), one entry per
 * conversation, so a hand-off is a write into the seat of the conversation it belongs to — and the
 * box picks it up the moment that conversation is the one on screen. Two surfaces write here: the
 * Skills page's *New skill* entry opens a fresh task with `/skill:skill-creator` already in the box,
 * and a message taken back from the transcript goes back into the field as the draft it was written
 * as.
 *
 * The hand-off goes in front of anything already written rather than replacing it: the reader's
 * words are theirs, and a *New skill* that silently ate a half-written prompt would be the one
 * transition where this app lost something they typed. Focus is asked for separately, once, because
 * the composer may not be showing the target conversation yet.
 */

import { createStore } from '@/state/store'
import {
  addAttachmentPaths,
  MAX_COMPOSER_ATTACHMENTS,
  type AttachmentImport,
} from '@/state/composer-attachments'
import { draftFromMessage } from '@/state/composer-draft'
import {
  appendComposerDraftChips,
  composerDraftOf,
  composerDraftsStore,
  conversationDraftKey,
  putComposerDraft,
} from '@/state/composer-draft-store'
import { reportClientError } from '@/lib/client-errors'
import { sessionStore } from '@/state/session-store'
import type { ChatAttachmentRef } from '@/api/session-types'

/** Focus requests, counted rather than a flag: every hand-off is one request of its own. */
export const composerFocusStore = createStore(0)

/** Where a hand-off goes: the draft of the conversation on screen. */
function prefillSeat(): string {
  const state = sessionStore.get()
  const record = state.activeId === null ? null : (state.records[state.activeId] ?? null)
  return conversationDraftKey(record)
}

/** Put a hand-off's text in front of what the seat already holds. */
function withPrefill(prefix: string, previous: string): string {
  if (previous.trim() === '') return prefix
  if (prefix.trim() === '') return previous
  return `${prefix}\n${previous}`
}

/**
 * Put one file in the conversation on screen — the file tree's "add to conversation".
 *
 * The import is the composer's own (`state/composer-attachments.ts`), so the record, the chip
 * character and the draft are written together; the character is appended to the draft's end
 * because the pointer is in the file tree, not in the field, and the field reconciles itself with
 * the draft the moment it changes. Focus is asked for so the reader lands where the chip went.
 * A refusal is answered rather than thrown: the caller is a menu that has somewhere to say it.
 */
export async function attachFileToComposer(path: string): Promise<AttachmentImport> {
  const key = prefillSeat()
  const imported = await addAttachmentPaths(key, [path])
  if (imported.added.length > 0) {
    appendComposerDraftChips(key, imported.added.map((record) => record.token).join(''))
    composerFocusStore.set((requests) => requests + 1)
  }
  return imported
}

/** Ask the composer to hold `text` as its next draft. */
export function prefillComposer(text: string): void {
  const key = prefillSeat()
  const draft = composerDraftOf(composerDraftsStore.get(), key)
  putComposerDraft(key, withPrefill(text, draft.text), draft.attachments)
  composerFocusStore.set((requests) => requests + 1)
}

/**
 * Put a sent message back into the composer as the draft it was written as.
 *
 * A message taken back from the transcript is the same thing the reader once typed: its words, and
 * the files where they stood in them. The records are minted together with the string
 * (`state/composer-draft.ts::draftFromMessage`) so the chips are addressed by this draft, and both
 * halves are written into the seat in one step, which is what keeps the words and their files
 * together.
 *
 * The conversation is named rather than read off the screen: the rewrite that produces the message
 * is several round trips, and the reader may have moved to another conversation by the time it
 * lands. Writing into "the seat of the conversation on screen" there would hand one conversation's
 * message to the next — words the reader then sends to an agent that never saw them.
 */
export function prefillComposerDraft(
  sessionId: string,
  text: string,
  attachments: readonly ChatAttachmentRef[],
): void {
  const record = sessionStore.get().records[sessionId]
  if (record === undefined) {
    // The conversation was let go of while the rewrite was landing: there is no seat to hand the
    // words to, and inventing one would put them in front of whichever conversation is on screen.
    // The words are gone from the field, so the application's log is the only place this shows.
    reportClientError('composer prefill skipped: the conversation is no longer held', sessionId)
    return
  }
  const key = conversationDraftKey(record)
  const draft = composerDraftOf(composerDraftsStore.get(), key)
  const restored = draftFromMessage(
    text,
    attachments,
    Math.max(0, MAX_COMPOSER_ATTACHMENTS - draft.attachments.length),
  )
  putComposerDraft(
    key,
    withPrefill(restored.text, draft.text),
    [...draft.attachments, ...restored.attachments],
  )
  // Focus belongs to the conversation the reader is looking at: a hand-off into one they left must
  // not pull the caret (and the field's scroll) out from under the one they moved to.
  if (sessionStore.get().activeId === sessionId) composerFocusStore.set((requests) => requests + 1)
}
