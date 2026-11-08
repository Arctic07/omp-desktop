/**
 * The preview cache, bound to the desktop and to React.
 *
 * A chip's hover mounts the card that shows what it holds (`components/agents/attachment-preview-card.tsx`),
 * the read happens here once per path, and the answer lands in a store so every chip naming that file
 * draws from the one read. Nothing is read on mount of a *chip*: a conversation can hold a dozen image
 * chips, and reading them all for a pointer that may never touch one is the cost this store exists to
 * avoid.
 *
 * A failure is cached as `null` rather than retried. The card's answer to "no picture" is to say where
 * the file lives instead, so a file the desktop refuses is a fact worth keeping — a retry would be a
 * second round trip for a pointer crossing the same chip again.
 */

import { readExternalFile } from '@/api/agent'
import { withPreview, type AttachmentPreview } from '@/state/attachment-preview'
import { createStore } from '@/state/store'

export const attachmentPreviewStore = createStore<ReadonlyMap<string, AttachmentPreview>>(new Map())

/**
 * The paths with a read on its way.
 *
 * A pointer entering a chip twice before the answer arrives would otherwise start a second read of
 * the same file, which is the one thing the cache cannot dedupe until the first answer lands.
 */
const reading = new Set<string>()

/**
 * Ask the desktop for one attachment's bytes, unless it has been asked already.
 *
 * Deliberately fire-and-forget: the caller is a pointer gesture, and there is nothing for it to do
 * with a failure — the chip shows no preview, which is what a failed read means here.
 */
export function requestAttachmentPreview(path: string): void {
  if (path.length === 0) return
  if (attachmentPreviewStore.get().has(path) || reading.has(path)) return
  reading.add(path)
  void readExternalFile(path)
    .then((file) => {
      // Only an image answers with a picture; a read that came back as text is not one to draw.
      attachmentPreviewStore.set((cache) => withPreview(cache, path, file.dataUrl ?? null))
    })
    .catch(() => {
      attachmentPreviewStore.set((cache) => withPreview(cache, path, null))
    })
    .finally(() => {
      reading.delete(path)
    })
}
