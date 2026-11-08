/**
 * The picture an image attachment shows on hover, as the rules of the cache that holds it.
 *
 * A preview is a data URL — the file's own bytes, base64 — so it is neither something to read for
 * every chip on screen nor something to keep without a ceiling. This module is the cache itself and
 * its bound; `attachment-preview-store.ts` is the binding that asks the desktop and holds the one
 * store. Keeping the two apart is the same seam `prompt-queue.ts` / `prompt-queue-store.ts` are
 * split along: the rules are testable without a window.
 *
 * A path is asked for once. The value is the data URL, or `null` for a read that failed, and a
 * `null` is kept as the answer it is — a file the desktop will not read is not asked for again every
 * time the pointer crosses the chip that names it.
 */

/**
 * How many previews are held.
 *
 * Owner: this module's cache in `attachment-preview-store.ts`. Bound: this many entries, oldest read
 * first out. Release point: the eviction below — the cache belongs to no conversation, so it is the
 * ceiling rather than a session that frees it. One composer's worth of files
 * (`MAX_COMPOSER_ATTACHMENTS`) plus the last message's chips is what the ceiling is for.
 */
export const MAX_ATTACHMENT_PREVIEWS = 12

/** One cached answer: the data URL, or null for a read that failed. */
export type AttachmentPreview = string | null

/** What is known about one path: a data URL, a failed read, or `undefined` for never asked. */
export function previewOf(
  cache: ReadonlyMap<string, AttachmentPreview>,
  path: string,
): AttachmentPreview | undefined {
  return cache.get(path)
}

/**
 * The cache with one answer added.
 *
 * A path already held moves to the end with its new value, so the entry that leaves when the cache
 * is full is the one read longest ago rather than the one that happened to be written first. A Map
 * keeps insertion order, which is what makes the eviction the first key.
 */
export function withPreview(
  cache: ReadonlyMap<string, AttachmentPreview>,
  path: string,
  preview: AttachmentPreview,
): ReadonlyMap<string, AttachmentPreview> {
  const next = new Map(cache)
  next.delete(path)
  next.set(path, preview)
  while (next.size > MAX_ATTACHMENT_PREVIEWS) {
    const oldest = next.keys().next()
    if (oldest.done) break
    next.delete(oldest.value)
  }
  return next
}
