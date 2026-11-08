/**
 * Giving a conversation back: the warm window, the warm set, the record budget, and what a release
 * may take with it.
 *
 * The store opens and adopts conversations and owns what is on screen; this module owns the other
 * half of a record's life — when the reader leaving is a state change and when it is a hand-back to
 * the host. Split out of `state/session-store.ts` because that file was over the single-file limit
 * and this half changes for its own reason: a release policy, not an open.
 *
 * **The blank seat lives here too**, because a seat outlives its visit only as long as its record
 * does: it is dropped exactly where a record is discarded, and the readers that hand it out
 * (`state/blank-seat.ts`) take the id from {@link blankSeatFor}.
 */

import { sessionClose, sessionWatch } from '@/api/agent'
import { forgetSession, ownsPanelState, trimPanelSessions } from '@/state/panel-store'
import { clearQueuedPrompts, hasQueuedPrompts } from '@/state/prompt-queue-store'
import {
  RETAINED_MESSAGES,
  RETAINED_RECORDS,
  sessionStore,
} from '@/state/session-record'
import { bumpRelease, rejoin } from '@/state/session-rejoin'
import { forgetSessionActivity } from '@/state/session-activity'
import { findSummary } from '@/state/session-lists'
import { dropsFileOnRelease } from '@/state/session-rows'
import { stopListening } from '@/state/session-stream'
import { forgetVisit, visitRank } from '@/state/session-visits'
import { isWorking } from '@/state/work-readings'

/**
 * How long a conversation the reader left stays warm before it is let go of.
 *
 * Switching away used to release at once: the record's listener was stopped and the host was told
 * to close the session, so coming back paid an engine activation and a full transcript read again —
 * the pause the reader sees as "it loads, then everything appears at once". Keeping it for a minute
 * is what makes a switch back within that window free, and it is short enough that the host's own
 * session cap is never approached by conversations nobody is coming back to.
 */
const WARM_RELEASE_MS = 60_000

/**
 * How many conversations may stay warm at once.
 *
 * Deliberately below the host's own `MAX_LIVE_SESSIONS` (8): the warm set plus the conversation
 * being opened must fit under that cap, or registering the new one evicts a session this screen
 * still holds. What is over the cap is let go of immediately, oldest first — that is the price a
 * return to it pays instead of a switch in general.
 *
 * Owner: this module. Bound: this many timers (plus the ones re-armed for conversations still
 * working, each of which the host is holding anyway). Released: each timer when it fires, and with
 * the conversation's own row when it is deleted or the process ends.
 */
const WARM_RECORDS = 5

/**
 * How long the window may stay in the background before the idle warm conversations are let go.
 *
 * A warm conversation exists so the reader can come straight back to it; a window in the background
 * has no such return, and each warm entry is a live engine session (its tools, its language server,
 * its transcript) held for nobody. The grace keeps an alt-tab from churning the set; anything still
 * working is refused by `letGo`, so a turn the reader left running keeps running and its rows keep
 * arriving. The conversation **on screen** is never reclaimed by this: it is the one the reader is
 * coming back to (the host's own idle eviction may still drop it, and the return then rejoins it).
 */
const BACKGROUND_RECLAIM_MS = 15_000

/** The pending background reclaim, if the window is hidden and its grace has not run out. */
let backgroundReclaim: number | null = null

/**
 * Each workspace's blank conversation: the one "new conversation" last opened there.
 *
 * A conversation nothing has been sent in is handed over with a fresh session id every time the
 * desktop opens it, so the id is not what the reader's own work in it — the column they opened, the
 * shell they started — can be kept under (`state/blank-seat.ts`
 * is the rule that reads this). This is that id, kept per workspace so two workspaces can never come
 * back with each other's panel. It is dropped when the record it names is let go of for good, and a
 * conversation that has been written in is never matched by it.
 *
 * Owner: this module. Bound: one id per workspace. Released: with the record it names, when that
 * record is discarded.
 */
const blankSeats = new Map<number, string>()

/** The release scheduled for each warm conversation, in the order the reader left them. */
const warmReleases = new Map<string, () => void>()

/** Cancel a scheduled release for a conversation the reader has come back to. */
export function keepWarm(sessionId: string): void {
  const cancel = warmReleases.get(sessionId)
  if (cancel === undefined) return
  cancel()
  warmReleases.delete(sessionId)
}

/** Look again at one warm conversation when the window elapses, and let go of it if it is idle. */
function scheduleWarmRelease(sessionId: string): void {
  keepWarm(sessionId)
  const handle = setTimeout(() => {
    warmReleases.delete(sessionId)
    const record = sessionStore.get().records[sessionId]
    if (record === undefined) return
    // A conversation still working is one whose frames the rail and the next visit read: it is
    // kept (the host's eviction skips it too) and looked at again when the window elapses.
    if (isWorking(record)) {
      scheduleWarmRelease(sessionId)
      return
    }
    letGo(sessionId)
  }, WARM_RELEASE_MS)
  warmReleases.set(sessionId, () => clearTimeout(handle))
}

/**
 * Let go of a conversation without closing it yet.
 *
 * The listener stays up and the host keeps the session, so a return within {@link WARM_RELEASE_MS}
 * is a local state change and nothing else. Its streamed text is throttled while it waits (the
 * host is told the reader is not looking at it), so several conversations left behind do not each
 * cost a frame's worth of events.
 */
export function releaseLater(sessionId: string): void {
  const record = sessionStore.get().records[sessionId]
  if (record === undefined || record.id === sessionStore.get().activeId) return
  void sessionWatch(sessionId, false).catch(() => undefined)
  // Make room by letting go of the conversations that came first and are not working. A working
  // one cannot be released, and closing it under a turn is exactly what `letGo` refuses to do.
  for (const [candidate] of [...warmReleases]) {
    if (warmReleases.size < WARM_RECORDS) break
    const held = sessionStore.get().records[candidate]
    if (held !== undefined && isWorking(held)) continue
    keepWarm(candidate)
    letGo(candidate)
  }
  scheduleWarmRelease(sessionId)
}


/**
 * Each workspace's blank conversation, as the readers that hand it out ask for it.
 *
 * A seat names a record this process holds: it is remembered when one is created or adopted, and
 * forgotten in the same two places a record is discarded ({@link letGo}, {@link pruneRecords}).
 */
export function blankSeatFor(workspaceId: number): string | undefined {
  return blankSeats.get(workspaceId)
}

/** Remember the conversation a workspace's "new conversation" last opened. */
export function rememberBlankSeat(workspaceId: number, sessionId: string): void {
  blankSeats.set(workspaceId, sessionId)
}

/** Forget it, unless the id named a different conversation by then. */
function forgetBlankSeat(workspaceId: number, sessionId: string): void {
  if (blankSeats.get(workspaceId) === sessionId) blankSeats.delete(workspaceId)
}

function letGo(sessionId: string): void {
  keepWarm(sessionId)
  const record = sessionStore.get().records[sessionId]
  if (!record) return
  bumpRelease(sessionId)
  // A conversation nothing has been sent in is normally given back whole on the way out (its file
  // exists only because opening one writes it). **Unless the reader left work in it**: the work
  // column they opened and the shells it owns are real, and a blank conversation handed back takes
  // them with it — the terminal's own pty would be closed and the next "new conversation" would be a
  // different id that cannot show them (2026-10-26, user report). Such a conversation is kept like a
  // written one: its record stays warm, its file stays on disk, and returning to it is the same
  // rejoin. Its panel state is what closes it — closing the last tab and the column is the reader
  // saying they are done with it.
  //
  // **And it is only ever the draft's ask.** A conversation rewound to its first prompt reads like
  // one; what the list says decides (`state/session-rows.ts::dropsFileOnRelease`).
  const discard =
    dropsFileOnRelease(record, findSummary(record.workspaceId, sessionId)) &&
    !ownsPanelState(sessionId)
  if (isWorking(record) && !discard) return
  // The conversation is going back to the host: the messages queued behind its turn go with it,
  // because there is no longer a turn for them to follow. The composer's draft stays where it is:
  // it lives in the conversation's own seat (`state/composer-draft-store.ts`), so letting go of the
  // record neither carries it to the next conversation nor loses it when this one comes back. A
  // blank conversation's draft is kept by its workspace's seat, which outlives the id this record
  // is about to drop (2026-10-22).
  clearQueuedPrompts(sessionId)
  stopListening(sessionId)
  // Nobody is looking at it from here on: the bridge may coalesce its stream over the background
  // window, and the next adopt asks whether the host still holds it.
  void sessionWatch(sessionId, false).catch(() => undefined)
  if (discard) {
    sessionStore.set((state) => {
      const records = { ...state.records }
      delete records[sessionId]
      return { ...state, records }
    })
    forgetSessionActivity(sessionId)
    forgetVisit(sessionId)
    // The id goes back to the engine with the conversation, so the column's state naming it can
    // never be shown again: a terminal opened here would keep its pty (and its mounted panel) for a
    // conversation that no longer exists. Releasing it here is the one release point this path has;
    // the list-driven prune in `home/ChatAppHome.tsx` cannot see a conversation that was never in a
    // list to begin with. The workspace's blank seat goes with it, so "new conversation" there
    // creates one rather than naming a record nobody holds.
    forgetBlankSeat(record.workspaceId, sessionId)
    forgetSession(sessionId)
  }
  void sessionClose(sessionId, discard).catch(() => undefined)
  // A conversation just released is the first candidate a budget can shed: without this, the row
  // budget would only be enforced at the next switch.
  pruneRecords()
}

/**
 * Put a conversation back after a forced stop took its host session down.
 *
 * The active conversation is reloaded: its rows stay on screen and the reopen merges what the file
 * holds, so the reader lands in the same conversation with its history. One nobody is looking at is
 * only unsubscribed — the host session is already gone, which is what reclaiming it was for, and the
 * record (including any prompts the reader queued behind the stuck turn) stays warm. The next visit
 * sees `listening === false` and rejoins it, the same path a released conversation takes.
 */
export function afterReclaim(sessionId: string): void {
  if (sessionStore.get().activeId === sessionId) void rejoin(sessionId)
  else stopListening(sessionId)
}

/** Shed the conversations nobody is in reach of, oldest visit first, down to both ceilings. */
export function pruneRecords(): void {
  const state = sessionStore.get()
  // Before the judgement below, which refuses any conversation the column holds (`panel-store.ts`).
  trimPanelSessions(state.activeId)
  const held = Object.keys(state.records)
  // Two bounds, because a count of conversations is not a memory bound: sixteen long conversations
  // are hundreds of megabytes of rows nobody is reading (`RETAINED_MESSAGES`).
  let remainingRows = held.reduce(
    (total, id) => total + state.records[id].messages.length,
    0,
  )
  if (held.length <= RETAINED_RECORDS && remainingRows <= RETAINED_MESSAGES) return
  // A conversation holding queued prompts is not recyclable: those are messages the reader has
  // already asked to send, and dropping the record would drop them with it. That exclusion is also
  // what bounds the queue — `RETAINED_RECORDS` conversations at `MAX_QUEUED_PROMPTS` each.
  //
  // The same goes for one whose work column holds anything: the record is the only thing its tabs
  // can be reached by, so shedding it for budget while a shell keeps running would leave a pty (and
  // its tab state) no conversation names any more. That is the reader's own work, and it bounds
  // itself — closing a tab and the column is what lets go of the conversation (`letGo`).
  const recyclable = held
    .filter(
      (id) =>
        id !== state.activeId &&
        !isWorking(state.records[id]) &&
        !state.records[id].listening &&
        !hasQueuedPrompts(id) &&
        !ownsPanelState(id),
    )
    .sort((left, right) => visitRank(left) - visitRank(right))
  let excess = held.length - RETAINED_RECORDS
  if (excess <= 0 && remainingRows <= RETAINED_MESSAGES) return
  sessionStore.set((previous) => {
    const records = { ...previous.records }
    for (const id of recyclable) {
      if (excess <= 0 && remainingRows <= RETAINED_MESSAGES) break
      remainingRows -= previous.records[id].messages.length
      const workspaceId = previous.records[id].workspaceId
      forgetBlankSeat(workspaceId, id)
      delete records[id]
      forgetSessionActivity(id)
      forgetVisit(id)
      clearQueuedPrompts(id)
      excess -= 1
    }
    return { ...previous, records }
  })
}

/**
 * Give back what a window nobody is looking at does not need.
 *
 * The conversation on screen stays open (it is the reader's place, and the cheapest thing to come
 * back to), and anything working is refused by `letGo`: a turn left running in the background keeps
 * its session, its engine and its rows. What goes is the warm set - conversations the reader left,
 * which exist only to make an immediate return free, and each of which is a live engine session
 * (tools, language server, transcript) held for nobody while the window is away. Coming back to one
 * of them shows its cached rows at once and merges what was written since, exactly as a return past
 * the warm window already does.
 */
function reclaimBackground(): void {
  backgroundReclaim = null
  const activeId = sessionStore.get().activeId
  for (const [sessionId] of [...warmReleases]) {
    if (sessionId === activeId) continue
    const record = sessionStore.get().records[sessionId]
    if (record !== undefined && !isWorking(record)) letGo(sessionId)
  }
  pruneRecords()
}


/**
 * Start the background grace, if one is not already running.
 *
 * Owned here: the handle is this module's, and the caller that changes the window's state only says
 * which way it went ({@link scheduleBackgroundReclaim}, {@link cancelBackgroundReclaim}).
 */
export function scheduleBackgroundReclaim(): void {
  if (backgroundReclaim !== null) return
  backgroundReclaim = setTimeout(reclaimBackground, BACKGROUND_RECLAIM_MS) as unknown as number
}

/** Stop it: the window is back in front of the reader, and the warm set is not going anywhere. */
export function cancelBackgroundReclaim(): void {
  if (backgroundReclaim === null) return
  clearTimeout(backgroundReclaim)
  backgroundReclaim = null
}
