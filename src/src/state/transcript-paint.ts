/**
 * How a transcript walk writes the rows it reports while it runs.
 *
 * The read used to answer once, with the whole conversation, so a long one arrived as one payload
 * and one render. It now reports a page at a time (`session_history` with `streamRows`), and this is
 * the rule that decides what each page may do to the rows on hand:
 *
 * - a page appends to what this walk painted;
 * - a page marked `reset` (the walk started over because a turn made its cursor stale) replaces
 *   them, because the rows read before it are not a prefix of the transcript any more;
 * - nothing at all is written once something *else* is in the rows. The reader can send a prompt
 *   while the walk runs, and its row is written locally; appending a page on top would replace that
 *   row. The walk then leaves the rows alone and the answer it ends with is merged instead.
 *
 * The pages are what the pane is drawn from *once the read is over* — `conversationPhase` holds the
 * loading mark while a read is in flight, so a page never reaches the screen on its own
 * (2026-11-05). What the walk buys is the final render: the rows are already on hand when the read
 * lands, so the conversation is drawn once instead of being parsed, merged and drawn in one frame.
 *
 * Pure on purpose: the rule is the part worth pinning down, and it is exercised without a desktop.
 */

import type { ChatMessage, HistoryChunk } from '@/api/session-types'

/** One page of rows as the walk reports it. */
type RowPage = Extract<HistoryChunk, { kind: 'rows' }>

/** What a walk has painted so far, and whether it may keep painting. */
export interface PaintedWalk {
  readonly rows: readonly ChatMessage[]
  readonly painting: boolean
}

/** The initial state of a walk that paints. */
export const EMPTY_PAINTED_WALK: PaintedWalk = { rows: [], painting: true }

/** One page's effect: the rows to show now (null: leave the screen alone), and the walk after it. */
export interface PaintedPage {
  readonly show: ChatMessage[] | null
  readonly walk: PaintedWalk
}

/** Apply one reported page to a walk. */
export function paintHistoryPage(
  onScreen: readonly ChatMessage[],
  walk: PaintedWalk,
  page: RowPage,
): PaintedPage {
  if (!walk.painting) return { show: null, walk }
  // The screen no longer holds exactly what this walk painted — a prompt was echoed locally, or a
  // merge wrote rows — so the walk stops painting rather than overwrite it.
  if (onScreen.length !== walk.rows.length) {
    return { show: null, walk: { rows: walk.rows, painting: false } }
  }
  if (page.reset === true) {
    const rows = [...page.messages]
    return { show: rows, walk: { rows, painting: true } }
  }
  if (page.messages.length === 0) return { show: null, walk }
  const rows = [...walk.rows, ...page.messages]
  return { show: rows, walk: { rows, painting: true } }
}
