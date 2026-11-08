/**
 * The questions a plugin page's bridge call leaves open, and the answers the reader gives them.
 *
 * A bridge call that needs a decision — a file outside the declared scope, the clipboard used for
 * the first time — is parked on the desktop's side until this card answers it
 * (`services::plugins::prompt`, spec §6.3). The call itself is already waiting; this module owns
 * only what is on screen and which answer is sent back.
 *
 * Three rules, the same ones the desktop enforces on its side:
 *
 * - **No answer is a denial.** The desktop times the question out and treats the silence as `deny`;
 *   a card that arrives after that is answered `false` (the question is gone) and dropped here.
 * - **One question, one answer.** The card disappears the moment it is answered, and the answer
 *   carries its own reach: `deny`, this one call (`once`), or this installation for the rest of the
 *   process (`session`).
 * - **Bounded.** The desktop admits at most eight open questions; this store keeps the same bound
 *   and shows the oldest one first, so a page cannot stack cards over the conversation.
 */

import { useSyncExternalStore } from 'react'

import { answerPluginPrompt } from '@/api/plugins'
import type { PluginPromptEvent } from '@/api/plugins-types'
import { createStore } from '@/state/store'

/** Where one question is in the reader's hands. */
export type PluginPromptAnswer = 'deny' | 'once' | 'session'

const promptStore = createStore<readonly PluginPromptEvent[]>([])

/** Add one question unless the same id is already on screen; the oldest stays at the front. */
export function showPluginPrompt(prompt: PluginPromptEvent): void {
  promptStore.set((previous) =>
    previous.some((open) => open.id === prompt.id) ? previous : [...previous, prompt],
  )
}

/**
 * Answer the question on screen and take it down.
 *
 * The card leaves whether or not the desktop still held the question: `false` means the call already
 * gave up (or the installation was re-published), and keeping a card that addresses nothing is
 * worse than dropping it.
 */
export async function answerPluginPromptCard(id: number, answer: PluginPromptAnswer): Promise<void> {
  promptStore.set((previous) => previous.filter((open) => open.id !== id))
  try {
    await answerPluginPrompt(id, answer)
  } catch {
    // The question is gone either way; the call it was parked on reads a closed channel as denied.
  }
}

/** The questions on screen, oldest first. */
export function usePluginPrompts(): readonly PluginPromptEvent[] {
  return useSyncExternalStore(promptStore.subscribe, promptStore.get, promptStore.get)
}
