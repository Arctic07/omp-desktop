/**
 * Where each conversation's reader left it.
 *
 * Kept beside the session store rather than inside it, and kept out of the store's own state on
 * purpose: the position changes on every pixel of a scroll, and a state write per pixel would redraw
 * the transcript the reader is scrolling. It is read once, when the pane for a conversation mounts.
 */

/** Where a reader left a conversation: how far down it was, and whether it was being followed. */
export interface ReaderPlace {
  /** Pixels from the top of the transcript. */
  scrollTop: number
  /** Whether the reader was at the live edge, which is what keeps the transcript following. */
  following: boolean
  /**
   * The row the reading line fell in, and how far its own top edge sat below the scrollport's.
   *
   * A long transcript is placed from its row model's offsets, and a freshly mounted window has
   * measured none of its rows: its offsets are estimates, so the pixel offset on its own would land
   * the reader on whatever the estimates happen to put there. The row and its edge are what the
   * landing is corrected against. A transcript whose rows are all drawn keeps this null: its offset
   * is the whole of it.
   */
  anchorId: string | null
  anchorTop: number
}

/** Where each conversation's reader left it, keyed by session id. */
const places = new Map<string, ReaderPlace>()

export function readerPlace(sessionId: string): ReaderPlace {
  return places.get(sessionId) ?? { scrollTop: 0, following: true, anchorId: null, anchorTop: 0 }
}

export function setReaderPlace(sessionId: string, patch: Partial<ReaderPlace>): void {
  const current = readerPlace(sessionId)
  places.set(sessionId, { ...current, ...patch })
}
