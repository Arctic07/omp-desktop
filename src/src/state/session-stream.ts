/**
 * Reading a conversation: its listener, the frames that arrive on it, and the transcript walk.
 *
 * A conversation is read twice over — once as the rows already on disk (`session_history`) and once
 * as a stream (`omp:session:<id>`, what the turn is doing now) — and this is the half that does the
 * reading. What it produces lands in the record the same way either way (`session-record.ts`), and
 * `session-store.ts` owns that record's life: opening it, putting it on screen, letting it go.
 *
 * **One listener per conversation, ever.** A frame is folded by the listener that carries it, so a
 * second listener on the same channel would fold every frame twice — the conversation would read
 * back with each word repeated. `ensureListening` is therefore the only place a listener is
 * registered, it is keyed by session id, and a listener that answers after its conversation was let
 * go is unsubscribed on the spot rather than left behind to fold frames nobody asked for.
 *
 * **A frame that arrives mid-walk waits.** The rows a walk is about to write are the file's, and a
 * frame folded into them first would be overwritten by the read it preceded. So the walk takes a
 * hold on the conversation, frames queue behind it, and the queue is folded in — in order, in one
 * write — when the read lands.
 */

import { sessionChannel, subscribe, toApiError } from '@/api/client'
import { flashTaskbar } from '@/api/app'
import { sessionHistory } from '@/api/agent'
import type { SessionEvent } from '@/api/session-types'
import { noteSessionActivity } from '@/state/session-activity'
import { mergeTranscript, pushNotice } from '@/state/transcript'
import {
  EMPTY_PAINTED_WALK,
  paintHistoryPage,
} from '@/state/transcript-paint'
import {
  flushPresent,
  onPresent,
  schedulePresent,
} from '@/state/presentation'
import { markSessionSeenNow, refreshSessionRow } from '@/state/session-lists'
import {
  foldRecord,
  sessionStore,
  setRecord,
  withSessionTitle,
  type SessionRecord,
} from '@/state/session-record'
import { promoteQueuedPrompt } from '@/state/session-send'

/** Unsubscribe handles for the conversations being listened to, keyed by session id. */
const listeners = new Map<string, () => void>()
/** The registration in flight for one conversation, so two opens cannot register two listeners. */
const registering = new Map<string, Promise<void>>()
/**
 * The conversations whose frames this process still wants.
 *
 * A registration is asynchronous, and a conversation can be let go of while its subscription is
 * still being made: without this the listener that answers afterwards is kept — it folds frames
 * into a session the host was told to close — and the record reads as `listening`, so the next
 * visit skips the rejoin that would bring the conversation back (2026-10-21).
 */
const wanted = new Set<string>()
/** Frames held while a conversation's transcript is being walked, replayed after it lands. */
const holding = new Map<string, SessionEvent[]>()
/**
 * The read that owns each conversation's transcript walk, keyed by session id.
 *
 * A walk is asynchronous on every page, and the conversation it is about can be let go of and come
 * back while it runs — which is exactly what a switch away and back does. The number here is what
 * tells a read of that earlier visit from the one on screen now: a page, a final answer or a failure
 * written by a read whose token is no longer the session's is *not* this conversation's rows to
 * paint, and used to be able to replace a fresh read's or a warm record's transcript with the rows
 * of a visit that had already ended (2026-10-27). `stopListening` drops the entry, which is also what
 * lets the next visit start a read while an abandoned one is still in flight.
 *
 * Owner: this module. Bound: the conversations being read. Released: when the walk settles while it
 * is still the owner, and on `stopListening`.
 */
const walks = new Map<string, number>()
let walkSeq = 0

/**
 * Whether a transcript read for this conversation is in flight right now.
 *
 * A record's `historyStatus` says what the last read it *finished* said, and a read that never
 * finished — the visit ended, or the listener was dropped, before its answer landed — leaves the
 * status where it was (`loading`) and the rows it had painted on screen. Reading that as "a read is
 * coming" is what kept a conversation cut short from ever being read again: the return saw a warm
 * record, asked nothing, and drew the prefix as the whole transcript. The answer here is the fact
 * the status cannot state.
 */
export function isWalking(sessionId: string): boolean {
  return walks.has(sessionId)
}

/**
 * Frames waiting for the next presentation tick, per conversation.
 *
 * The transport already coalesces a turn's text into one frame per display window
 * (`services/runtime/mod.rs::DELTA_FLUSH_MS`), but a turn also publishes tool updates, roster
 * updates and state edges, and several conversations can stream at once — each frame used to be its
 * own store write, its own `records` clone and its own React pass. This queues them and folds one
 * conversation's frames in **one** write per tick, which is the same shape the projection stores of
 * Other desktop front ends use.
 *
 * The tick itself is shared with every other streamed surface (`state/presentation.ts`): one
 * schedule for the whole app, a display frame while the reader can see the window and a quarter
 * second while they cannot. Queued frames are folded in arrival order (the queue is per
 * conversation), a hold drains this queue before it starts (`beginHold`), and the queue is bounded
 * per conversation so a frozen tick can never become unbounded memory.
 *
 * Owner: this module. Bound: `PENDING_FRAMES_MAX` per conversation × the conversations being
 * listened to (bounded by `RETAINED_RECORDS` and the host's session cap). Released: each tick, on
 * visibility/focus changes (`flushPresent`), and with the conversation when its listener stops.
 */
const pending = new Map<string, SessionEvent[]>()

/** Frames one conversation may queue before the queue is folded early. */
const PENDING_FRAMES_MAX = 512

/**
 * Fold one frame into the conversation it is about.
 *
 * The listener is per conversation, so this is the only path a frame takes and it takes it once:
 * the frame is held while that conversation's transcript is being walked, and queued for the next
 * presentation tick otherwise.
 */
function handleFrame(sessionId: string, event: SessionEvent): void {
  // Every frame is proof the conversation is still moving, whether or not this reducer draws it.
  // The stall watcher reads this clock, not the state snapshot: a long healthy turn publishes its
  // snapshot only at the edges (see `state/session-activity.ts`). A frame that arrives after the
  // conversation was let go is not clocked: there is no record for it to keep alive.
  if (wanted.has(sessionId)) noteSessionActivity(sessionId)
  const held = holding.get(sessionId)
  if (held !== undefined) {
    held.push(event)
    return
  }
  const queued = pending.get(sessionId)
  if (queued === undefined) {
    pending.set(sessionId, [event])
  } else {
    queued.push(event)
    if (queued.length >= PENDING_FRAMES_MAX) {
      flushPresent()
      return
    }
  }
  schedulePresent()
}

/** Fold every queued conversation, one write each. Registered with the shared tick. */
function flushPending(): void {
  if (pending.size === 0) return
  const batches = [...pending]
  pending.clear()
  for (const [sessionId, frames] of batches) foldBatch(sessionId, frames)
}

onPresent(flushPending)

/**
 * Fold one conversation's frames in a single write, then tell the rail what its edges did.
 *
 * A frame that changed nothing leaves the state alone (`foldRecord` answers the same record), so a
 * roster tick or a child's passthrough — frames this reducer does not draw — no longer costs a store
 * write and a React pass.
 */
function foldBatch(sessionId: string, frames: readonly SessionEvent[]): void {
  sessionStore.set((state) => {
    const record = state.records[sessionId]
    if (!record) return state
    let folded = record
    for (const frame of frames) folded = foldRecord(folded, frame)
    if (folded === record) return state
    const records = { ...state.records, [sessionId]: folded }
    // The engine names the conversation from its first prompt, and the rail's own row carries the
    // same title: it is written here rather than waiting for the next list read.
    const renamed = frames.filter((frame) => frame.type === 'title_changed').at(-1)
    return renamed?.type === 'title_changed'
      ? withSessionTitle({ ...state, records }, sessionId, renamed.title)
      : { ...state, records }
  })
  const ended = frames.some((frame) => frame.type === 'turn_finished')
  if (frames.some((frame) => frame.type === 'turn_finished' || frame.type === 'turn_started')) {
    noteTurnEdge(sessionId, ended)
  }
  if (ended) {
    // The queue is the reader's intent for the turn after this one, so its head goes out now that
    // the engine is idle. A stopped or a failed turn releases it too — what ended is the turn, not
    // the queue — and the message this sends opens the turn whose own end brings the row after it.
    // What a stop does hold is the *engine's* queue, which the host withdraws before aborting
    // (`AbortOutcome.restored`); these rows are this side's own and stay the reader's to remove.
    promoteQueuedPrompt(sessionId)
  }
}

/**
 * Tell the rail what a turn's edge did to its conversation's row.
 *
 * A finished turn changes the row's title, cold status and last-written time; a turn that just
 * started is the other moment a row can be missing, because a conversation created before the
 * desktop's index saw its file has no row yet. When the ending happened in front of the reader —
 * the conversation was on screen *and this window had focus*, or they stopped it themselves — the
 * new status is also recorded as read, so moving to another conversation does not turn a seen
 * ending into an unread mark. A window in the background is not "on screen": the reader was in
 * another application, and coming back to a mark on a conversation that finished while they were
 * elsewhere is the point of the mark.
 */
function noteTurnEdge(sessionId: string, ended: boolean): void {
  const record = sessionStore.get().records[sessionId]
  if (!record) return
  const watched = ended && watchedEnding(sessionId, record)
  // The list read that follows is a round trip; the mark is written now so the row does not flash
  // the mark it is about to spend. The refresh then records the same fact with the ending's own
  // status, which is the one the host stores.
  if (watched) markSessionSeenNow(sessionId)
  else if (ended && record.lastTurn?.outcome !== 'aborted') flashTaskbar()
  void refreshSessionRow(record.workspaceId, watched ? sessionId : null)
}

/**
 * Whether this ending happened while the reader was watching it.
 *
 * A stop they pressed themselves is their own act even if the frame lands after the screen moved
 * on: the host answers a stop only once the engine is idle, and the conversation may already have
 * been left by then. Every other ending is watched only if its conversation is the one on screen
 * and this window has the focus — the two conditions that make the row's mark something the reader
 * already knows rather than a notice for a later visit.
 */
function watchedEnding(sessionId: string, record: SessionRecord): boolean {
  if (record.lastTurn?.stopped === true) return true
  return sessionStore.get().activeId === sessionId && document.hasFocus()
}

/**
 * Start reading a conversation's frames, once.
 *
 * The registration is remembered while it is in flight, so two opens of the same conversation can
 * never leave two listeners on one channel — the state that folds every frame twice. A registration
 * that answers after the conversation was let go is unsubscribed rather than kept: it would fold
 * frames into a conversation nobody holds, and its next delivery would find nothing to fold into.
 */
export function ensureListening(sessionId: string): Promise<void> {
  wanted.add(sessionId)
  if (listeners.has(sessionId)) return Promise.resolve()
  const inFlight = registering.get(sessionId)
  if (inFlight) return inFlight
  const task = subscribe<SessionEvent>(sessionChannel(sessionId), (event) =>
    handleFrame(sessionId, event),
  )
    .then((unlisten) => {
      if (!wanted.has(sessionId) || !sessionStore.get().records[sessionId]) {
        unlisten()
        return
      }
      listeners.set(sessionId, unlisten)
      setRecord(sessionId, (record) => ({ ...record, listening: true }))
    })
    .catch(() => {
      // A channel that cannot be registered is one this conversation reads only from disk; the
      // transcript stays readable and the next visit tries again.
    })
    .finally(() => {
      if (registering.get(sessionId) === task) registering.delete(sessionId)
    })
  registering.set(sessionId, task)
  return task
}

/**
 * Stop reading a conversation's frames, and drop anything it was holding for it.
 *
 * Letting go of a conversation is one act, so it is one call: a frame still queued behind a walk of
 * a conversation nobody holds any more has nothing left to be folded into, and the queue would
 * otherwise sit there until the process ended.
 */
export function stopListening(sessionId: string): void {
  wanted.delete(sessionId)
  // The read in flight was for the visit that just ended: dropping its token is what stops it from
  // painting into the next one, and what lets the next visit read at once instead of waiting for a
  // read nobody wants to finish first.
  walks.delete(sessionId)
  const unlisten = listeners.get(sessionId)
  if (unlisten) {
    unlisten()
    listeners.delete(sessionId)
  }
  holding.delete(sessionId)
  // A queued frame for a conversation nobody holds any more has nothing left to be folded into.
  pending.delete(sessionId)
  setRecord(sessionId, (record) => (record.listening ? { ...record, listening: false } : record))
}

/** Hold this conversation's frames until its transcript read lands. */
export function beginHold(sessionId: string): boolean {
  // Frames that arrived before the hold are older than the rows the walk is about to write: they are
  // folded now, so the walk cannot reorder them behind the file it lands afterwards.
  flushPresent()
  if (holding.has(sessionId)) return false
  holding.set(sessionId, [])
  return true
}

export function endHold(sessionId: string): void {
  const frames = holding.get(sessionId)
  holding.delete(sessionId)
  if (frames === undefined || frames.length === 0) return
  // One write and one rail report for the whole stretch, exactly as the presentation tick does.
  foldBatch(sessionId, frames)
}

/**
 * Read a conversation's transcript.
 *
 * `replace` is the first look at a conversation this process does not hold: the file is the whole
 * of it. `merge` is every look after that — the rows on screen are what the reader left, and the
 * file is read to fill the gap a released listener left behind.
 */
export async function walkTranscript(sessionId: string, mode: 'replace' | 'merge'): Promise<void> {
  // One read per conversation at a time, and the token is what says whose it is: a read the reader
  // left behind is dropped by `stopListening`, so a return can read while it is still unwinding.
  // The hold is separate: it can be open before the walk starts — a rejoin holds a conversation's
  // frames from the moment its listener goes up, which is before the open that names it — and the
  // walk then reads under that same hold.
  if (walks.has(sessionId)) return
  const token = ++walkSeq
  walks.set(sessionId, token)
  const owns = () => walks.get(sessionId) === token
  beginHold(sessionId)
  if (mode === 'replace') {
    setRecord(sessionId, (record) => ({
      ...record,
      historyStatus: 'loading',
      historyLoaded: 0,
      historyTotal: 0,
      historyError: null,
    }))
  } else {
    // A merge is a return to a conversation whose last read failed: the screen is reading it again
    // now, so it says so instead of leaving the refusal up until the read lands (2026-10-21 — a
    // conversation reopened during rapid switching showed the previous read's failure).
    setRecord(sessionId, (record) =>
      record.historyStatus === 'error'
        ? { ...record, historyStatus: record.messages.length === 0 ? 'loading' : record.historyStatus, historyError: null }
        : record,
    )
  }
  /**
   * The rows the walk has reported so far, and the rows the record holds.
   *
   * In `replace` mode the walk reports its rows a page at a time (`streamRows`), and each page is
   * written as it lands: the rows are final when reported (a call whose result can still be on the
   * next page is held back, `history_read.rs::preview_boundary`), so the answer and the rows on hand
   * agree. Writing them is not drawing them — `conversationPhase` holds the loading mark until the
   * read is over, and what the walk buys is the render that follows it, over rows already parsed
   * (2026-11-05).
   */
  let painted = EMPTY_PAINTED_WALK
  try {
    await ensureListening(sessionId)
    const record = sessionStore.get().records[sessionId]
    if (!record) return
    /**
     * Read this conversation's transcript once, writing pages as they land when asked to.
     *
     * Every write here is gated on this read still owning the conversation: a page of a visit that
     * has already ended must not write into the one that replaced it.
     */
    const readPages = async (streamRows: boolean) => {
      // Read by file, not by session. A conversation is let go of the moment the screen moves on, and
      // a read addressed to the live session fails with `session_not_found` when that close lands
      // between two pages — which is what made a conversation clicked during rapid switching report a
      // load failure and then load fine on the next click (2026-10-21). The file is the same
      // transcript, and the host reads a live session's branch through it when it still holds one.
      let writing = true
      const history = await sessionHistory(
        sessionId,
        (chunk) => {
          if (!writing || !owns()) return
          const current = sessionStore.get().records[sessionId]
          if (chunk.kind === 'progress' || current === undefined) {
            setRecord(sessionId, (record) => ({
              ...record,
              historyLoaded: chunk.loaded,
              historyTotal: chunk.total,
            }))
            return
          }
          // The walk reports a page at a time; `state/transcript-paint.ts` decides what it may do to
          // the rows on hand (append, replace after a restart, or leave them alone).
          const paintedPage = paintHistoryPage(current.messages, painted, chunk)
          painted = paintedPage.walk
          setRecord(sessionId, (record) =>
            paintedPage.show === null
              ? { ...record, historyLoaded: chunk.loaded, historyTotal: chunk.total }
              : {
                  ...record,
                  messages: paintedPage.show,
                  historyLoaded: chunk.loaded,
                  historyTotal: chunk.total,
                },
          )
        },
        record.filePath,
        { streamRows },
      )
      // Anything still in flight is no longer this attempt's to paint: the answer the caller goes on
      // with is the whole transcript, and a late page must not append to it a second time.
      writing = false
      return history
      }
    let history = await readPages(mode === 'replace')
    // A listed conversation that reads back as holding nothing is not a conversation with nothing
    // in it - the rail only lists conversations something was said in. It is the read having missed
    // the transcript (a file being rewritten under it, an index that lags its own rows), and it used
    // to leave the pane on its loading mark for good: the record had no rows, the phase asked for
    // rows that were never coming (2026-10-27, user report: "switched to it and the conversation
    // never loaded"). One more read, without streaming, and then the failure is said out loud.
    const missesHistory = () =>
      history.messages.length === 0 &&
      (sessionStore.get().records[sessionId]?.messages.length ?? 0) === 0 &&
      sessionStore.get().records[sessionId]?.engineEmpty === false
    if (missesHistory() && owns()) history = await readPages(false)
    if (!owns() || !sessionStore.get().records[sessionId]) return
    if (missesHistory()) {
      // A `code` of its own, so the card the pane draws says what happened rather than quoting an
      // error a reader cannot act on.
      throw { code: 'empty_transcript', message: 'The conversation was read but came back empty.' }
    }
    setRecord(sessionId, (record) => ({
      ...record,
      messages:
        mode === 'merge'
          ? mergeTranscript(record.messages, history.messages)
          : record.messages.length === painted.rows.length &&
              painted.rows.length === history.messages.length
            ? // Painted from the same prefix, with nothing else written meanwhile: these rows *are*
              // the transcript, so keeping them spares the whole conversation a second render.
              record.messages
            : mergeTranscript(record.messages, history.messages),
      historyStatus: 'ready',
      historyLoaded: history.totalMessages,
      historyTotal: history.totalMessages,
      historyError: null,
    }))
  } catch (error) {
    if (!owns() || !sessionStore.get().records[sessionId]) return
    const failure = toApiError(error)
    setRecord(sessionId, (record) => ({
      ...record,
      historyStatus: 'error',
      historyError: failure,
      // A read that failed after painting pages leaves the rows it did report on screen, and a
      // transcript that simply stops is indistinguishable from a conversation that ended that way:
      // the reader concluded their last answer had been lost (2026-11-04). The failure is said
      // beside the composer instead, and the next visit reads the conversation again.
      notices:
        record.messages.length === 0
          ? record.notices
          : pushNotice(record.notices, 'warning', failure.code, failure.message),
    }))
  } finally {
    // Only the read that still owns the conversation clears its hold: a read the reader left behind
    // releasing it would fold the frames of the visit that replaced it.
    if (owns()) {
      walks.delete(sessionId)
      endHold(sessionId)
    }
  }
}
