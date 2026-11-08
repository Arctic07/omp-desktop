/**
 * The actions a conversation's own surfaces ask for: fork it, rewind it, delete it, rename it.
 *
 * They live beside the store rather than inside it because each of them is a command plus the
 * record and list writes that follow, while the store owns the record's *life* (opening, adopting,
 * releasing). The split is what keeps both files under the line budget `rules.md#single-file-line-limit` sets, and
 * the dependency stays one-way: this module reads the store, the store never reads this one.
 */

import { toApiError } from '@/api/client'
import {
  sessionBranchFrom,
  sessionDelete,
  sessionRename,
  sessionRewind,
} from '@/api/agent'
import { reportClientError } from '@/lib/client-errors'
import { forgetSessionActivity } from '@/state/session-activity'
import { forgetComposerDraft } from '@/state/composer-draft-store'
import { clearQueuedPrompts } from '@/state/prompt-queue-store'
import { forgetVisit } from '@/state/session-visits'
import {
  findSummary,
  loadSessionList,
  markSessionSeenNow,
  refreshSessionRow,
  setWorkspaceSessions,
} from '@/state/session-lists'
import {
  keepWarm,
  openConversation,
  openNewConversationIn,
  pinOpeningSeat,
  sessionStore,
} from '@/state/session-store'
import { noteFailure, setRecord } from '@/state/session-record'
import { stopListening, walkTranscript } from '@/state/session-stream'
import { rewindCutIndex } from '@/state/transcript'

/**
 * One fork at a time, for the whole application.
 *
 * A fork moves the session's own leaf and copies the conversation into a file of its own, so two of
 * them in flight would have the second one forking a conversation the first has already replaced.
 * The refusal is silent here because it is not a failure: the reader's first ask is being carried
 * out, and the surface that asked is the one that shows it is busy.
 */
let branching = false

/**
 * Carry a conversation on from one of its own outputs.
 *
 * The engine forks it: the session's leaf moves onto that entry and the conversation is copied into
 * a file of its own, so the one being read keeps every message it had and a second conversation
 * appears, ending where the reader pointed. Nothing is re-sent, so no draft is parked — the screen
 * simply moves to the conversation the fork produced, and the rail gains its row.
 *
 * A refusal — the engine is mid-turn, the entry is not a point it accepts — is written onto that
 * conversation's own notices, where the reader is already looking.
 */
export async function continueFromEntry(sessionId: string, entryId: string): Promise<boolean> {
  const record = sessionStore.get().records[sessionId]
  if (branching || record === undefined) return false
  branching = true
  try {
    const branched = await sessionBranchFrom(sessionId, entryId)
    pinOpeningSeat(branched.sessionId, true)
    await openConversation(record.workspaceId, branched.sessionFile, branched.sessionId)
    // The conversation the fork produced is a file the rail has not seen: the list carries a row per
    // file, and without this read the reader's new conversation would be on screen and nowhere else.
    // The row is marked read before it lands, and again after: the fork copies the ending of the
    // conversation it came from, and a reader who just acted in this conversation should not find
    // its row carrying that ending as a mark (an amber "cancelled" on a fork of a stopped turn).
    markSessionSeenNow(branched.sessionId)
    await refreshSessionRow(record.workspaceId, branched.sessionId)
    return true
  } catch (error) {
    noteFailure(sessionId, toApiError(error))
    return false
  } finally {
    branching = false
  }
}

/**
 * Take a conversation back to just before one of its user messages.
 *
 * The engine moves the conversation's active branch to end before the message **inside the same
 * session**: the message and the output after it leave what the reader continues with, while the
 * conversation keeps its id, its file, its title and its one row in the list. The screen therefore
 * stays where it is and rebuilds the rows instead of following a new identity.
 *
 * The rows that stay are the prefix the reader already sees, so they are cut here rather than
 * emptied: the rewrite leaves the file holding the dropped entries as an off-branch sibling of the
 * session tree, and a merge would keep any row the read no longer reports — which is why the rows
 * are dropped before the read. Dropping them *to the cut* is what keeps the column a conversation:
 * an empty record is the hero, and the reader saw the new-conversation page flash under the
 * confirmation they had just accepted (2026-11-02, user report).
 *
 * A refusal — a running turn, a message the engine no longer holds — is written onto the
 * conversation's own notices.
 */
export async function rewindToEntry(
  sessionId: string,
  target: { entryId?: string; at?: number },
): Promise<boolean> {
  const state = sessionStore.get()
  const record = state.records[sessionId]
  if (branching || record === undefined) return false
  branching = true
  try {
    await sessionRewind(sessionId, target)
    // The rows on screen at the moment the cut lands. A read may have replaced them under the
    // dialog, and a target those rows no longer carry is not a prefix: the read that follows
    // rebuilds the branch instead.
    const held = sessionStore.get().records[sessionId]
    const cut = held === undefined ? null : rewindCutIndex(held.messages, target)
    setRecord(sessionId, (current) => {
      const messages = cut === null ? [] : current.messages.slice(0, cut)
      return {
        ...current,
        messages,
        // The branch the rewrite left. A cut that leaves nothing is the conversation every message
        // has been taken back out of, and the hero is the screen it becomes; a read still in flight
        // must not draw it as a conversation holding nothing. A prefix keeps the flag it had — the
        // draft seat the reader was writing in is keyed by it (`state/composer-draft-store.ts`).
        engineEmpty: cut !== null && messages.length === 0 ? true : current.engineEmpty,
        subagents: {},
        btw: null,
        // The ending described the turn this conversation just cut away; the rows it belonged to
        // are gone, and a note left behind would be attached to the wrong turn.
        lastTurn: null,
      }
    })
    // `merge` fills the gap a released listener may have left and leaves the prefix alone. The
    // fallback replaces the rows outright, because the ones on screen cannot be trusted as a
    // prefix.
    await walkTranscript(sessionId, cut === null ? 'replace' : 'merge')
    // The row reads its ending and its last-write time off the file, which the rewrite moved.
    await refreshSessionRow(record.workspaceId, sessionId)
    return true
  } catch (error) {
    noteFailure(sessionId, toApiError(error))
    return false
  } finally {
    branching = false
  }
}

/**
 * Remove a conversation, refresh the list it was in, and let go of it.
 *
 * **The screen is never left without a conversation.** Deleting the one on screen used to leave
 * `activeId` null, which the column draws as the hero and the composer as a locked field
 * (`home/ConversationComposer.tsx`'s `sendLocked` is `sessionId === null`): the reader got a "new
 * conversation" page whose send control did nothing, and nothing ever opened a conversation to
 * replace the deleted one (2026-11-01, user report: deleting the open conversation left its
 * replacement unable to send). The workspace's blank conversation is what takes its place — the same
 * screen a workspace opens on when it has nothing to reopen, and the same one the rail's own "new
 * conversation" asks for.
 */
export async function removeSession(workspaceId: number, sessionId: string): Promise<void> {
  const summary = findSummary(workspaceId, sessionId)
  if (!summary) return
  const wasOpen = sessionStore.get().activeId === sessionId
  await sessionDelete(summary.id, summary.filePath)
  keepWarm(sessionId)
  forgetComposerDraft(sessionId)
  // The messages queued behind the deleted conversation's turn go with it: there is no turn for
  // them to follow any more, and a queue nothing can drain is a prompt aimed at a session that is
  // gone (the same release `state/session-store.ts::letGo` makes when a conversation is let go).
  clearQueuedPrompts(sessionId)
  stopListening(sessionId)
  forgetSessionActivity(sessionId)
  forgetVisit(sessionId)
  sessionStore.set((state) => {
    const records = { ...state.records }
    delete records[sessionId]
    return {
      ...state,
      records,
      activeId: state.activeId === sessionId ? null : state.activeId,
      openStatus: state.activeId === sessionId ? 'idle' : state.openStatus,
      openingSeat: state.openingSeat === sessionId ? null : state.openingSeat,
    }
  })
  await loadSessionList(workspaceId)
  // The reader may have picked another conversation while the delete and the list read were in
  // flight. `wasOpen` says where they were when they asked; the screen is asked again here. A
  // conversation being opened is `activeId: null` with `openStatus: 'opening'`, which is why the
  // status is part of the test: a cold open is a navigation, not an empty screen.
  const screen = sessionStore.get()
  if (wasOpen && screen.activeId === null && screen.openStatus !== 'opening') {
    try {
      await openNewConversationIn(workspaceId)
    } catch (error) {
      // The deleted conversation is gone either way; the replacement screen is the half that failed,
      // and the workspace's own error surface reports openings elsewhere.
      reportClientError('delete: the replacement conversation could not be opened', error)
    }
  }
}

/** Rename a conversation from its rail row. */
export async function renameSessionById(
  workspaceId: number,
  sessionId: string,
  name: string,
): Promise<void> {
  await sessionRename(sessionId, name)
  setWorkspaceSessions(workspaceId, (current) => ({
    status: current?.status ?? 'ready',
    error: current?.error ?? null,
    items: (current?.items ?? []).map((row) =>
      row.id === sessionId ? { ...row, title: name } : row,
    ),
  }))
  setRecord(sessionId, (record) => ({ ...record, title: name }))
}
