/**
 * One `task` child's own conversation, read for the tab the reader opened on it.
 *
 * A subagent is a session of the engine's own that this desktop never opens, lists or evicts: its
 * transcript is a file beside the conversation that spawned it (`session_children`), and its live
 * frames arrive on a channel of its own (`omp:session:<childId>`, published by the host's child
 * projector). So a child is read the same way a conversation is — a transcript walk plus a listener
 * — and folded with the same reducer (`state/transcript.ts::foldTranscript`): there is one row model
 * in this app, and a second one for children would be a second set of bugs.
 *
 * **One listener per child, ever.** A frame is folded by the listener that carries it, so a second
 * one would fold every frame twice — the conversation would read back with each word repeated. The
 * registration is keyed by the child's id and remembered while it is in flight, exactly as
 * `session-stream.ts` does it for conversations; this module keeps its own bookkeeping because a
 * child is not a conversation and has no record in `session-store.ts`.
 *
 * **A frame that arrives mid-walk waits.** The rows a walk is about to write are the file's, and a
 * frame folded into them first would be overwritten by the read it preceded. The walk takes a hold,
 * frames queue behind it, and the queue is folded in — in order, in one write — when the read lands.
 *
 * Owner / bound / release point (`rules.md#resource-bounds-and-release-points`): this module owns the four maps below and the
 * views store. The bound is **the tabs the reader has open**: one view per `subagent:` tab in the
 * right column's strip, and one listener, one generation and one hold per view. The release point is
 * `closeSubagentView` — called by the panel when its tab closes, which is the same moment the tab
 * leaves the strip (`state/panel-store.ts::closeSubagentTab`, `forgetSession`).
 */

import { useCallback } from 'react'

import { sessionChannel, subscribe, toApiError, type ApiError } from '@/api/client'
import { childWatch, sessionChildren, sessionHistory } from '@/api/agent'
import type { SessionEvent } from '@/api/session-types'
import { fileStemName } from '@/lib/file-path'
import {
  flushPresent,
  onPresent,
  schedulePresent,
} from '@/state/presentation'
import { createStore, useStoreSelector } from '@/state/store'
import {
  EMPTY_TRANSCRIPT,
  foldTranscript,
  mergeTranscript,
  type TranscriptState,
} from '@/state/transcript'

/**
 * How many times a child's transcript is looked for before the view gives up.
 *
 * The engine creates the child's file when it spawns it, and the reader can open the tab from the
 * roster row that names it before the file is there. Five looks four hundred milliseconds apart
 * covers the spawn with room to spare, and a file that is still absent after two seconds is absent
 * — the reader is told so rather than left on a line that never resolves.
 */
const RESOLVE_ATTEMPTS = 5
/** The wait between two looks at the child list, in milliseconds. */
const RESOLVE_RETRY_MS = 400

/** One child's conversation, as the panel that draws it needs it. */
export interface SubagentView {
  /**
   * The id the child's own frames arrive under, once the child was resolved; null before that.
   *
   * It is also what the feed's reader place is keyed by, which is exactly right: a child's scroll
   * position is its own.
   */
  sessionId: string | null
  status: 'resolving' | 'loading' | 'ready' | 'error'
  /**
   * Why the view failed, when it did: the desktop's own code and words.
   *
   * `null` with `status: 'error'` is the one failure the desktop never named — the child's
   * transcript was not there to read — and the panel says so in this side's own words.
   */
  error: ApiError | null
  /** The child's own transcript file; a `task` inside the child addresses its children by it. */
  filePath: string | null
  transcript: TranscriptState
  /** How much of the transcript has been read, and how much the desktop reported in total. */
  loaded: number
  total: number
}

export interface SubagentViewState {
  /** Child id → the open view of it. */
  views: Record<string, SubagentView>
}

export const subagentViewStore = createStore<SubagentViewState>({ views: {} })

/** Unsubscribe handles for the children being listened to, keyed by the child's id. */
const listeners = new Map<string, () => void>()
/**
 * The registration in flight for one child, so two opens cannot register two listeners.
 *
 * It is deliberately *not* cleared when a view closes: a child closed and reopened while its
 * registration was still in flight must share that one registration, or the second open would
 * register a second listener and every frame of the child would be folded twice.
 */
const registering = new Map<string, Promise<void>>()
/** Frames held while a child's transcript is being walked, replayed after it lands. */
const holding = new Map<string, SessionEvent[]>()
/**
 * Frames waiting for the next presentation tick, per child.
 *
 * A child streams its own turn at the same rate a conversation does, and that panel may be open
 * while the reader is in another application — the case where a hidden window used to re-render the
 * child's transcript on every frame. They ride the same tick as the conversations
 * (`state/presentation.ts`) and are folded one write per child. Bound: `CHILD_PENDING_MAX` per
 * child, and the open tabs the panel keeps; released with the tick and with a closed view.
 */
const pendingChildren = new Map<string, SessionEvent[]>()

/** Frames one child may queue before the queue is folded early. */
const CHILD_PENDING_MAX = 512
/**
 * The open each child is currently on, so a step that outlived its open can tell.
 *
 * A close deletes the entry and a reopen writes a fresh number, so a read that was waiting on the
 * desktop when the reader closed the tab writes nothing into whatever took its place. One entry per
 * *open* child, released with the view.
 */
const generations = new Map<string, number>()
let nextGeneration = 0

function viewOf(childId: string): SubagentView | undefined {
  return subagentViewStore.get().views[childId]
}

/** Whether one open is still the live one: a closed or reopened child is a different generation. */
function live(childId: string, generation: number): boolean {
  return generations.get(childId) === generation
}

/** Write one child's view, unless it was closed while this write was on its way. */
function write(childId: string, next: SubagentView): void {
  subagentViewStore.set((state) => ({ views: { ...state.views, [childId]: next } }))
}

/** Change one child's view in place, unless it was closed while this change was on its way. */
function patch(childId: string, change: (view: SubagentView) => SubagentView): void {
  const current = viewOf(childId)
  if (current === undefined) return
  const next = change(current)
  if (next === current) return
  write(childId, next)
}

/**
 * Fold one frame into the child it is about.
 *
 * The listener is per child, so this is the only path a frame takes and it takes it once: the frame
 * is held while that child's transcript is being walked, and queued for the shared presentation
 * tick otherwise.
 */
function handleFrame(childId: string, event: SessionEvent): void {
  const held = holding.get(childId)
  if (held !== undefined) {
    held.push(event)
    return
  }
  const queued = pendingChildren.get(childId)
  if (queued === undefined) {
    pendingChildren.set(childId, [event])
  } else {
    queued.push(event)
    if (queued.length >= CHILD_PENDING_MAX) {
      flushPresent()
      return
    }
  }
  schedulePresent()
}

/** Fold every queued child, one write each. Registered with the shared presentation tick. */
function flushChildFrames(): void {
  if (pendingChildren.size === 0) return
  const batches = [...pendingChildren]
  pendingChildren.clear()
  for (const [childId, frames] of batches) {
    patch(childId, (view) => {
      const transcript = frames.reduce(
        (current, frame) => foldTranscript(current, frame),
        view.transcript,
      )
      return transcript === view.transcript ? view : { ...view, transcript }
    })
  }
}

onPresent(flushChildFrames)

/**
 * Start reading a child's frames, once.
 *
 * The registration is remembered while it is in flight, so two opens of one child can never leave
 * two listeners on one channel — the state that folds every frame twice. A registration that answers
 * after the view was closed is unsubscribed rather than kept, exactly as a conversation's is.
 */
function ensureListening(childId: string, sessionId: string): Promise<void> {
  if (listeners.has(childId)) return Promise.resolve()
  const inFlight = registering.get(childId)
  if (inFlight) return inFlight
  const task = subscribe<SessionEvent>(sessionChannel(sessionId), (event) =>
    handleFrame(childId, event),
  )
    .then((unlisten) => {
      if (viewOf(childId) === undefined) {
        unlisten()
        return
      }
      listeners.set(childId, unlisten)
    })
    .catch(() => {
      // A channel that cannot be registered is one this child is read from disk only: its rows stay
      // readable, and only the live half of a running child is lost.
    })
    .finally(() => {
      if (registering.get(childId) === task) registering.delete(childId)
    })
  registering.set(childId, task)
  return task
}

/** Hold this child's frames until its transcript read lands. */
function beginHold(childId: string): void {
  // Frames that arrived before the hold are older than the rows the read is about to write.
  flushPresent()
  if (holding.has(childId)) return
  holding.set(childId, [])
}

/** Fold in, in order and in one write, everything that arrived while the read ran. */
function endHold(childId: string): void {
  const frames = holding.get(childId)
  holding.delete(childId)
  if (frames === undefined || frames.length === 0) return
  patch(childId, (view) => ({
    ...view,
    transcript: frames.reduce(
      (transcript, frame) => foldTranscript(transcript, frame),
      view.transcript,
    ),
  }))
}

/**
 * Look for the child's transcript, waiting out the moment before the engine has written it.
 *
 * The file a child is stored in is created when the engine spawns it, and the roster row that opens
 * this view can be drawn before that — so a miss is not an answer yet. A *refused* call is one: the
 * desktop does not retry its own reads and neither does this, because a refusal is a decision rather
 * than a race. Anything still missing after the last look is reported as missing.
 */
async function resolveChild(
  parentSessionId: string,
  parentSessionFile: string,
  childId: string,
): Promise<{ sessionId: string; filePath: string } | null> {
  for (let attempt = 0; attempt < RESOLVE_ATTEMPTS; attempt += 1) {
    const answer = await sessionChildren(parentSessionId, parentSessionFile)
    const child = answer.children.find((entry) => fileStemName(entry.filePath) === childId)
    if (child !== undefined) return { sessionId: child.id, filePath: child.filePath }
    if (attempt < RESOLVE_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, RESOLVE_RETRY_MS))
    }
  }
  return null
}

/** Read the child's rows, with the frames that arrive meanwhile held behind the read. */
async function load(
  childId: string,
  generation: number,
  sessionId: string,
  filePath: string,
): Promise<void> {
  beginHold(childId)
  try {
    await ensureListening(childId, sessionId)
    if (!live(childId, generation)) return
    const history = await sessionHistory(
      sessionId,
      (chunk) => {
        if (!live(childId, generation)) return
        patch(childId, (current) => ({ ...current, loaded: chunk.loaded, total: chunk.total }))
      },
      filePath,
      // The child's first user message is its assignment: the reader opened this tab to see what
      // it was asked, so that message is a row here even though the desktop hides the engine's
      // other injected prompts.
      { taskPrompt: true },
    )
    if (!live(childId, generation)) return
    patch(childId, (current) => ({
      ...current,
      status: 'ready',
      error: null,
      loaded: history.totalMessages,
      total: history.totalMessages,
      transcript: {
        ...current.transcript,
        messages: mergeTranscript(current.transcript.messages, history.messages),
      },
    }))
  } catch (error) {
    if (!live(childId, generation)) return
    patch(childId, (current) => ({ ...current, status: 'error', error: toApiError(error) }))
  } finally {
    endHold(childId)
  }
}

/** Find the child's transcript and read it, unless this open was closed while it waited. */
async function start(
  childId: string,
  generation: number,
  parentSessionId: string,
  parentSessionFile: string,
): Promise<void> {
  try {
    const child = await resolveChild(parentSessionId, parentSessionFile, childId)
    if (!live(childId, generation)) return
    if (child === null) {
      // The one failure the desktop never named: there was no transcript to read.
      patch(childId, (current) => ({ ...current, status: 'error', error: null }))
      return
    }
    patch(childId, (current) => ({
      ...current,
      status: 'loading',
      sessionId: child.sessionId,
      filePath: child.filePath,
    }))
    await load(childId, generation, child.sessionId, child.filePath)
  } catch (error) {
    if (!live(childId, generation)) return
    patch(childId, (current) => ({ ...current, status: 'error', error: toApiError(error) }))
  }
}

/**
 * Open one child's conversation: find its transcript, then read it and follow it.
 *
 * Idempotent per child: a child that already has a view — one still being resolved included — is
 * left exactly as it is, so the panel's mount effect cannot end up with two listeners folding the
 * same frame twice. The view is written before anything is awaited, so the guard is a fact of this
 * one synchronous step rather than a flag two callers could race for.
 */
export function openSubagentView(
  childId: string,
  parentSessionId: string,
  parentSessionFile: string,
): void {
  if (viewOf(childId) !== undefined) return
  nextGeneration += 1
  const generation = nextGeneration
  generations.set(childId, generation)
  write(childId, {
    sessionId: null,
    status: 'resolving',
    error: null,
    filePath: null,
    transcript: EMPTY_TRANSCRIPT,
    loaded: 0,
    total: 0,
  })
  // The bridge projects a child's per-token events only for a tab that draws them; the walk below
  // covers what happened before this watch, and the subscription picks up from here.
  void childWatch(childId, true).catch(() => undefined)
  void start(childId, generation, parentSessionId, parentSessionFile)
}

/**
 * Stop reading one child's frames and forget its view.
 *
 * Letting go of a child is one act, so it is one call: a frame still queued behind a walk of a child
 * nobody holds any more has nothing left to be folded into, and the view itself would otherwise sit
 * in the store until the process ended. The registration in flight is deliberately left alone — it
 * unsubscribes itself when it lands and finds no view, and a reopen that shares it can never end up
 * with two listeners.
 */
export function closeSubagentView(childId: string): void {
  void childWatch(childId, false).catch(() => undefined)
  const unlisten = listeners.get(childId)
  if (unlisten) {
    unlisten()
    listeners.delete(childId)
  }
  holding.delete(childId)
  pendingChildren.delete(childId)
  generations.delete(childId)
  if (viewOf(childId) === undefined) return
  subagentViewStore.set((state) => {
    const views = { ...state.views }
    delete views[childId]
    return { views }
  })
}

/** One child's view, or null while it is closed. Read by the panel that draws it. */
export function useSubagentView(childId: string): SubagentView | null {
  // The panel is mounted per child (`key`), so this closure is built once per view and the hook's
  // state-identity cache stays honest — an inline selector would hand back the previous child's
  // cached value the moment two panels shared one render.
  const select = useCallback(
    (state: SubagentViewState) => state.views[childId] ?? null,
    [childId],
  )
  return useStoreSelector(subagentViewStore, select)
}
