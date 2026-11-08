/**
 * The conversations a workspace has, and which of them the reader has already seen.
 *
 * The rail reads a workspace as a list of its conversations, newest first, and every one of those
 * rows carries a status the reader may not have looked at yet. Both are the *index* of what is on
 * disk rather than the conversation itself: a row is read from `session_list`, a mark is written
 * through `session_mark_read`, and neither touches the transcript a pane draws. That is why they are
 * kept beside the session store rather than in it — the store holds the conversations this process
 * is reading, and this holds the list it is reading them from.
 *
 * It writes into the store's own state (`sessions`, `readMarks`) rather than keeping a copy: the rail
 * subscribes to the store, so a list that lived anywhere else would be a second source of truth for
 * what the rail draws.
 */

import type { ApiError } from '@/api/client'
import {
  sessionList,
  sessionMarkRead,
  sessionReadMarks,
  sessionSetArchived,
  sessionSetPinned,
} from '@/api/agent'
import type { SessionColdStatus, SessionSummary } from '@/api/session-types'
import { createListSequence } from '@/state/list-sequence'
import { noteSessionFile, noteSessionTitle, sessionStore } from '@/state/session-record'
import { rowWithSentMessage } from '@/state/session-rows'
import { isUnwritten } from '@/state/transcript'

/** One workspace's conversation list, as the rail reads it. */
export interface WorkspaceSessions {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: ApiError | null
  items: SessionSummary[]
}

/**
 * The order this workspace's answers are applied in: see `state/list-sequence.ts`.
 *
 * Owner: this module, one sequence for the process. Bound: one applied ticket per workspace the
 * rail has read (the workspaces it draws), and one issued ticket per read in flight or applied.
 */
const listSequence = createListSequence()

/**
 * Load one workspace's conversation list.
 *
 * The list is also the index of what is on disk, which is what a conversation that has no file on its
 * record is learned from — a conversation this process opened before the host had written one carries
 * none, and without it a return to that conversation would have nothing to open it by.
 */
export async function loadSessionList(workspaceId: number): Promise<void> {
  const ticket = listSequence.start()
  setWorkspaceSessions(workspaceId, (current) => ({
    status: 'loading',
    error: null,
    items: current?.items ?? [],
  }))
  try {
    const items = await sessionList(workspaceId)
    // An answer that a newer read has already superseded is the list as it was when this read
    // *started*: writing it would take rows back — the row of a conversation that began while this
    // scan was out, say — and nothing would put them back until the next read.
    if (!listSequence.accept(workspaceId, ticket)) return
    const rows = withHeldMessages(items)
    setWorkspaceSessions(workspaceId, () => ({ status: 'ready', error: null, items: rows }))
    for (const row of rows) {
      const record = sessionStore.get().records[row.id]
      if (record !== undefined && record.filePath === null) {
        noteSessionFile(row.id, row.filePath)
      }
      if (record !== undefined && row.title.trim() !== '') {
        noteSessionTitle(row.id, row.title)
      }
    }
  } catch (error) {
    if (!listSequence.accept(workspaceId, ticket)) return
    setWorkspaceSessions(workspaceId, (current) => ({
      status: 'error',
      error: error as ApiError,
      items: current?.items ?? [],
    }))
  }
}

/** Load every named workspace's list — what the rail needs before it can draw them. */
export async function loadSessionLists(workspaceIds: readonly number[]): Promise<void> {
  await Promise.all(workspaceIds.map((id) => loadSessionList(id)))
}

/**
 * The scanned rows as this side knows them, for the conversations it is holding itself.
 *
 * A scan reads the engine's files, and the engine's own acknowledgement comes back before its first
 * message reaches one of them: a read taken right after a send — or at the turn's start, which is
 * the other moment the rail asks — is the empty row the open created. Believing it hides a
 * conversation the reader is looking at until the turn's ending buys another read, which is the
 * report this answers (2026-10-26: a conversation showed up in the rail only after its first turn
 * was stopped). What this process holds is the message itself, so a row it says is written stays
 * written here — and keeps the newest message's time, which is what a row sorts by; the next scan,
 * taken after the engine wrote, answers on its own.
 */
function withHeldMessages(items: SessionSummary[]): SessionSummary[] {
  let corrected: SessionSummary[] | null = null
  items.forEach((row, index) => {
    const written = rowWithSentMessage(row, heldMessageAt(row.id))
    if (written === row) return
    corrected ??= items.slice()
    corrected[index] = written
  })
  return corrected ?? items
}

/** When the newest message this process holds in a conversation was written, if it holds one. */
function heldMessageAt(sessionId: string): number | null {
  const record = sessionStore.get().records[sessionId]
  if (record === undefined || isUnwritten(record.engineEmpty, record.messages)) return null
  return record.messages[record.messages.length - 1]?.at ?? null
}

/**
 * Record that the reader has just sent a message into a conversation, so it has a row and sorts by
 * the send.
 *
 * The rail draws a conversation from the moment it holds a message (`state/session-rows.ts`), and
 * the message is already known here: it was written into the record before the prompt went out.
 * Waiting for the next scan to say the same is what left a running conversation with no row at all —
 * the scan can only be asked once per turn, and the one at the turn's start arrives before the
 * engine's write. The row also carries the send's time, because the rail sorts by it and the list
 * is not re-read until the turn ends: without it, a conversation the reader just wrote in stays
 * below everything newer than its last turn (2026-10-29, user report). A conversation the list has
 * never carried is read once first, because a row has to exist before it can be corrected.
 */
export async function noteSessionWritten(
  workspaceId: number,
  sessionId: string,
  sentAt: number,
): Promise<void> {
  if (findSummary(workspaceId, sessionId) === undefined) await loadSessionList(workspaceId)
  setWorkspaceSessions(workspaceId, (current) => {
    if (current === undefined) return { status: 'idle', error: null, items: [] }
    const index = current.items.findIndex((row) => row.id === sessionId)
    if (index < 0) return current
    const written = rowWithSentMessage(current.items[index], sentAt)
    if (written === current.items[index]) return current
    const items = current.items.slice()
    items[index] = written
    return { ...current, items }
  })
}

export function setWorkspaceSessions(
  workspaceId: number,
  next: (current: WorkspaceSessions | undefined) => WorkspaceSessions,
): void {
  sessionStore.set((previous) => ({
    ...previous,
    sessions: {
      ...previous.sessions,
      [workspaceId]: next(previous.sessions[workspaceId]),
    },
  }))
}

/** The statuses the reader has already seen, so a row only marks what is new to them. */
export async function loadReadMarks(): Promise<void> {
  try {
    const marks = await sessionReadMarks()
    const readMarks: Record<string, number> = {}
    for (const mark of marks) readMarks[mark.sessionId] = mark.seenAt
    writeReadMarks(readMarks)
  } catch {
    // Without the marks every finished conversation marks as unread, which is a louder rail than
    // the truth but not a broken one; the read that failed is not worth an error banner.
  }
}

/** Record that the reader has seen a conversation at this moment (the host's clock). */
export async function markSessionRead(
  sessionId: string,
  status: SessionColdStatus,
): Promise<void> {
  writeReadMarks({ ...sessionStore.get().readMarks, [sessionId]: Date.now() })
  try {
    await sessionMarkRead(sessionId, status)
  } catch {
    // The mark is already on screen; a desktop that refused to record it only means the row will
    // mark again next time, which is the safe direction for this fact to fail in.
  }
}

/**
 * Record a watched ending *before* the workspace list is re-read.
 *
 * The list still carries the status from before the turn (usually `pending`), so waiting for the
 * refresh leaves the row marked "unfinished" for a frame or two — the amber flash a reader reported
 * on every normal completion (2026-10-21). The local mark is the same fact the refresh will write,
 * just earlier; the list read then replaces it with the engine's final status.
 */
export function markSessionSeenNow(sessionId: string): void {
  writeReadMarks({ ...sessionStore.get().readMarks, [sessionId]: Date.now() })
}

function writeReadMarks(readMarks: Record<string, number>): void {
  sessionStore.set((previous) => ({ ...previous, readMarks }))
}

/**
 * The list refresh in flight per workspace, and the rows that still have to be marked read.
 *
 * Several conversations can end in the same moment when they run side by side, and each ending asks
 * for the same read: one per workspace is enough for all of them. The set carries the endings that
 * arrived *while* a read ran, so a row whose status moved within that window is read once more
 * rather than reported with the status from before it. Owner: this module. Bound: one entry per
 * workspace being listened to (the rail's own list). Released: when its loop finishes.
 */
const refreshing = new Map<
  number,
  { done: Promise<void>; marks: Set<string>; again: () => void }
>()

/**
 * Refresh a workspace's list, then record a turn the reader watched as read.
 *
 * A turn that ends while its conversation is on screen — or one the reader stopped themselves — is
 * one they have already seen. The mark written when the conversation was opened still names the
 * status from before that turn, so without this the row turns unread (or amber, for an abort) the
 * moment the screen moves on. `watchedSessionId` is decided by the caller at the instant the turn
 * ended, not here: by the time the read lands the reader may already be in another conversation.
 *
 * A refresh already in flight is joined instead of starting a second scan of the same directory:
 * with several turns ending together, one read answers all of them. An ending that arrives mid-read
 * may not be in that read's statuses, so it buys one more pass rather than being reported stale.
 */
export async function refreshSessionRow(
  workspaceId: number,
  watchedSessionId: string | null,
): Promise<void> {
  const inFlight = refreshing.get(workspaceId)
  if (inFlight !== undefined) {
    if (watchedSessionId !== null) inFlight.marks.add(watchedSessionId)
    inFlight.again()
    return inFlight.done
  }
  const marks = new Set<string>(watchedSessionId === null ? [] : [watchedSessionId])
  let again = false
  const done = (async () => {
    do {
      again = false
      await loadSessionList(workspaceId)
      for (const sessionId of [...marks]) {
        marks.delete(sessionId)
        if (sessionStore.get().sessions[workspaceId]?.status !== 'ready') continue
        const summary = findSummary(workspaceId, sessionId)
        if (summary !== undefined) await markSessionRead(summary.id, summary.status)
      }
    } while (again || marks.size > 0)
  })()
  refreshing.set(workspaceId, { done, marks, again: () => { again = true } })
  try {
    await done
  } finally {
    if (refreshing.get(workspaceId)?.done === done) refreshing.delete(workspaceId)
  }
}

/** One conversation's row in a workspace's list, or nothing when the list does not carry it. */
export function findSummary(
  workspaceId: number,
  sessionId: string,
): SessionSummary | undefined {
  return (sessionStore.get().sessions[workspaceId]?.items ?? []).find(
    (row) => row.id === sessionId,
  )
}

/** The conversation a workspace should open on: the one most recently written to. */
export function newestSession(workspace: WorkspaceSessions | undefined): SessionSummary | null {
  if (!workspace?.items.length) return null
  // A conversation the reader put away is not the one a switch should land on: it left the list on
  // purpose, and opening it again would undo that with a click the reader never made.
  const open = workspace.items.filter((row) => !row.archived)
  if (!open.length) return null
  return [...open].sort((left, right) => right.updatedAt - left.updatedAt)[0]
}

/**
 * Pin or unpin one conversation, then read its workspace's list back.
 *
 * The flag is the host's own row (`store::session_flags`), so the list is re-read rather than
 * patched here: the same read is what another surface — the header menu, a rail row — sees, and a
 * local patch would be a second copy of the ordering rule. A refused write leaves the list as it
 * was, which is the honest answer: the row is still wherever it was.
 */
export async function setSessionPinned(
  workspaceId: number,
  sessionId: string,
  pinned: boolean,
): Promise<void> {
  await sessionSetPinned(sessionId, pinned)
  await loadSessionList(workspaceId)
}

/** Put one conversation away, or bring it back, then read its workspace's list back. */
export async function setSessionArchived(
  workspaceId: number,
  sessionId: string,
  archived: boolean,
): Promise<void> {
  await sessionSetArchived(sessionId, archived)
  await loadSessionList(workspaceId)
}

/**
 * The file a conversation is stored in, asked of the list when the record does not carry one.
 *
 * A conversation this process opened before the host had written its file has no file on its record
 * until something reads the list again; the list is the index of what is on disk, so that is where
 * the answer is.
 */
export async function fileOf(
  sessionId: string,
  workspaceId: number,
  known: string | null,
): Promise<string | null> {
  if (known !== null) return known
  let summary = findSummary(workspaceId, sessionId)
  if (!summary) {
    await loadSessionList(workspaceId)
    summary = findSummary(workspaceId, sessionId)
  }
  return summary?.filePath ?? null
}
