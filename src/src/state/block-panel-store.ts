/**
 * Which block above the composer is open.
 *
 * One store rather than each surface's own state because two places open the same panels: the pill
 * row above the field, and the mode chips inside it. A single id keeps the row's own rule - one
 * panel at a time - without either surface having to know the other.
 */

import { createStore } from './store'

/** The open block's id, or null when every panel is closed. */
export const blockPanelStore = createStore<string | null>(null)

/** The id the mode block for one mode has, so a chip and its block cannot drift apart. */
export const MODE_BLOCK_IDS = {
  goal: 'goal',
  plan: 'plan-mode',
  vibe: 'vibe',
  loop: 'loop',
} as const

export type ModeBlockKind = keyof typeof MODE_BLOCK_IDS

/** Opens one mode's block, or closes it when it is the one already open. */
export function toggleModeBlock(kind: ModeBlockKind): void {
  const id = MODE_BLOCK_IDS[kind]
  blockPanelStore.set((open) => (open === id ? null : id))
}

/** Closes whatever is open. */
export function closeBlockPanel(): void {
  blockPanelStore.set(null)
}
