/**
 * The conversation record: what one conversation is, how it is written, and how it reads.
 *
 * A conversation is held here as one `SessionRecord` — the rows the reader sees, plus the handful of
 * facts about the conversation itself: its file, its name, the notices it has put on screen, whether
 * its frames are being read at all. `session-store.ts` owns the life of those records (opening one,
 * listening to it, walking its transcript, letting it go); this module owns the record itself and the
 * two directions it moves in — the writers that put a value into it, and the readings taken back out.
 *
 * **One store, and every writer goes through it.** A record is replaced wholesale by
 * `sessionStore.set`, so "who changed this" has a single answer, and the readings are pure functions
 * of the state that comes out of it — which is what lets them be handed to `useStoreSelector`, where
 * a selector must return a field or a reference the state already holds rather than a fresh object.
 *
 * The dependency runs one way: `session-store.ts` imports from this file, and nothing here reaches
 * back into the lifecycle it keeps.
 */

import type { ApiError } from '@/api/client'
import type { SessionEvent, SessionRuntimeState } from '@/api/session-types'
// Relative with its extension: this module is read by the test runner as well as by the bundler.
import { ENGINE_COMPACTION_REPORT_CODE, ENGINE_RECAP_CODE } from '../api/session-types.ts'
import type { WorkspaceSessions } from '@/state/session-lists'
import { createStore } from '@/state/store'
import {
  foldTranscript,
  pushNotice,
  type SessionNotice,
  type TranscriptState,
} from '@/state/transcript'

export type { SessionNotice }

/* ------------------------------------------------------------------ the record */

/** One conversation this process is holding rows for. */
export interface SessionRecord extends TranscriptState {
  id: string
  workspaceId: number
  /** The file the conversation is stored in; null for one the engine has not written yet. */
  filePath: string | null
  title: string | null
  notices: SessionNotice[]
  /**
   * The engine reported no message at all when this conversation opened.
   *
   * Read from the engine's own `messageCount`, never from the rows on hand: a conversation whose
   * history is still being walked looks empty here for as long as the read runs, and calling that
   * "nothing has been said" is what would draw an empty conversation over a full one.
   */
  engineEmpty: boolean
  /** Whether this conversation's frames are being read here. */
  listening: boolean
  /**
   * Whether the reader has asked this conversation's turn to stop, and the host took it.
   *
   * It is what lets the turn's own ending read as the reader's act: an engine that was waiting out a
   * backoff when the stop landed has no assistant message of its own to state `aborted`, and the
   * turn it closes is the failed attempt the retry was about. The host's answer to the stop is the
   * fact (`AbortOutcome.aborted`), so a turn that ended while this was set is reported as stopped.
   * Cleared by the turn's end and by the next turn's start.
   */
  stopRequested: boolean
  /**
   * Whether a stop this side asked for is still on its way back.
   *
   * The host answers a stop only once the engine has reached idle, which is up to the abort window:
   * the control that sent it must not accept a second press in that stretch, because every press is
   * its own `session_abort` and the ones behind the first are answered by work that is already
   * stopping (`state/session-send.ts::abortTurn`). Owner: this module's record. Cleared by the
   * answer, whatever it was.
   */
  stopPending: boolean
  /**
   * When the turn in flight began, as the host stamped it (`turn_started.at`).
   *
   * The clock the running row counts from, and the reason that row reads the same number after the
   * reader leaves the conversation and comes back: the row is drawn again from nothing when the pane
   * remounts, and a stopwatch started at that moment reports how long the reader has been looking
   * rather than how long the turn has been running. Null until a turn starts here — a conversation
   * this process attached to mid-turn never saw the frame, and the row falls back to the prompt the
   * turn is answering (`home/turn-elapsed.ts`). Cleared by the turn's end, replaced by the next
   * turn's own stamp.
   */
  turnStartedAt: number | null
  historyStatus: 'idle' | 'loading' | 'ready' | 'error'
  historyLoaded: number
  historyTotal: number
  historyError: ApiError | null
}

export interface SessionStoreState {
  /** The workspace whose conversations are listed. */
  workspaceId: number | null
  /**
   * Every workspace's conversations, keyed by workspace id.
   *
   * The rail shows a workspace and the conversations under it, so it needs all of them, not only the
   * one being worked in — the active workspace's list is the same data read through this key.
   */
  sessions: Record<number, WorkspaceSessions>
  /** When each conversation's current status was last seen, keyed by session id (host clock). */
  readMarks: Record<string, number>
  /** Every conversation this process is holding rows for, keyed by session id. */
  records: Record<string, SessionRecord>
  /** The conversation on screen, if any. */
  activeId: string | null
  /**
   * The draft seat the conversation being opened will have, while it is being opened.
   *
   * A switch spends a round trip (a workspace activation, a list read, the host's own open) before
   * there is a record to name the seat. The box would otherwise keep the seat it had, and what the
   * reader types during that window would be written into the conversation they are leaving —
   * visible until the switch lands, gone afterwards (`state/composer-draft-store.ts`). Pinning the
   * target as soon as it is known means the box follows the reader's click immediately and the
   * words typed while it loads belong to the conversation they are waiting for.
   *
   * Null when nothing is being opened. Cleared when the target is adopted, or when the open that
   * pinned it fails (the words stay in that seat; they are simply not shown over the failure).
   */
  openingSeat: string | null
  /** How the screen reads while a conversation it does not hold yet is being opened. */
  openStatus: 'idle' | 'opening' | 'ready' | 'error'
  /**
   * Whether the open in flight was asked for as a *new* conversation (no file behind it).
   *
   * The work column's open flag belongs to a conversation (`state/panel-store.ts`), so a new one has
   * none and the column of the conversation being left folds away. That fold is the reader's own
   * ask — they pressed *new conversation* — so it is animated, unlike a switch between two
   * conversations, which snaps (`components/workspace/use-sidebar-width.ts`). The no-active-session
   * window every open goes through is where the fold happens, which is why the column needs to know
   * *why* that window is open.
   */
  openingNew: boolean
  openError: ApiError | null
}

const EMPTY: SessionStoreState = {
  workspaceId: null,
  sessions: {},
  readMarks: {},
  records: {},
  activeId: null,
  openingSeat: null,
  openStatus: 'idle',
  openingNew: false,
  openError: null,
}

/**
 * How many conversations' rows this process keeps.
 *
 * The host holds a bounded set of sessions warm and the rail draws a page at a time, so this sits
 * above both: what it sheds is a conversation nobody looked at across a run of newer ones, and the
 * cost of shedding one is the walk a return already pays.
 */
export const RETAINED_RECORDS = 16

/**
 * How many transcript rows this process keeps across all retained conversations.
 *
 * A count of conversations is not a memory bound: sixteen long conversations — tool results up to
 * 128K characters each — can be hundreds of megabytes held for rows nobody is reading, and the
 * webview's garbage collector pays for it while the reader is doing something else entirely.
 * Rows are the cheap proxy (one number per conversation, no string scan): a conversation over this
 * budget is let go of in visit order exactly as one past the record count is. The active, warm and
 * still-working conversations are never shed, so the budget is a target rather than a hard ceiling.
 */
export const RETAINED_MESSAGES = 4_000

export const sessionStore = createStore<SessionStoreState>(EMPTY)

/* --------------------------------------------------------------- the readings */

/** The conversation on screen, as a selector for `useStoreSelector`. */
export function activeRecord(state: SessionStoreState): SessionRecord | null {
  return state.activeId === null ? null : (state.records[state.activeId] ?? null)
}

/* --------------------------------------------------------------- the writers */

export function patch(state: Partial<SessionStoreState>): void {
  sessionStore.set((previous) => ({ ...previous, ...state }))
}

export function setRecord(
  sessionId: string,
  next: (record: SessionRecord) => SessionRecord,
): void {
  sessionStore.set((state) => {
    const record = state.records[sessionId]
    if (!record) return state
    const updated = next(record)
    if (updated === record) return state
    return { ...state, records: { ...state.records, [sessionId]: updated } }
  })
}

/**
 * Remember the file a conversation is stored in.
 *
 * It is the one thing a conversation's own record does not know until the list is read: the host
 * writes the file with the first prompt, and the record this process made for it carries none until
 * something reads the index (`state/session-lists.ts`, which is where the list lives).
 */
export function noteSessionFile(sessionId: string, filePath: string): void {
  setRecord(sessionId, (record) =>
    record.filePath === filePath ? record : { ...record, filePath },
  )
}

/**
 * Fill in a conversation's name from the workspace index when the record itself has none.
 *
 * The engine writes a session's auto-title to its file, but the live `session_info_update` frame is
 * only published for a rename; the first name can therefore be known to the rail (which reads the
 * index) and unknown to the open conversation, whose header then says "New conversation" while the
 * row beside it carries the real name (2026-10-20, observed while testing). The index is the same
 * engine-owned fact, and a live title always wins: this only writes into an empty field.
 */
export function noteSessionTitle(sessionId: string, title: string): void {
  setRecord(sessionId, (record) =>
    record.title !== null && record.title.trim() !== '' ? record : { ...record, title },
  )
}

/**
 * Write one field into a conversation's runtime snapshot.
 *
 * The engine's own state frames are the record of what a conversation is; this exists for the two
 * settings the reader writes *here*, where the round trip would otherwise leave the control showing
 * the value it had before the press. It is a write onto the last snapshot, never a substitute for
 * one: a conversation whose state the engine has not reported yet has nothing to patch, and the
 * frame that arrives afterwards replaces the whole snapshot anyway.
 */
export function patchRuntime(sessionId: string, fields: Partial<SessionRuntimeState>): void {
  setRecord(sessionId, (record) =>
    record.runtime === null ? record : { ...record, runtime: { ...record.runtime, ...fields } },
  )
}

/** Report a failed write where the reader is looking: beside the conversation's own notices. */
export function noteFailure(sessionId: string, failure: ApiError): void {
  setRecord(sessionId, (record) => ({
    ...record,
    notices: pushNotice(record.notices, 'error', failure.code, failure.message),
  }))
}

/* ------------------------------------------------------------------ frames */

/**
 * The engine's own progress codes: notices that restate what the conversation already shows.
 *
 * Every one of them is about a request the reader is already watching — the engine retrying it, the
 * model it fell back to, the context being rewritten — and each is stated by the reading it moves
 * (the context gauge's occupancy, the state line's own words) or by the rows themselves. Written on
 * the composer's notice line they are a second account of a fact the screen already carries, and
 * because the engine emits one per *check* — the boundary test runs before a prompt, again at the
 * turn's end, and once more per method it falls back through — a single compaction arrives as a
 * stack of identical lines the reader has to dismiss one at a time. The Vue front end drops the same
 * six codes and keeps a single notice slot, which is why one compaction never read as four there.
 *
 * What is deliberately kept: a notice the engine worded itself (an automatic or endpoint compaction
 * that *failed* keeps its reason, which exists nowhere else; the manual one is the command's own
 * transcript line, `host/src/slash.ts::commandReportCode`) and the host's own account of itself.
 */
const ENGINE_PROGRESS_CODES: Readonly<Record<string, true>> = {
  engine_retrying: true,
  engine_retry_fallback: true,
  engine_compacting: true,
  engine_compacted: true,
  engine_compaction_stopped: true,
  engine_compaction_skipped: true,
  // The idle recap is not suppressed - it is drawn as a row of the transcript itself
  // (`state/transcript.ts` routes it by this code), so it must not be written here as well. One
  // fact, one place: a recap in the notice strip beside its own row is the same sentence twice.
  [ENGINE_RECAP_CODE]: true,
  // The report a compaction prints is the same case: a transcript row, not a line to dismiss.
  [ENGINE_COMPACTION_REPORT_CODE]: true,
}

/**
 * Fold one frame into one conversation's record.
 *
 * `foldTranscript` owns the rows; the two readings it deliberately leaves out are here, because they
 * are about the conversation rather than its transcript: the name the engine gives it, which the
 * rail's own row carries too, and the notices it puts on screen. Every path a frame can take —
 * delivered live, or replayed after a transcript read — goes through this one function, so a notice
 * that arrives while a read is in flight is drawn like any other.
 *
 * **A frame that changes nothing answers the same record.** This side's reducer does not draw a
 * child's passthrough (`subagent_event`), a roster tick, the command advertisement or an engine
 * progress notice; writing a new record for one still cloned `records` and re-ran every subscription
 * and selector, which is a React pass per frame for a frame nothing draws (2026-10-23, the cost that
 * kept a background window busy). `foldTranscript` returns the record it was given when it handles
 * nothing, so that identity is the test.
 */
export function foldRecord(record: SessionRecord, event: SessionEvent): SessionRecord {
  const folded = foldTranscript(record, event, { stopRequested: record.stopRequested })
  switch (event.type) {
    case 'title_changed':
      return { ...record, ...folded, title: event.title }
    case 'turn_started':
      // A new turn is the reader's next ask, and the stop that ended the last one is behind it. Its
      // clock starts at the host's own stamp rather than at the moment this screen noticed the turn,
      // so the reading survives the pane being mounted again.
      return { ...record, ...folded, stopRequested: false, turnStartedAt: event.at }
    case 'turn_finished':
      // The turn the stop was for is over, so the mark goes with it. What the reader is told is
      // already written into the ending (`lastTurn`), which is read before this flag is cleared —
      // and so is the turn's clock, which has no turn left to count.
      return { ...record, ...folded, stopRequested: false, turnStartedAt: null }
    case 'notice':
      // The engine's progress codes stop here: the facts they restate are on the same screen, and
      // the line they would write is a second, noisier account of them.
      if (event.code !== undefined && ENGINE_PROGRESS_CODES[event.code] === true) {
        return folded === record ? record : { ...record, ...folded }
      }
      return {
        ...record,
        ...folded,
        notices: pushNotice(record.notices, event.level, event.code ?? null, event.message),
      }
    case 'error':
      return {
        ...record,
        ...folded,
        notices: pushNotice(record.notices, 'error', event.code, event.message),
      }
    default:
      return folded === record ? record : { ...record, ...folded }
  }
}

/** Write a conversation's title into every list that carries it, so the rail agrees with the header. */
export function withSessionTitle(
  state: SessionStoreState,
  sessionId: string,
  title: string,
): SessionStoreState {
  let changed = false
  const sessions: Record<number, WorkspaceSessions> = {}
  for (const [key, workspace] of Object.entries(state.sessions)) {
    const items = workspace.items.map((row) =>
      row.id === sessionId ? { ...row, title } : row,
    )
    const same = items.every((row, index) => row === workspace.items[index])
    sessions[Number(key)] = same ? workspace : { ...workspace, items }
    if (!same) changed = true
  }
  return changed ? { ...state, sessions } : state
}
