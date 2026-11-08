/**
 * Which conversations the rail draws, and where they sort.
 *
 * A conversation nothing has been sent in has no row: opening one writes its transcript file, so the
 * list would otherwise show a "New conversation" the reader never had — and it would sit there next
 * to the real ones until the empty file was handed back (2026-10-26, user report). The row appears
 * with the first message, which is the moment it becomes a conversation. The blank one is still
 * reachable where it belongs: the composer's own seat, the workspace's blank conversation, and the
 * "new conversation" action (`state/blank-seat.ts`).
 *
 * The same flag answers the question on the way out — whether a conversation may be handed back with
 * its file, which is only ever the draft's — so that reading is here too, beside the flag it reads.
 *
 * Pure so both the rail's projection (`home/sidebar-tree.ts`, covered by a Node test) and the rail's
 * own counters read the same answer.
 */

import type { ChatMessage, SessionSummary } from '../api/session-types.ts'
import { isUnwritten } from './transcript.ts'

export function isListedSession(session: { blank: boolean }): boolean {
  return !session.blank
}

/**
 * The row of a conversation this process has just sent a message into.
 *
 * `blank` is the engine's file talking: a transcript with no message entry in it. That is the truth
 * about what is on disk, but it is not the truth about what the reader did — sending answers before
 * the engine writes (`session_prompt` acknowledges, the turn runs behind it), so a row read in that
 * window is still the empty one the open created. Left alone, the conversation has no row until
 * some later read happens to follow the write: the reader reported a conversation that appeared in
 * the rail only once they stopped its first turn (2026-10-26).
 *
 * The time moves with it for the same reason, and for every message, not just the first: the rail
 * sorts by the row's last write, the list is only re-read when a turn ends, and the engine's file
 * time lags the send — so a conversation the reader had just written in stayed where it was until
 * the answer finished (2026-10-29, user report: "发完消息就要立刻排到上方去"). The message is the
 * reader's own and this side already holds it, so the row is marked written here and carries the
 * send's time; the next list read (the turn's own ending) replaces it with the engine's answer.
 *
 * Pure, and `null` for a conversation this process did not write in, so a scan's own answer is what
 * stands when there is nothing local to say.
 */
export function rowWithSentMessage(
  row: SessionSummary,
  sentAt: number | null,
): SessionSummary {
  if (sentAt === null) return row
  const updatedAt = row.updatedAt > sentAt ? row.updatedAt : sentAt
  if (!row.blank && updatedAt === row.updatedAt) return row
  return { ...row, blank: false, updatedAt }
}

/**
 * Whether letting go of a conversation may take its file with it.
 *
 * The file a conversation nothing was sent in leaves behind exists only because opening one writes
 * it, so asking for it to be handed back is what keeps the store from filling with drafts nobody
 * returned to. On a `true` the caller asks the host for `session_close` with `dropFile`, and the host
 * keeps the file unless it holds no message (`host/src/session-files.ts::closeConversation`) — this
 * answers an ask, not a deletion.
 *
 * **A record alone cannot answer it.** Rewinding a conversation to its first prompt cuts every row
 * out of the record — `engineEmpty` and no messages, indistinguishable from a draft — while the file
 * keeps the cut-away entries as an off-branch sibling of its session tree
 * (`state/session-actions.ts::rewindToEntry`). The list is what tells the two apart: a row's `blank`
 * is read from the file's own head (`src-tauri/src/services/session_index.rs`), so a transcript that
 * has been written to answers `false` however empty the branch the engine reports is.
 */
export function dropsFileOnRelease(
  record: { readonly engineEmpty: boolean; readonly messages: readonly ChatMessage[] },
  row: SessionSummary | undefined,
): boolean {
  // The one absence: a draft opened since the last scan has no row, and a row the list never read is
  // no claim either way — so the ask stands exactly as it did before this rule existed.
  const rowSaysBlank = row === undefined || row.blank
  return isUnwritten(record.engineEmpty, record.messages) && rowSaysBlank
}
