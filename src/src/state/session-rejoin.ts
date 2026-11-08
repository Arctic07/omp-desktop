/**
 * Opening a conversation again: the return to a released one, and the recovery of a prompt the host
 * refused because it no longer held the session.
 *
 * Both are the same act — the record and the file it is stored in are still the reader's, so the
 * conversation is opened by file (the routing id is derived from that file) and its transcript is
 * merged under the rows already on screen — and both belong beside the store rather than inside it,
 * which owns the record's life but not this one open.
 *
 * A rejoin has two phases. The open — the listener, the session by file, the record it lands in —
 * is what the prompt recovery needs: a refused prompt is retried as soon as the session exists, not
 * after the history is read. The transcript merge follows the open and is what a return waits for;
 * it runs whether or not a caller is waiting, because the open left a hold open for it.
 */

import { sessionOpen } from '@/api/agent'
import { toApiError, type ApiError } from '@/api/client'
import { fileOf } from '@/state/session-lists'
import { pushNotice } from '@/state/transcript'
import { sessionStore, setRecord } from '@/state/session-record'
import {
  beginHold,
  endHold,
  ensureListening,
  stopListening,
  walkTranscript,
} from '@/state/session-stream'
import { provideSessionReopener } from '@/state/session-send'

/**
 * How many times each conversation has been released.
 *
 * A rejoin is asynchronous on three counts; the record it is for says when the visit it belongs to
 * has ended. `state/session-store.ts::letGo` bumps this, and every step of the rejoin that resumes
 * afterwards checks it, so work started for a visit the reader already left never writes into the
 * one that replaced it.
 *
 * Owner: this module. Bound: the conversations this process has visited, which is the session list
 * on disk. Released: with the process — a counter is deliberately not removed when its record is,
 * because an in-flight rejoin that captured the old value must still see a change.
 */
const releases = new Map<string, number>()

/** Note that a conversation was released, so a rejoin already on its way stops writing into it. */
export function bumpRelease(sessionId: string): void {
  releases.set(sessionId, (releases.get(sessionId) ?? 0) + 1)
}

/**
 * The rejoins in flight, by conversation, with both phases of each.
 *
 * `opened` resolves when the session exists again — the prompt recovery's one retry waits for it.
 * `done` resolves when the merge that follows has settled — a return waits for that. Keeping both
 * promises is what lets one open serve both callers without a second `sessionOpen`.
 *
 * Owner: this module. Bound: the conversations being opened. Released: when `done` settles.
 */
interface RejoinWork {
  readonly opened: Promise<boolean>
  readonly done: Promise<boolean>
}

const rejoining = new Map<string, RejoinWork>()

/**
 * Bring a conversation this screen had let go of back, and read what was written while it was away.
 *
 * Letting go of a conversation hands it back to the host — that is what keeps a bounded number of
 * them warm — and a session the host no longer holds cannot be read: the read is refused with "This
 * session is no longer open", which is exactly what a return to a released conversation used to hit,
 * because the return subscribed to a channel and walked a transcript without opening anything.
 *
 * So a return is a *rejoin*: the listener goes up first (the host publishes a session's own state and
 * its first frames the moment the open registers it, and nothing is replayed, so subscribing after
 * the answer would miss all of it), then the conversation is opened again by its file, and only then
 * is the transcript walked — as a merge, into the rows already on screen. The answer is whether that
 * open was made; a failure is reported on the record by {@link settleRejoinFailure}.
 */
export async function rejoin(sessionId: string): Promise<boolean> {
  return startRejoin(sessionId).done
}

/**
 * Start (or join) one conversation's open and the merge that follows it.
 *
 * A focus, an adopt, a host answer and a refused prompt can all ask for the same return, so one work
 * serves them all: the open starts here and the entry is in the map before its first await can
 * settle, so every caller shares one `sessionOpen` and one merge. The entry lives until the merge
 * settles — not only until the open — because a caller that arrives after the open but while the
 * merge runs must not open the session a second time.
 */
function startRejoin(sessionId: string): RejoinWork {
  const inFlight = rejoining.get(sessionId)
  if (inFlight !== undefined) return inFlight
  const epoch = releases.get(sessionId) ?? 0
  const opened = openNow(sessionId)
  let work: RejoinWork | null = null
  const done = opened
    .then(async (made) => {
      if (!made) return false
      // The visit this open belonged to can end while the open is in flight; the old rejoin
      // refused to walk a transcript into a record the next visit had already replaced.
      if ((releases.get(sessionId) ?? 0) !== epoch) {
        endHold(sessionId)
        return false
      }
      await walkTranscript(sessionId, 'merge')
      return true
    })
    .finally(() => {
      if (work !== null && rejoining.get(sessionId) === work) rejoining.delete(sessionId)
    })
  work = { opened, done }
  rejoining.set(sessionId, work)
  return work
}

/**
 * The first phase: subscribe, open the conversation by its file, and put the record it answered into
 * place. The hold it leaves open belongs to the merge {@link startRejoin} runs next.
 */
async function openNow(sessionId: string): Promise<boolean> {
  const record = sessionStore.get().records[sessionId]
  if (!record) return false
  const epoch = releases.get(sessionId) ?? 0
  const file = await fileOf(sessionId, record.workspaceId, record.filePath)
  if (file === null) {
    // The conversation has no file this side can name (the host forgot it, the list lost it), so
    // there is nothing to reopen and nothing will arrive: an empty record says so instead of
    // waiting for rows that were never coming. A record with rows keeps them — nothing was lost,
    // only the refresh — and the failure is reported beside the composer.
    settleRejoinFailure(sessionId, {
      code: 'session_unknown',
      message: 'This conversation could not be found to read it again.',
    })
    return false
  }
  beginHold(sessionId)
  try {
    await ensureListening(sessionId)
    // The screen can leave again while the host is opening: a rejoin that outlived its visit would
    // otherwise reopen a session nobody is reading and walk a transcript into a record the next
    // visit is already replacing (2026-10-21).
    if ((releases.get(sessionId) ?? 0) !== epoch) return false
    const view = await sessionOpen(record.workspaceId, file)
    if (!sessionStore.get().records[sessionId] || (releases.get(sessionId) ?? 0) !== epoch) {
      return false
    }
    setRecord(sessionId, (current) => ({
      ...current,
      filePath: view.sessionFile ?? current.filePath,
      title: view.title ?? current.title,
      runtime: view.state ?? current.runtime,
      engineEmpty: (view.state?.messageCount ?? 0) === 0,
    }))
  } catch (error) {
    endHold(sessionId)
    if (!sessionStore.get().records[sessionId]) return false
    settleRejoinFailure(sessionId, toApiError(error))
    return false
  }
  if ((releases.get(sessionId) ?? 0) !== epoch) {
    endHold(sessionId)
    return false
  }
  return true
}

/**
 * What a return that could not be made leaves behind.
 *
 * A conversation whose rows are already on screen is not replaced by a failure line: what failed is
 * the *refresh* of it, and the reader still has everything they had — the failure is reported beside
 * the composer, where a notice can be dismissed. A conversation with **no** rows and no read coming
 * is the other case, and it used to be indistinguishable from a slow read: the record stayed on its
 * loading mark forever, which is a conversation the reader opened and got nothing in (2026-10-27,
 * user report: "switched to it and no content ever loaded"). There the failure is written as the
 * read's own ending, which is what the pane turns into a card naming it.
 */
function settleRejoinFailure(sessionId: string, failure: ApiError): void {
  setRecord(sessionId, (current) => ({
    ...current,
    historyError: failure,
    historyStatus: current.messages.length === 0 ? 'error' : current.historyStatus,
    notices: pushNotice(current.notices, 'warning', failure.code, failure.message),
  }))
}

/**
 * Open a conversation again because the host no longer holds it.
 *
 * The host ends a conversation that sat quiet past its idle window (`host/src/evict.ts`,
 * `IDLE_EVICT_MS`) or lost it in a restart, and none of that publishes a frame, so the record here
 * still presents a live conversation whose next message is refused (`session_not_found`). What the
 * reader has is still theirs — the record, and the file it is stored in — so the conversation is
 * opened again exactly as a return to a released one is, with the listener it held dropped first
 * because that one is dead. The answer is whether the open was made, which is what the caller's one
 * retry is worth. The caller does not wait for the transcript merge: the session can accept the next
 * turn as soon as it is open, and a history read must not stand between the reader's ask and its
 * answer. The merge still runs (`startRejoin` owns it), and its hold keeps the new turn's frames in
 * order.
 *
 * Bound: one conversation, one open. Released: when the rejoin's merge settles.
 */
async function reopenForWrite(sessionId: string): Promise<boolean> {
  if (sessionStore.get().records[sessionId] === undefined) return false
  // A rejoin already on its way has subscribed for this open; dropping its listener here would
  // orphan the frames the prompt is about to produce. Only a listener no rejoin owns is dead.
  if (!rejoining.has(sessionId)) stopListening(sessionId)
  return await startRejoin(sessionId).opened
}

// The prompt path's own recovery (`state/session-send.ts::writePrompt`): a prompt the host refuses
// as an unknown session reopens that conversation here, where opening one lives.
provideSessionReopener(reopenForWrite)
