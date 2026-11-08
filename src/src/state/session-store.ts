/**
 * The conversations this application holds, and which one is on screen.
 *
 * A conversation is read twice over: once as a transcript (`session_history`, the rows already on
 * disk) and once as a stream (`omp:session:<id>`, what the turn is doing now). Both arrive in one
 * record, keyed by the engine's own id, so a row that comes in both ways updates in place instead of
 * appearing twice — and what is defined here is that record's *life*: opened, put on screen, let go
 * of, shed when it is the oldest nobody is looking at.
 *
 * The two halves it leans on live beside it. `session-stream.ts` owns the reading — the listener, the
 * frames, the transcript walk, and the one-listener-per-conversation rule that keeps a frame from
 * being folded twice. `session-send.ts` owns the writing — prompts, stops, the model and level, the
 * answers to the engine's dialogs.
 *
 * **A conversation's rows outlive a visit.** Coming back to a conversation draws on the rows the
 * last visit left, so the reader's place in it is theirs to keep; the host is told the screen is done
 * with the session (so its own LRU may take the record back), and the transcript is walked again in
 * the background — merged, never re-seeded — to fill whatever was written while nothing here was
 * listening. What the ceiling sheds is a conversation nobody looked at across a run of newer ones.
 */

import { subscribe, toApiError } from '@/api/client'
import {
  engineWarm,
  sessionClose,
  sessionOpen,
  sessionWatch,
} from '@/api/agent'
import type { SessionSummary, SessionView } from '@/api/session-types'
import { RUNTIME_EVENT_CHANNEL, type RuntimeEvent } from '@/api/types'
import { noteSessionActivity } from '@/state/session-activity'
import { isUnwritten, pushNotice } from '@/state/transcript'
import { normaliseFilePath, sameFilePath } from '@/lib/file-path'
import {
  findSummary,
  loadReadMarks,
  loadSessionList,
  markSessionRead,
  markSessionSeenNow,
  newestSession,
  refreshSessionRow,
} from '@/state/session-lists'
import {
  blankSeatFor,
  cancelBackgroundReclaim,
  keepWarm,
  pruneRecords,
  releaseLater,
  rememberBlankSeat,
  scheduleBackgroundReclaim,
} from '@/state/session-release'
import {
  patch,
  sessionStore,
  setRecord,
  type SessionRecord,
} from '@/state/session-record'
import { isWalking, stopListening, walkTranscript } from '@/state/session-stream'
import {
  flushPresent,
  isPresentCovered,
  isViewing,
  reschedulePresent,
  setPresentCovered,
} from '@/state/presentation'
import { appBackground } from '@/api/app'
import { ownsPanelState } from '@/state/panel-store'
import { noteVisit } from '@/state/session-visits'
import { activateWorkspace, workspaceStore } from '@/state/workspace-store'
import { blankSeatToOpen } from '@/state/blank-seat'
import {
  carryComposerDraft,
  conversationDraftKey,
  draftPinCoversRecord,
  newConversationDraftKey,
} from '@/state/composer-draft-store'
import type { WorkspaceSessions } from '@/state/session-lists'
import { rejoin } from '@/state/session-rejoin'

// The conversation record itself — the store, the writers onto it and the readings taken from it —
// lives in `state/session-record.ts`, and the reading and writing halves in `state/session-stream.ts`
// and `state/session-send.ts`. Everything a caller used to read off this module is re-exported, so
// the split is this file's business rather than every caller's.
export {
  activeRecord,
  noteSessionFile,
  sessionStore,
} from '@/state/session-record'
export { isStoppable, isStreaming } from '@/state/work-readings'

export type { SessionNotice, SessionRecord, SessionStoreState } from '@/state/session-record'

// The release half of a record's life lives in `state/session-release.ts`; what callers asked this
// module for is still answered here.
export { afterReclaim, keepWarm } from '@/state/session-release'
export type { WorkspaceSessions }

export {
  abortTurn,
  answerDialog,
  interruptQueuedPrompt,
  sendPrompt,
  setSessionModel,
  setSessionThinking,
  stopJob,
} from '@/state/session-send'

/* ------------------------------------------------------------ open / close */

/**
 * Pin the draft seat of the conversation being opened.
 *
 * `force` is the caller stating the reader's own intent (a click, a new conversation, a fork). An
 * open that merely follows from something else — a workspace switch opening its newest conversation
 * while the reader is already heading somewhere else — leaves an existing pin alone, so the words
 * typed during the longer switch keep going to the conversation the reader asked for.
 */
export function pinOpeningSeat(seat: string, force: boolean): void {
  sessionStore.set((state) => {
    if (!force && state.openingSeat !== null) return state
    return state.openingSeat === seat ? state : { ...state, openingSeat: seat }
  })
}

/** The draft seat of the conversation a file names, from the rail's own list; null when unknown. */
function seatForFile(file: string): string | null {
  for (const list of Object.values(sessionStore.get().sessions)) {
    const row = list.items.find((item) => sameFilePath(item.filePath, file))
    if (row !== undefined) return row.id
  }
  return null
}

/**
 * Open a conversation and put it on screen.
 *
 * `file` names the transcript to open; null asks the engine for a new conversation, which is what
 * the rail's *new conversation* action does. A conversation this process already holds is adopted
 * without a round trip at all: its rows are on hand, and the walk that follows is the one that
 * fills the gap rather than the one that draws it.
 *
 * `targetSessionId` is the conversation the caller already knows this open is for. It pins the
 * composer's seat before the first round trip (see {@link pinOpeningSeat}), so words typed while the
 * conversation loads belong to it instead of to the one being left.
 */
export async function openConversation(
  workspaceId: number,
  file: string | null,
  targetSessionId?: string,
): Promise<void> {
  const token = claimNavigation()
  if (file !== null) openingFiles.set(openingKey(file), token)
  const known = file === null ? null : findByFile(file)
  if (known) {
    adopt(known.id)
    if (file !== null) settleOpening(file, token)
    return
  }
  const seat =
    targetSessionId ??
    (file === null ? newConversationDraftKey(workspaceId) : seatForFile(file))
  if (seat !== null) pinOpeningSeat(seat, false)
  // The screen is moving to a conversation this process does not hold yet, so the one it is leaving
  // is left warm rather than let go of: a return within the window costs no round trip at all.
  // Cleared first, because `releaseLater` keeps the conversation it is told about only while it is
  // not the one on screen.
  const previous = sessionStore.get().activeId
  // `openingNew` is what lets the work column fold away *with* its animation while this open runs:
  // the new conversation has no column of its own, and the fold is the reader's own ask.
  patch({ activeId: null, openStatus: 'opening', openingNew: file === null, openError: null })
  if (previous !== null) releaseLater(previous)
  /**
   * The row the reader clicked, painted before the engine is asked to open it.
   *
   * Only a conversation the rail named can be painted this way: its summary is where the file, the
   * title and the id come from, and a conversation with no summary has nothing to draw. `blank` is
   * the one kind of listed row that is not paint-able - it holds nothing, so there is nothing to
   * read - and it keeps the plain open it always had.
   *
   * `openStatus` deliberately stays `opening`: the composer is a click away from a `session_prompt`
   * the host would refuse, and `adopt` is what says the conversation is open, which happens when the
   * engine answers below.
   */
  const seeded =
    file !== null && targetSessionId !== undefined
      ? findSummary(workspaceId, targetSessionId)
      : undefined
  if (seeded !== undefined && file !== null && sameFilePath(seeded.filePath, file) && !seeded.blank) {
    paintSummary(workspaceId, seeded)
    patch({ activeId: seeded.id })
    void walkTranscript(seeded.id, 'replace')
  }
  let view: SessionView
  try {
    await engineWarm(workspaceId)
    view = await sessionOpen(workspaceId, file)
  } catch (error) {
    if (token === navigation) {
      // The open's own pin goes with it. The words typed into that seat are still there — the box
      // keeps its seat on an empty reading — they are just not shown over a failure that names no
      // conversation.
      const pinned = seat !== null && sessionStore.get().openingSeat === seat
      patch({
        openStatus: 'error',
        openingNew: false,
        openError: toApiError(error),
        ...(pinned ? { openingSeat: null } : {}),
      })
    }
    if (file !== null) settleOpening(file, token)
    return
  }
  if (token !== navigation) {
    // A newer intent took the screen while this one was answering. Nothing here may take it back, and
    // the conversation the engine just handed over is one nobody is going to read: hand it back,
    // dropping the file when it is one this open created and holds nothing. A file a *newer* open is
    // already asking for is left alone — closing it would take the session out from under the screen
    // that is opening it (2026-10-21, rapid switching).
    const requestedByNewer = file !== null && (openingFiles.get(openingKey(file)) ?? 0) > token
    if (!requestedByNewer && !sessionStore.get().records[view.sessionId]) {
      void sessionClose(view.sessionId, file === null).catch(() => undefined)
    }
    return
  }
  if (file !== null) settleOpening(file, token)
  const held = sessionStore.get().records[view.sessionId]
  if (held) {
    // A record already on screen — the one painted above, or one this process kept warm — takes the
    // engineer's answer for its run, not for its rows: a walk is in flight or finished, and a second
    // one would paint the same pages twice. The engine's word on whether anything was ever said is
    // only trusted where the walk has produced nothing yet.
    const openedTitle = view.title?.trim() ?? ''
    setRecord(view.sessionId, (record) => ({
      ...record,
      runtime: view.state ?? record.runtime,
      title: openedTitle === '' ? record.title : openedTitle,
      engineEmpty:
        record.messages.length > 0 ? record.engineEmpty : (view.state?.messageCount ?? 0) === 0,
    }))
    adopt(view.sessionId)
    return
  }
  createRecord(view, file === null)
  // The read goes up before the record is put on screen, so `adopt` sees a walk in flight rather
  // than a `loading` record nobody is reading — the same order the painted open above already uses.
  void walkTranscript(view.sessionId, 'replace')
  adopt(view.sessionId)
}

/**
 * The newest navigation intent, as a token.
 *
 * Every action that decides which conversation is on screen claims one *before* its first await and
 * re-checks it after each of them: whoever claimed last owns the screen, and an older intent whose
 * round trip lands afterwards must write nothing — not the conversation, not the error line, not the
 * close of a session it opened on the way. One counter for every intent is what makes a *warm*
 * selection (`adopt`, no round trip at all) invalidate a cold open still in flight; a token that only
 * opens minted could not, so a cold click that resolved late used to take the screen back from the
 * conversation the reader had clicked after it (2026-10-27, user report: a switch that showed a
 * conversation with nothing loaded, or the failure card of one they had already left).
 *
 * Owner: this module. Bound: one number. Released: never — a token is only ever compared.
 */
let navigation = 0

/**
 * Claim the screen for a new intent; the answer is what every later step compares against — the
 * claim is only still the reader's while `navigation` has not moved (`token === navigation`).
 */
function claimNavigation(): number {
  navigation += 1
  return navigation
}

/**
 * The newest open token per session file.
 *
 * Only ever read to answer one question when a stale open answers: is a newer open already asking
 * for this same file? Owner: this module. Bound: opens in flight. Released: each entry is deleted
 * when its own open settles (`token === openingFiles.get(file)`), so a settled open leaves nothing
 * behind — except a stale one, whose entry belongs to the newer open that replaced it.
 */
const openingFiles = new Map<string, number>()

/**
 * The key a file is known by in {@link openingFiles}.
 *
 * The desktop and the engine spell the same Windows file differently (`D:\a\b` against `D:/a/b`,
 * and either case), so an open tracked by the raw string can fail to see that a newer open is
 * already asking for that same transcript — and an older open then closes the session the newer one
 * is opening (2026-10-21, rapid switching).
 */
function openingKey(file: string): string {
  return normaliseFilePath(file).toLowerCase()
}

/** Drop a file's open entry, unless a newer open has already claimed it. */
function settleOpening(file: string, token: number): void {
  const key = openingKey(file)
  if (openingFiles.get(key) === token) openingFiles.delete(key)
}

function findByFile(file: string): SessionRecord | null {
  for (const record of Object.values(sessionStore.get().records)) {
    if (record.filePath !== null && sameFilePath(record.filePath, file)) return record
  }
  return null
}

function createRecord(view: SessionView, createdBlank: boolean): void {
  // The open itself is this process hearing from the conversation; the stall clock starts here so a
  // conversation adopted mid-turn has a baseline even when the host's own `lastEventAt` is 0.
  noteSessionActivity(view.sessionId)
  const record: SessionRecord = {
    id: view.sessionId,
    workspaceId: view.workspaceId,
    filePath: view.sessionFile ?? null,
    title: view.title,
    notices: [],
    engineEmpty: createdBlank || (view.state?.messageCount ?? 0) === 0,
    listening: false,
    stopRequested: false,
    stopPending: false,
    // The host stamps a turn's start when it opens one, and this process has not heard it yet.
    turnStartedAt: null,
    // The walk this record was made for starts immediately; a record that is not being read yet
    // never exists, so the status begins where the read does.
    historyStatus: 'loading',
    historyLoaded: 0,
    historyTotal: 0,
    historyError: null,
    messages: [],
    subagents: {},
    btw: null,
    turnId: null,
    runtime: view.state ?? null,
    dialogs: [],
    // A conversation read from disk carries its outcomes on the rows themselves; nothing has ended
    // in this process yet.
    lastTurn: null,
  }
  sessionStore.set((previous) => ({
    ...previous,
    records: { ...previous.records, [view.sessionId]: record },
  }))
  // The blank conversation a workspace is on, so asking for a new one again returns to it rather
  // than to a second blank with none of the reader's work in it (`openBlankConversation`).
  if (createdBlank) rememberBlankSeat(view.workspaceId, view.sessionId)
}

/**
 * A conversation's first frame, drawn from the desktop's own index instead of from the engine.
 *
 * The scan read every transcript and the projection keeps what each one says
 * (`services::session_index::projection`), so the rows of a conversation nobody has opened in this
 * process are already on disk - and reading them costs the index, where the engine's own open
 * (`SessionManager.open`) reads and parses the whole transcript. Painting here is what makes a rail
 * click instant: the walk that follows (`walkTranscript`, addressed by file) is answered from that
 * index while the engine is still opening, and the open itself runs behind the paint.
 *
 * Nothing about the conversation's *run* is known yet - no turn, no model, no dialogs - so the
 * record starts empty of all of it (`runtime: null`). The open's own answer fills those in when it
 * lands, and only sending has to wait for it: `openStatus` stays `opening` until then.
 */
function paintSummary(workspaceId: number, summary: SessionSummary): void {
  noteSessionActivity(summary.id)
  const record: SessionRecord = {
    id: summary.id,
    workspaceId,
    filePath: summary.filePath,
    title: summary.title,
    notices: [],
    // A listed conversation is one something was said in - a blank row is not in the rail at all -
    // so the column draws a conversation while its rows are still arriving, never the hero.
    engineEmpty: false,
    listening: false,
    stopRequested: false,
    stopPending: false,
    turnStartedAt: null,
    historyStatus: 'loading',
    historyLoaded: 0,
    historyTotal: 0,
    historyError: null,
    messages: [],
    subagents: {},
    btw: null,
    turnId: null,
    runtime: null,
    dialogs: [],
    lastTurn: null,
  }
  sessionStore.set((previous) => ({
    ...previous,
    records: { ...previous.records, [summary.id]: record },
  }))
}

/**
 * Put a conversation on screen, and leave the one it replaced warm.
 *
 * The seat pinned for this open (if it named this conversation) is spent here. A pin that named a
 * session the record turns out to be *unwritten* under still covers it: a blank conversation lives
 * in its workspace's seat, and what the reader typed while it loaded moves there with it.
 */
function adopt(sessionId: string): void {
  const state = sessionStore.get()
  const previous = state.activeId
  const record = state.records[sessionId] ?? null
  keepWarm(sessionId)
  noteVisit(sessionId)
  const settle = record !== null && draftPinCoversRecord(state.openingSeat, record)
  const seat = record === null ? null : conversationDraftKey(record)
  patch({
    activeId: sessionId,
    openStatus: 'ready',
    openingNew: false,
    openError: null,
    openingSeat: settle ? null : state.openingSeat,
  })
  if (settle && state.openingSeat !== null && seat !== null && state.openingSeat !== seat) {
    carryComposerDraft(state.openingSeat, seat)
  }
  if (previous !== null && previous !== sessionId) releaseLater(previous)
  if (record !== null) {
    // Whichever way the reader reached this blank conversation — a click of "new", a workspace that
    // opened on it, a rail row — it is the one this workspace's next "new" has to come back to.
    if (isUnwritten(record.engineEmpty, record.messages)) {
      rememberBlankSeat(record.workspaceId, record.id)
    }
    const summary = findSummary(record.workspaceId, sessionId)
    if (summary) void markSessionRead(summary.id, summary.status)
    // The host is told this conversation is on screen in the same round trip that checks it still
    // holds it. A warm record whose session was evicted (or whose host restarted) answers `false`;
    // its listener is dead, and without this the conversation would be drawn as current while no
    // frame ever arrives again. It is reopened and merged back instead.
    // The cadence follows the window: a conversation adopted (or reopened) while the reader is in
    // another application is delivered at the background window until `syncView` raises it back.
    // A call that could not be answered is *not* an answer that the session is open: treating it as
    // one left a conversation drawn as current with a listener the host does not have, so nothing
    // ever arrived again (`state/session-store.ts`, 2026-10-27). `null` means unknown, and an
    // unknown answer takes the same recovery a `false` does — the record is settled as not
    // listening and reopened, which is what puts a real listener back.
    const watching = sessionWatch(sessionId, isViewing() && !isPresentCovered()).catch(() => null)
    if (record.listening) {
      void watching.then((open) => {
        if (open === true) return
        const current = sessionStore.get()
        if (current.activeId !== sessionId || current.records[sessionId] === undefined) return
        if (open === null) {
          // Nothing is rethrown at the reader here: the record stops claiming a listener it may not
          // have, so the next visit rejoins instead of assuming the stream is live.
          setRecord(sessionId, (held) => (held.listening ? { ...held, listening: false } : held))
          return
        }
        stopListening(sessionId)
        void rejoin(sessionId)
      })
    } else if (record.historyStatus !== 'loading' || !isWalking(sessionId)) {
      // A record is warm only when the read that filled it *finished*. `loading` with no walk in
      // flight is a read that was abandoned with its pages painted — the conversation would be drawn
      // as the prefix it stopped at, for good, because nothing would ever ask again. The return is
      // what asks: it reopens the session and merges the file into the rows on hand.
      void rejoin(sessionId)
    }
  }
  pruneRecords()
}

/* -------------------------------------------------------------- workspace */
/**
 * The workspace switch in flight, if one is.
 *
 * The active workspace reaches this store through the workspace store's own subscription, so the
 * switch is asynchronous and nothing awaits it. A caller that has to act *after* the switch —
 * opening a brand-new conversation in the workspace it just picked, say — joins this instead of
 * racing it: without the join it reads the previous workspace id and puts the conversation there.
 */
let switching: { workspaceId: number | null; aim: SwitchAim; done: Promise<void> } | null = null

/**
 * The workspace a caller is making active in order to open a conversation of its own there, and what
 * it is opening.
 *
 * `startSessionIn` and `selectSession` activate the workspace and then open what the reader asked
 * for; the subscription's own switch would otherwise open the workspace's newest conversation first
 * and take the screen (2026-10-29, two user reports: the first click on a new-conversation button
 * loaded the workspace's first conversation, and a switch flashed the new conversation's welcome).
 * Read and cleared by the subscription inside `activateWorkspace`; {@link activateForOwnOpen} clears
 * it again when the activation opened nothing at all.
 */
let aimed: { workspaceId: number; aim: 'read' | 'create' } | null = null

/**
 * What a workspace switch is for: `newest` opens the conversation that was last worked in, `read`
 * and `create` open nothing and differ only in the screen the wait is drawn on (the loading mark for
 * one about to be read, the hero for one about to be created). One value rather than two flags, so
 * "opens the newest *and* is creating" cannot be written.
 */
type SwitchAim = 'newest' | 'read' | 'create'

async function runWorkspaceSwitch(workspaceId: number | null, aim: SwitchAim): Promise<void> {
  // A switch that opens nothing is a caller's preparation for its own open: claiming the navigation
  // token here would make that caller's intent stale before its first await, and nothing would open.
  const token = aim === 'newest' ? claimNavigation() : navigation
  const previous = sessionStore.get().activeId
  patch({
    workspaceId,
    activeId: null,
    // A switch is a wait, not a screen with nothing in it: `opening` keeps the column on its loading
    // mark instead of flashing the hero, and `openingNew` says which screen the wait ends on.
    openStatus: 'opening',
    openingNew: aim === 'create',
    openError: null,
    // With no workspace there is no conversation a seat could belong to.
    ...(workspaceId === null ? { openingSeat: null } : {}),
  })
  if (previous !== null) releaseLater(previous)
  if (workspaceId === null) return
  await loadSessionList(workspaceId)
  if (aim !== 'newest') return
  // The reader aimed somewhere else while the list was read (a rail click, a new conversation):
  // opening this workspace's newest now would pull the screen to a conversation they did not ask
  // for, which is the "opened the wrong one" half of a switch that looks like a blank pane.
  if (token !== navigation) return
  // A workspace opens on the conversation that was last worked in, the way the desktop app does:
  // the alternative is a conversation list the user has to pick from every time they switch. A
  // workspace with nothing in it opens the blank conversation its first message would have created
  // instead — that is what the hero is drawn over, and what makes the box the reader types in a real
  // prompt rather than a dead one. Left untouched it is handed back with no file behind it.
  const newest = newestSession(sessionStore.get().sessions[workspaceId])
  // The open pins this conversation's seat only if the reader has not already aimed somewhere else
  // (a rail click in another workspace sets its own pin first).
  await openConversation(workspaceId, newest?.filePath ?? null, newest?.id)
}

function setSessionWorkspace(workspaceId: number | null, aim: SwitchAim = 'newest'): Promise<void> {
  if (switching !== null && switching.workspaceId === workspaceId) {
    // Joined, not restarted — but a caller aimed at the other screen still owns the wait's ending.
    if (switching.aim !== aim) {
      switching.aim = aim
      patch({ openingNew: aim === 'create' })
    }
    return switching.done
  }
  if (sessionStore.get().workspaceId === workspaceId && aim !== 'newest') return Promise.resolve()
  const done = runWorkspaceSwitch(workspaceId, aim)
  switching = { workspaceId, aim, done }
  const clear = () => {
    if (switching?.done === done) switching = null
  }
  void done.then(clear, clear)
  return done
}

/* ---------------------------------------------------------------- actions */

/**
 * Make a workspace active for a caller that opens its own conversation there.
 *
 * Same as {@link activateWorkspace} except that the switch the activation starts leaves the screen to
 * the caller and says what it is opening ({@link aimed}). The aim is cleared as soon as the
 * activation's synchronous part has run, so an activation that changes nothing cannot leave it behind.
 */
async function activateForOwnOpen(workspaceId: number, aim: 'read' | 'create'): Promise<void> {
  aimed = { workspaceId, aim }
  try {
    await activateWorkspace(workspaceId)
  } finally {
    if (aimed?.workspaceId === workspaceId) aimed = null
  }
}

/** Start a blank conversation in the open workspace. */
export async function startNewSession(): Promise<void> {
  const workspaceId = sessionStore.get().workspaceId
  if (workspaceId === null) return
  await openNewConversationIn(workspaceId)
}

/**
 * Start a blank conversation in a workspace that is already the active one.
 *
 * "New conversation" is the same act in both places it is asked for — the rail's own control, and
 * the screen a deletion leaves behind — and the difference is the switch: a deletion happens in the
 * workspace on screen, so there is nothing to activate, no list to re-read first, and no rail row to
 * move. It deliberately does not go through `startSessionIn`, which is the rail click's path and
 * pays an activation for it.
 *
 * The box moves to the new conversation's seat before the open starts (`pinOpeningSeat`), so what
 * the reader types while it loads belongs to it rather than to the conversation being replaced.
 */
export async function openNewConversationIn(workspaceId: number): Promise<void> {
  pinOpeningSeat(newConversationDraftKey(workspaceId), true)
  await openBlankConversation(workspaceId)
}

/**
 * Start a blank conversation in a named workspace.
 *
 * The workspace is made active first, so the rail's row, the header's breadcrumb and the engine all
 * agree about where the conversation belongs; the switch is joined before the blank one is opened,
 * and it is joined without opening the workspace's own newest conversation, because this call is
 * about to open one of its own.
 */
export async function startSessionIn(workspaceId: number): Promise<void> {
  const token = claimNavigation()
  pinOpeningSeat(newConversationDraftKey(workspaceId), true)
  await activateForOwnOpen(workspaceId, 'create')
  if (token !== navigation) return
  await setSessionWorkspace(workspaceId, 'create')
  if (token !== navigation) return
  await openBlankConversation(workspaceId)
}

/**
 * The blank conversation this workspace is on, or a new one.
 *
 * "New conversation" asked twice is the same request: the first click opens a conversation the
 * engine has written nothing into, and the second has to land on *that* one rather than ask the
 * engine for a second file — the old behaviour opened a fresh conversation per click, so the rail
 * flickered between two empty rows and the engine was handed a file nobody read (2026-10-17).
 *
 * **The blank conversation outlives the visit** (2026-10-26, user report). A reader who opens the
 * work column and a terminal in a conversation nothing has been sent in expects them to be there
 * after they look at another conversation and ask for a new one again; a new engine session would
 * carry neither, and the terminal would be orphaned under an id nothing can reach. So the workspace's
 * blank conversation is remembered (`state/session-release.ts`'s blank seat) and returned to, exactly as the composer's own
 * draft is kept for it (`state/composer-draft-store.ts`). Only an *unwritten* conversation is reused:
 * the engine reports nothing in it and this process holds no messages for it, which is what tells the
 * blank one from a conversation with a word in it.
 *
 * Each workspace has its own: the id is keyed by the workspace it was opened in, so a new conversation
 * in one workspace can never come back with another one's column. And a blank conversation left in a
 * **mode** (plan, goal, vibe, loop) is not the empty seat this asks for: a new conversation starts
 * plain, unless the reader left column work in that one (see `state/blank-seat.ts`).
 */
async function openBlankConversation(workspaceId: number): Promise<void> {
  // The reader asked for this one: a cold open still answering for an earlier click must not take
  // the screen back once the blank conversation is adopted.
  claimNavigation()
  const state = sessionStore.get()
  const reuse = blankSeatToOpen(
    workspaceId,
    state.records,
    blankSeatFor(workspaceId),
    state.activeId,
    ownsPanelState,
  )
  if (reuse !== null) {
    // Already open, or held from an earlier visit: bring it back into view and do nothing else — no
    // open, no engine round trip, no new file, and the tabs it owns stay where they are.
    adopt(reuse)
    return
  }
  await openConversation(workspaceId, null)
}

/**
 * Put a rail row's conversation on screen.
 *
 * The workspace is made active first, and the switch is joined before anything is opened — joined
 * *without* opening the workspace's own newest conversation, because this call is about to open one
 * of its own. Two opens racing for the same screen is what used to leave a conversation the reader
 * had picked looking empty; two opens landing on the *same* conversation is what made it read back
 * with every word repeated, since both registered a listener on its channel.
 *
 * The pin is set first: everything below is a round trip (a workspace activation, a list read, the
 * host's open), and the field has to follow the click before them, not after.
 */
export async function selectSession(workspaceId: number, sessionId: string): Promise<void> {
  const token = claimNavigation()
  pinOpeningSeat(sessionId, true)
  await activateForOwnOpen(workspaceId, 'read')
  // The reader may have clicked another conversation while this one was activating: that click owns
  // the screen now, and finishing this one would put the conversation they left back on it.
  if (token !== navigation) return
  await setSessionWorkspace(workspaceId, 'read')
  if (token !== navigation) return
  await openSessionById(workspaceId, sessionId)
}

/**
 * Open the conversation a rail row stands for, by the workspace it is in and its own id.
 *
 * A conversation this process already holds is put on screen from the rows on hand, with no round
 * trip at all. Anything else is opened by the file its row names — and a row the workspace's own
 * list does not carry is *not* an open at all: opening without a file would ask the engine for a
 * new conversation, which is how a click on a full conversation came back as an empty one. The
 * list is read once more first, because the row can be one this process has not seen yet.
 */
export async function openSessionById(workspaceId: number, sessionId: string): Promise<void> {
  const token = claimNavigation()
  pinOpeningSeat(sessionId, true)
  if (sessionStore.get().records[sessionId]) {
    adopt(sessionId)
    return
  }
  let summary = findSummary(workspaceId, sessionId)
  if (!summary) {
    await loadSessionList(workspaceId)
    if (token !== navigation) return
    summary = findSummary(workspaceId, sessionId)
  }
  if (!summary) {
    // The refusal belongs to this intent alone: a conversation opened meanwhile keeps its screen,
    // and a list that simply has not been read yet is answered by the token check above.
    if (token !== navigation) return
    patch({
      activeId: null,
      openStatus: 'error',
      openingNew: false,
      openError: { code: 'session_unknown', message: 'This conversation is not in the list.' },
      openingSeat: null,
    })
    return
  }
  await openConversation(workspaceId, summary.filePath, sessionId)
}

/* -------------------------------------------------------------------- wiring */

let started = false

/**
 * Follow the active workspace, notice when the host goes away, and settle what the reader comes
 * back to.
 *
 * Registered once for the process: the workspace store is the single source of truth for which
 * workspace is active, so the conversations follow it rather than being told separately by each
 * caller that switches one. The window's own focus is the third thing, because "the conversation
 * on screen" becomes something the reader has seen again the moment the window is in front of
 * them — see {@link settleFocusedConversation}.
 */
export function startSessionWiring(): void {
  if (started) return
  started = true
  void loadReadMarks()
  let lastActive: number | null = null
  const followActive = (active: number | null): void => {
    if (active === lastActive) return
    lastActive = active
    // A caller making this workspace active for its own open gets the list prepared and the screen
    // left alone (`aimed`); this switch must not open the workspace's newest conversation instead.
    const own = active !== null && aimed?.workspaceId === active ? aimed : null
    if (own !== null) aimed = null
    void setSessionWorkspace(active, own?.aim ?? 'newest')
  }
  workspaceStore.subscribe(() => followActive(workspaceStore.get().activeId))
  // The rail can make a workspace active before this wiring is registered: the start-up read is
  // started before React renders (`src/main.tsx`), so its answer can already be in the store when
  // the mount effects run, and a child's effects run before the shell's. The subscription only
  // hears changes made after it exists, so adopt the active workspace once here. A session store
  // already on it is left alone, so a second start does not reopen its newest conversation.
  const current = workspaceStore.get().activeId
  if (current !== null && sessionStore.get().workspaceId !== current) followActive(current)
  else lastActive = current
  window.addEventListener('focus', settleFocusedConversation)
  /**
   * Keep the bridge's cadence and this side's frame tick in step with the window.
   *
   * The reader looking at the window is the whole reason a conversation is delivered at the display
   * cadence; a game in front of it is the case where the opposite must hold. On blur/minimise the
   * queued frames are folded once (the rail's status stays true) and the active conversation is
   * dropped to the background window; on focus it is raised back and the queue is folded at once, so
   * a return never shows a quarter-second-old answer.
   */
  const syncView = () => {
    flushPresent()
    const viewing = isViewing()
    if (viewing) {
      cancelBackgroundReclaim()
    } else {
      // The grace is what keeps a quick alt-tab from tearing down the set the reader is about to
      // come back to; after it, the hidden window keeps only the conversation on screen.
      scheduleBackgroundReclaim()
    }
    // The cadence a conversation is delivered at answers "can the reader see it", so a page drawn
    // over it counts the same way as a window in the background (`setConversationCovered`).
    syncActiveWatch(viewing && !isPresentCovered())
    // The OS is told too: a background app's processes drop to below-normal priority with execution
    // speed throttling (EcoQoS), so a game keeps the machine while the agents still make progress.
    void appBackground(!viewing).catch(() => undefined)
    reschedulePresent()
  }
  window.addEventListener('focus', syncView)
  window.addEventListener('blur', syncView)
  document.addEventListener('visibilitychange', syncView)
  // The window may already be in the background when the first screen mounts.
  syncView()
  void subscribe<RuntimeEvent>(RUNTIME_EVENT_CHANNEL, (event) => {
    if (event.type !== 'engine_exit') return
    // The host is gone: the transcripts stay readable, and every conversation being read says why
    // it stopped.
    sessionStore.set((state) => {
      const records: Record<string, SessionRecord> = {}
      let changed = false
      for (const [id, record] of Object.entries(state.records)) {
        if (!record.listening) {
          records[id] = record
          continue
        }
        changed = true
        records[id] = {
          ...record,
          // The listener a lost engine was feeding is not a listener any more. Leaving `listening`
          // standing made the next visit skip its rejoin — the conversation was drawn as current,
          // with no frames ever coming again — so the flag goes with the engine, and the return is
          // the rejoin that opens a session and subscribes anew.
          listening: false,
          notices: pushNotice(
            record.notices,
            'error',
            'engine_exit',
            `The engine stopped (${event.reason}).`,
          ),
        }
      }
      return changed ? { ...state, records } : state
    })
  })
}

/**
 * Tell the bridge whether the conversation on screen is being watched, and recover one it no longer
 * holds.
 *
 * `watched` answers "can the reader see this conversation", which is the window's own focus and
 * visibility *and* whether an opaque page is drawn over it. The answer is also the round trip that
 * says whether the host still holds the session: a `false` on a return means the host dropped it
 * while the window was away (its idle eviction, or a host restart), so its listener is dead and the
 * conversation is reopened rather than drawn as current with no frame coming again. A `false` while
 * telling the host the conversation is *not* watched proves nothing about that and takes no action.
 */
function syncActiveWatch(watched: boolean): void {
  const activeId = sessionStore.get().activeId
  if (activeId === null) return
  void sessionWatch(activeId, watched)
    .then((open) => {
      if (open || !watched) return
      const state = sessionStore.get()
      if (state.activeId !== activeId || state.records[activeId] === undefined) return
      stopListening(activeId)
      void rejoin(activeId)
    })
    .catch(() => undefined)
}

/**
 * Draw an opaque page over the conversation, or take one away.
 *
 * The settings overlay covers the whole window, so while it is up nothing of the conversation is on
 * screen — the same fact as a window the reader is not looking at. The beat folds what arrives on
 * the hidden cadence, the reveal snaps, and the bridge coalesces this conversation's deltas over the
 * background window instead of the display frame. An answer still being written otherwise rebuilds
 * the hidden transcript 60 times a second, and the page the reader is actually scrolling pays for it
 * (2026-11-01: the skills page's scroll had a 14.0 ms p90 and 16 of 220 frames over 20 ms, against
 * 7.1 ms and 4 once covered;
 * `notes/implemented/bug-fix/2026-11-01-covered-conversation-stops-presenting.md`).
 *
 * The window's own priority is left alone: the reader is in front of the application and reading a
 * page it draws, so `appBackground` is not this state's business.
 */
export function setConversationCovered(covered: boolean): void {
  setPresentCovered(covered)
  syncActiveWatch(!covered && isViewing())
  // Coming back out is a return: the backlog folds in the frame the cover lifts, not a quarter of a
  // second after it.
  if (!covered) flushPresent()
}

/**
 * Settle the conversation on screen when the window comes back to the front.
 *
 * A turn that ends while the reader is in another application leaves its row marked — that is the
 * point of the mark. But the moment they return, the conversation it belongs to is the one already
 * on screen, so it has been seen: the mark is spent here, rather than waiting for a click on the
 * row or a switch away and back (2026-10-21, user report: a completion that landed in the
 * background stayed unread after the window came back). Only a row that actually has something to
 * spend is touched — alt-tabbing over a settled conversation reads no list and writes no mark.
 */
function settleFocusedConversation(): void {
  const state = sessionStore.get()
  const record = state.activeId === null ? undefined : state.records[state.activeId]
  if (record === undefined) return
  const summary = findSummary(record.workspaceId, record.id)
  // The row's own newest fact: the file's last write, or the ending this process watched land
  // after it (the list lags `turn_finished` by one read, so the ending is the newer of the two).
  const rowAt = Math.max(summary?.updatedAt ?? 0, record.lastTurn?.at ?? 0)
  if ((state.readMarks[record.id] ?? 0) >= rowAt) return
  // Marked locally first so the row settles in this frame; the read that follows records the same
  // fact with the status the host stores, and covers the case where the ending's own list refresh
  // was still in flight when the window came back.
  markSessionSeenNow(record.id)
  void refreshSessionRow(record.workspaceId, record.id)
}
