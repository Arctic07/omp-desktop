/**
 * Which attachment the reader is looking at full-size.
 *
 * The hover card (`components/agents/attachment-preview-card.tsx`) is a glance: 256 pixels tall, and
 * a picture whose text or fine detail cannot be read at that size. The viewer it opens is the
 * answer to that — the same file's own bytes, at the size the window allows — and the two chips that
 * can open it (the composer's box and a sent message's bubble) sit in different trees, so the open
 * one is held here rather than in either of them. The overlay itself is mounted once, by the shell
 * (`App.tsx`), so both surfaces raise the same one.
 *
 * The bytes are not held here: a preview is a file's contents and belongs to the one cache that
 * bounds them (`state/attachment-preview-store.ts`), which the viewer asks exactly as the card does.
 */

import type { ChatAttachmentRef } from '@/api/session-types'
import { createStore } from '@/state/store'

/** The attachment on screen, or null when no viewer is open. */
export const attachmentViewerStore = createStore<ChatAttachmentRef | null>(null)

/** Show one file's picture over the window. */
export function openAttachmentViewer(attachment: ChatAttachmentRef): void {
  attachmentViewerStore.set(attachment)
}

/** Fold the viewer away. */
export function closeAttachmentViewer(): void {
  attachmentViewerStore.set(null)
}
