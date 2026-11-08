/**
 * Giving back the input a stop withdrew.
 *
 * A stop withdraws the engine's steering/follow-up queue before it aborts, because a message left
 * there is a turn the engine starts the moment the abort unwinds (`AbortOutcome.restored`). The
 * words are the reader's own - they wrote them, and they were never delivered to the model - so the
 * screen returns them instead of dropping them: the row they occupied was a local echo of a prompt
 * that never left (`transcript.ts::withdrawLocalPrompts`), and the composer is where it belongs,
 * the same place the engine's own terminal puts a queue it clears on Esc.
 *
 * The two halves stay together. A withdrawn prompt that carried files gets its chips back, and the
 * files are re-imported through the composer's own path, so a card can never name a file whose
 * record is gone (`state/composer-draft-store.ts` keeps the two written as one draft).
 */

import { addAttachmentPaths } from '@/state/composer-attachments'
import {
  appendComposerDraftChips,
  conversationDraftKey,
  readComposerDraft,
  setComposerDraftText,
} from '@/state/composer-draft-store'
import { sessionStore, setRecord } from '@/state/session-record'
import { withdrawLocalPrompts } from '@/state/transcript'

/**
 * Put one stop's withdrawn prompts back where the reader can send them again.
 *
 * The rows leave the transcript and the words go to the conversation's own draft, ahead of whatever
 * was typed while the stop was in flight - they were written first. The files follow through the
 * composer's import, so a path that vanished in between is simply not restored (its words still
 * are) rather than producing a chip nothing renders.
 */
export function restoreWithdrawnPrompts(sessionId: string, texts: readonly string[]): void {
  const restored = texts.map((text) => text.trim()).filter((text) => text !== '')
  if (restored.length === 0) return
  const record = sessionStore.get().records[sessionId]
  if (record === undefined) return
  const key = conversationDraftKey(record)
  let paths: string[] = []
  setRecord(sessionId, (current) => {
    const withdrawn = withdrawLocalPrompts(current.messages, restored)
    paths = withdrawn.paths
    if (withdrawn.messages.length === current.messages.length) return current
    return { ...current, messages: withdrawn.messages }
  })
  const body = restored.join('\n\n')
  const draft = readComposerDraft(key)
  setComposerDraftText(key, draft.text.trim() === '' ? body : `${body}\n\n${draft.text}`)
  if (paths.length === 0) return
  void addAttachmentPaths(key, paths)
    .then((imported) => {
      if (imported.added.length === 0) return
      appendComposerDraftChips(key, imported.added.map((attachment) => attachment.token).join(''))
    })
    .catch(() => {
      // The words are back either way; a file the desktop could not re-read is reported by the
      // composer's own import path when the reader sends the restored prompt.
    })
}
