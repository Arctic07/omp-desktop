/**
 * One session's children: the ids still running, and the frames that report them.
 *
 * The engine publishes a child on two channels of the bus a session is given - a lifecycle edge
 * when it starts and when it settles, and a coalesced progress snapshot while it runs - and that
 * bus is root-scoped, so every descendant of the session reports here, not only its own spawns.
 * Two things are made of those frames: the session's wire frame, which the roster is drawn from,
 * and the set of ids a `stop` still has to cancel, because the engine offers no user-facing
 * cancel for its background work (its `/jobs` panel is display-only). That same set is also the
 * third part of the session's busy fact - the turn is the engine's to report, but a child running
 * with no turn is something only this watch knows (see `session-stop.ts`'s `isWorking`).
 *
 * Frames are the wire's source, not the stop path's only one: what a stop has to cancel is asked
 * of this watch (`liveIds`), and that answer unions the frame set with the engine's own registry
 * for this session's children, because the frame set only holds what arrived while this record was
 * watching. A background (`task`) batch outlives a release: its children were given the bus of the
 * record that spawned them, so the record opened after it hears nothing from them at all - and the
 * one channel that does keep arriving, a progress snapshot, cannot open a child here either, since
 * its `running` status reads as settled (`#note`). The registry cannot miss a child the engine
 * started, and it is where the ids a stop kills were always looked up from (`cancel`).
 *
 * A third channel of that bus carries a child's *own* session events (`{id, event}`), which this
 * watch forwards as they arrive (`#noteEvent`) so a screen attached to that child's transcript can
 * draw its live turn. Those frames are passed on and nothing else: they say nothing about which
 * children exist or are running, so the roster and the stop set are built from the two above only.
 * What they do need is the transcript they belong to, which the engine's registry answers for until
 * a stop releases the child it killed - so the file the roster frames reported is kept as well
 * (`#rememberFile`), and a cancelled child's last frames are still addressable.
 */

import { MAX_TRACKED_SUBAGENTS } from './constants.ts'
import { logError, logLine } from './log.ts'
import type { EventBus, SdkBundle } from './sdk.ts'
import { isToolMountNotice } from './session-view.ts'

/** The two channels a subagent frame comes in on, as the wire frame spells them. */
type SubagentFrameKind = 'lifecycle' | 'progress'

/**
 * The child a frame is about, what it reports, and where its transcript is.
 *
 * The channels nest the child differently - the lifecycle payload names it at its top level, the
 * progress payload nests the whole snapshot under `progress` - so this is the one place that knows
 * where to look, instead of every reader casting twice. A frame whose id is missing names no child
 * this host could cancel; it is still forwarded, since the frontend projects the payload itself.
 *
 * `sessionFile` is read from the payload's own top level, where both channels carry it: it is the
 * transcript the engine writes for the child, and the watch keeps it because the registry lookup a
 * child-event frame performs is exactly what a stop empties (`#sessionFileOf`).
 */
function frameSubject(
  kind: SubagentFrameKind,
  payload: unknown,
): { id: string; status: string | undefined; sessionFile: string | undefined } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const source = kind === 'lifecycle' ? record : record.progress
  if (typeof source !== 'object' || source === null) return undefined
  const fields = source as Record<string, unknown>
  const id = fields.id
  if (typeof id !== 'string' || id === '') return undefined
  const file = record.sessionFile
  return {
    id,
    status: typeof fields.status === 'string' ? fields.status : undefined,
    sessionFile: typeof file === 'string' && file !== '' ? file : undefined,
  }
}

/**
 * What one stop did to a session's children.
 *
 * Two readers, two halves: the stop path answers `aborted` from `killed` (the engine's own line -
 * a kill that did not land is not claimed), and silences the results of every id in `ended`,
 * because each of those children is off the roster now and will otherwise deliver its result back
 * into the session as a fresh wake.
 */
export interface SubagentCancelOutcome {
  /** Ids this stop ended: killed, or found gone from the registry while the loop was in flight. */
  readonly ended: string[]
  /** How many of those the engine's own `release` took; a child that ended by itself is not one. */
  readonly killed: number
}

/** Everything one watch needs that is fixed for the session it belongs to. */
interface SubagentWatchContext {
  readonly sdk: SdkBundle
  /** The session's own bus, which its children were given as well. */
  readonly bus: EventBus
  /** Routing id of the session, for the log lines. */
  readonly sessionId: string
  /** Publishes one frame on the session's event pipe, exactly as it goes out. */
  readonly publish: (frame: Record<string, unknown>) => void
  /**
   * Called for every child-event frame this watch drops instead of forwarding.
   *
   * The drop itself is this watch's decision (it is the side that knows the child has no
   * transcript), but the counting is not: the record's loss counters are the same ones the
   * outbound queue's shedding charges (`sessions.ts`'s `losses`), and a frame lost before the
   * queue must land in the same place as one lost inside it, or a session's `droppedFrames` would
   * be a smaller number than the truth.
   */
  readonly onEventDropped: () => void
  /**
   * Called when the live set gained or lost an id.
   *
   * A change here is a change of the session's own busy fact, which the state view publishes, so
   * the record that owns the pipe has to be told - the watch owns the set, not the view.
   */
  readonly onLiveChange: () => void
}

/**
 * The children one session has spawned, as they are observed and as they are cancelled.
 *
 * Every roster frame is forwarded on arrival, so the wire sees what the engine reported in the
 * order it reported it; the live set is updated from the same frames, so a frame the outbound queue
 * sheds under backpressure still leaves a running child cancellable and the session still counted
 * busy.
 *
 * The stop path and the busy fact read the engine's registry beside that set (`liveIds`), so the
 * children no frame reported are cancellable too. Every change of that set is reported on
 * (`onLiveChange`) because it changes what the session's state view says about remaining work.
 */
export class SubagentWatch {
  readonly #context: SubagentWatchContext
  readonly #unsubscribe: Array<() => void>
  /**
   * Ids whose work is not over yet, oldest first.
   *
   * A map rather than a set because the bound drops the oldest entry, and insertion order is what
   * says which one that is.
   */
  readonly #live = new Map<string, true>()
  /**
   * Ids whose lifecycle edge already ended them.
   *
   * The one thing standing between a child's own tail and a resurrection: its last progress frame
   * can arrive after the edge that settled it (`#note` keeps the frame, and the row the frontend
   * draws, settled). Bounded exactly like the live set, because what it is for is ids a stop could
   * still be asked about, not an archive.
   */
  readonly #forget = new Map<string, true>()
  /**
   * Transcripts the roster frames named for the children they reported.
   *
   * A child's own events are addressed by its transcript, and the host reads that file from the
   * registry - which is exactly what a stop empties: `cancel` aborts each child it kills and
   * releases its registration, and the child's own last frames (the turn end its abort produced,
   * which is the one frame that says the child's work is over) can arrive with nothing left to
   * resolve a file in. A screen attached to that child would then read a turn nothing ever settles.
   * The file every roster frame already carries is remembered here instead, so the frames after a
   * release are addressed as well as the ones before it.
   *
   * Bounded exactly like the live set, and for the same reason: what it answers is the children
   * whose frames are still arriving, not an archive of every child a session ever ran.
   */
  readonly #files = new Map<string, string>()
  /**
   * Drop reasons already reported at the log.
   *
   * A child with no transcript drops its whole event stream, so reporting every dropped frame
   * would cost a log line per token. The set is what makes the report one line per reason instead;
   * the counters keep the exact number (`onEventDropped`).
   */
  readonly #reportedEventDrops = new Set<string>()

  constructor(context: SubagentWatchContext) {
    this.#context = context
    this.#unsubscribe = [
      context.bus.on(context.sdk.subagentLifecycleChannel, payload => this.#note('lifecycle', payload)),
      context.bus.on(context.sdk.subagentProgressChannel, payload => this.#note('progress', payload)),
      context.bus.on(context.sdk.subagentEventChannel, payload => this.#noteEvent(payload)),
    ]
  }

  /**
   * Ids of the children this session still has running: the frames' set first, the registry's
   * additions after it.
   *
   * One call answers the stop path's two questions - whether there is a child to cancel, and which
   * ones - because the set is private and a count would only be read to test emptiness. A copy, so
   * a caller cannot hold a view of a set that frames keep changing.
   *
   * `ownerId` is the session's own agent id, which is what a child records as its `parentId`. The
   * frame set alone is not evidence that a session has no children - it only holds what arrived
   * while this record was watching - so the engine's registry is read as well and the two are
   * unioned. A caller that cannot name the owner (the state projection counting cancellable
   * children) gets the frames' set alone: with no owner id there is nothing to attribute a
   * registry ref to, and reading the wrong agent's children as this session's would be worse than
   * reading none.
   */
  liveIds(ownerId?: string): string[] {
    const ids = new Set(this.#live.keys())
    for (const id of this.#registryLiveIds(ownerId)) ids.add(id)
    return [...ids]
  }

  /**
   * The ids the engine's own registry holds as running children of `ownerId`.
   *
   * The registry is the authority the frames only report on: a `task` child is registered before it
   * runs (`sdk.ts:3970-3983`, with `kind` from `isSubagentSession` - `sdk.ts:2035` - and
   * `parentId` taken from the spawner's own `getAgentId()` - `task/structured-subagent.ts:682`), and
   * it stays registered while it runs, whether or not a frame about it ever reached this host. That
   * is the case a stop used to miss: a background batch spawned before this record was watching (a
   * released session opened again) leaves the frame set empty, its children unkillable, and the
   * session reading idle under work it is still holding.
   *
   * The filter is the ownership rule the cancel loop applies again before it kills - `kind === 'sub'`
   * and this session's own id as parent - so an id this answers with is one that loop may act on,
   * and `running` is the engine's own word for a child that still has work (its `idle`/`parked`/
   * `aborted` rows are over).
   *
   * An empty or failed scan answers with nothing rather than failing the caller: a stop must not
   * fail because the registry could not be read.
   */
  #registryLiveIds(ownerId: string | undefined): string[] {
    if (ownerId === undefined) return []
    try {
      const refs = this.#context.sdk.AgentRegistry.global().list()
      return refs
        .filter(ref => ref.kind === 'sub' && ref.parentId === ownerId && ref.status === 'running')
        .map(ref => ref.id)
    } catch (error) {
      logError(`session ${this.#context.sessionId} subagent registry scan failed`, error)
      return []
    }
  }

  /**
   * Cancels every live child with the primitives the pinned engine exports.
   *
   * The ids are this watch's own answer (`liveIds`): the children its frames reported, plus the
   * ones the engine's registry holds as running for this session - a child whose frames never
   * reached this record is still a child a stop has to end. Every id is then put through the same
   * three steps and the same ownership check, so the two sources differ in where they are
   * discovered and nowhere else.
   *
   * The engine's own helper for a kill is `cancelAgentRegistration` (`async/job-control.ts:417`),
   * and it is not usable here: it takes a `ToolSession` (this host drives sessions through
   * `createAgentSession` and holds no tool session), it refuses every id whose `parentId` is not the
   * `ownerId` it is handed (a stop with no owner id would cancel nothing), and it releases without
   * the `tombstone` this host's roster needs (see step 3). So the same steps are written here
   * against the exports both paths share:
   *
   * 1. `AgentRegistry.global().get(id)` - the process-global registry, because that is where a
   *    `task` child of this session actually is: the engine registers a session into
   *    `options.agentRegistry ?? AgentRegistry.global()` (`sdk.ts:2134`), and no spawn path
   *    forwards a caller's registry to a child (`task/structured-subagent.ts`, `task/executor.ts`).
   * 2. When the child is running, `ref.session.abort({ reason })` - the same interrupt reason the
   *    stop gave the turn.
   * 3. `AgentLifecycleManager.global().release(id, ref, { tombstone: true })` - the engine's own
   *    explicit kill (`registry/agent-lifecycle.ts:441`): it detaches the ref, marks it terminal
   *    `aborted` and disposes the captured session.
   *
   * Ownership is checked here because `release` itself takes any matching ref: a ref of another
   * kind, or one whose parent is another agent, is refused - a cross-agent kill stays impossible.
   * Such an id is left in the live set (it is genuinely still working, and its own settled frame is
   * what clears it) rather than reported as ended. `ownerId` is the session's own agent id, read
   * from the session rather than assumed, because the engine decides what "this session" is.
   *
   * Never throws: a stop that already ended the turn must not fail because one child was gone.
   * Every child that is now over - killed, or already gone from the registry - leaves the live set,
   * and is published as a terminal `aborted` lifecycle frame if it is still counted there, because
   * the release has just taken its session away and no later frame would correct a roster still
   * reading it as running (a detached batch's `task` result returns with `results: []` before its
   * children finish). A child that reported its own settlement while this loop was in flight is
   * left with the verdict it published. A kill that threw keeps its id, so a later stop still sees
   * that child, and only a `release` that actually took the registration counts as a kill.
   *
   * What it answers is [`SubagentCancelOutcome`]: the ids it took off the roster, and how many of
   * those it actually killed. The caller needs the ids because a child's run ending is not the end
   * of it - the engine delivers that run's result back into the session, which wakes it - so the
   * stop path silences exactly the children this call ended, and nothing else.
   */
  async cancel(ownerId: string | undefined, reason: string): Promise<SubagentCancelOutcome> {
    const ids = this.liveIds(ownerId)
    if (ids.length === 0) return { ended: [], killed: 0 }
    const { sdk, sessionId } = this.#context
    const registry = sdk.AgentRegistry.global()
    const lifecycle = sdk.AgentLifecycleManager.global()
    const settled = await Promise.allSettled(
      ids.map(async id => {
        const ref = registry.get(id)
        if (ref === undefined) return { id, killed: false, ended: true, file: this.#files.get(id) }
        if (ref.kind !== 'sub' || (ownerId !== undefined && ref.parentId !== ownerId)) {
          return { id, killed: false, ended: false, file: undefined }
        }
        if (ref.status === 'running' && ref.session !== null) await ref.session.abort({ reason })
        // `release` answers whether it took a matching ref. False means the child's own teardown
        // removed its registration while the abort above was in flight - it ended by itself, so
        // this is not a kill and the stop must not claim one (the engine's own kill path for this
        // situation draws the same line: it answers `already_completed` rather than `cancelled`
        // when the sequence did not land as a kill, `async/job-control.ts:386-395`).
        const released = await lifecycle.release(id, ref, { tombstone: true })
        const file = typeof ref.sessionFile === 'string' && ref.sessionFile !== '' ? ref.sessionFile : undefined
        return { id, killed: released, ended: true, file }
      }),
    )
    const ended: string[] = []
    let cancelled = 0
    for (const result of settled) {
      if (result.status === 'rejected') {
        logError(`session ${sessionId} subagent cancel failed`, result.reason)
        continue
      }
      const { id, killed, ended: over, file } = result.value
      if (!over) {
        logLine(`session ${sessionId} left subagent ${id} alone: not this session's own child`)
        continue
      }
      // Only a child still counted as running is relabelled. One that settled on its own while
      // another child's abort await was in flight already left the set through its own honest
      // frame (`#note` drops it there), and stamping `aborted` over a `completed`/`failed` verdict
      // would be a lie about work it finished.
      //
      // The frame carries the transcript the child's own channel is addressed by, because this is
      // the frame that has to end a screen still attached to that child: the release above took the
      // registration a later lookup would have read the file from, and the child's own turn end can
      // be lost in the same window (`#sessionFileOf` for the other half of this).
      if (this.#live.has(id)) this.#note('lifecycle', { id, status: 'aborted', sessionFile: file })
      ended.push(id)
      if (killed) cancelled += 1
    }
    // What the stop actually did, against how many children it was looking at: a kill that landed
    // on none of a non-empty set is the shape of a stop that read the wrong set, and the one line a
    // later report of "the stop did nothing" is checked against.
    if (cancelled > 0) logLine(`session ${sessionId} stop cancelled ${cancelled} of ${ids.length} child(ren)`)
    return { ended, killed: cancelled }
  }

  /** Drops every subscription the watch holds and forgets the children it tracked; a disposed session publishes nothing. */
  dispose(): void {
    for (const unsubscribe of this.#unsubscribe) unsubscribe()
    this.#unsubscribe.length = 0
    this.#live.clear()
    this.#forget.clear()
    this.#files.clear()
    this.#reportedEventDrops.clear()
  }

  /**
   * Forwards one frame and keeps the live set in step with it.
   *
   * A child becomes live on the frame that starts it, or on the first progress frame naming an id
   * this watch has not seen, and stops being live on the status that says its work is over. The
   * frame goes out first and the change is reported after it, so a reader that sees the state
   * frame has already seen the child frame it accounts for.
   */
  #note(kind: SubagentFrameKind, payload: unknown): void {
    const subject = frameSubject(kind, payload)
    let changed = false
    if (subject !== undefined) {
      // Before the frame can be answered about: a child's own events are addressed by this file,
      // and the registry that also answers for it is emptied by the very stop whose kill produces
      // the child's last frames (`#sessionFileOf`).
      if (subject.sessionFile !== undefined) this.#rememberFile(subject.id, subject.sessionFile)
      const settled = subject.status !== undefined && subject.status !== 'started'
      if (kind === 'lifecycle') {
        if (settled) {
          changed = this.#live.delete(subject.id)
          this.#forget.set(subject.id, true)
        } else if (!this.#live.has(subject.id)) {
          this.#live.set(subject.id, true)
          this.#forget.delete(subject.id)
          changed = true
        }
      } else if (!settled && !this.#live.has(subject.id) && !this.#forget.has(subject.id)) {
        // A progress frame may open a child this watch has never seen - it is the channel that
        // keeps arriving for a batch that was already running when a session was reopened, and
        // without this a reopened session could neither read as busy nor stop what it holds. What
        // it may not do is reopen one whose own lifecycle edge already ended it: progress is the
        // child talking about itself and its last frame can arrive after that edge, and a child
        // put back here by its tail is one no stop can cancel.
        this.#live.set(subject.id, true)
        changed = true
      }
      if (changed) {
        // A leak guard, not a roster limit: the ids are only ever used to cancel, and the oldest
        // is the one a stop is least likely to still be about.
        const oldest = this.#live.keys().next()
        if (this.#live.size > MAX_TRACKED_SUBAGENTS && oldest.done !== true) this.#live.delete(oldest.value)
        const oldestForgotten = this.#forget.keys().next()
        if (this.#forget.size > MAX_TRACKED_SUBAGENTS && oldestForgotten.done !== true) {
          this.#forget.delete(oldestForgotten.value)
        }
      }
    }
    // Both roster channels go out as one frame type with `kind` naming the channel, so the
    // frontend needs one shape and the projection reads the engine payload as it is.
    this.#context.publish({ type: 'subagent', kind, payload })
    if (changed) this.#context.onLiveChange()
  }

  /**
   * Forwards one of a child's own session events (`{id, event}`) as a `subagent_event` frame.
   *
   * The frame says which child it came from and where that child's transcript is, because the two
   * facts travel separately in the engine: the payload names the child, and the file comes from the
   * registry - the engine's own lookup, e.g. `task/executor.ts:3011` - or, once a stop has released
   * that registration, from what this watch's roster frames reported (`#sessionFileOf`). The event
   * body is passed through untouched: the desktop projects it with the same reducer as a top-level
   * session's events, and a field rewritten here would be a second vocabulary for the frontend to
   * understand.
   *
   * A frame with no child id, no event, or no transcript file is dropped and counted rather than
   * forwarded half-addressable: the desktop attaches to a transcript by path, so a frame without
   * one names no screen it could reach, and inventing a path would attach a screen to the wrong
   * file. The last case is real - an isolated `task` run has no transcript at all
   * (`task/structured-subagent.ts:584` registers `sessionFile: null` for it) - and it is the
   * one a count has to keep visible (`#dropEventFrame`).
   */
  #noteEvent(payload: unknown): void {
    if (typeof payload !== 'object' || payload === null) {
      this.#dropEventFrame('payload is not an object')
      return
    }
    const fields = payload as Record<string, unknown>
    const agentId = fields.id
    if (typeof agentId !== 'string' || agentId === '') {
      this.#dropEventFrame('payload names no child')
      return
    }
    const event = fields.event
    if (typeof event !== 'object' || event === null) {
      this.#dropEventFrame('payload carries no event')
      return
    }
    const sessionFile = this.#sessionFileOf(agentId)
    if (sessionFile === undefined) {
      this.#dropEventFrame('child has no transcript file')
      return
    }
    // A child swaps its own toolset too, and the engine announces it the same way. The line is its
    // terminal's status bar rather than the child's transcript, so it is dropped here by the same
    // rule the conversation's own channel applies (`session-view.ts::isToolMountNotice`).
    if (isToolMountNotice(event as Record<string, unknown>)) return
    this.#context.publish({ type: 'subagent_event', agentId, sessionFile, event })
  }

  /**
   * The transcript a child's own events belong to: the engine's registry first, the roster frames'
   * own word second.
   *
   * The registry is the authority - the ref is the same one the roster is read from
   * (`#registryLiveIds`), and the field is set before the child's session runs (`sdk.ts:3979`,
   * `sessionFile: sessionManager.getSessionFile()`) - but it is also what a stop empties: `cancel`
   * releases every child it kills, and the child's own last frames (the turn end its abort
   * produced) then arrive with no registration left to answer for them. Those are the frames a
   * screen attached to the child is waiting on, so the file the roster frames carried is the
   * fallback rather than a drop. A child that never reported one - an isolated run has no
   * transcript at all (`task/structured-subagent.ts:584` registers `sessionFile: null`) - and
   * a lookup that fails both answer the same way, no file, because neither names a path a screen
   * could be attached to. Failures are logged, never thrown: the event pipe must not die because
   * the registry did.
   */
  #sessionFileOf(agentId: string): string | undefined {
    try {
      const sessionFile = this.#context.sdk.AgentRegistry.global().get(agentId)?.sessionFile
      if (typeof sessionFile === 'string' && sessionFile !== '') return sessionFile
    } catch (error) {
      logError(`session ${this.#context.sessionId} subagent registry lookup failed`, error)
    }
    return this.#files.get(agentId)
  }

  /**
   * Keeps one roster frame's own word about where a child's transcript is.
   *
   * Bounded like the live set, and oldest-first for the same reason: what this answers is the
   * children whose frames are still arriving, and the child a session stopped longest ago is the
   * one least likely to have any left.
   */
  #rememberFile(agentId: string, sessionFile: string): void {
    this.#files.set(agentId, sessionFile)
    const oldest = this.#files.keys().next()
    if (this.#files.size > MAX_TRACKED_SUBAGENTS && oldest.done !== true) this.#files.delete(oldest.value)
  }

  /**
   * Counts one child-event frame that cannot be placed on the wire, and reports the reason once.
   *
   * The count is the audit trail a silent loss would lack (`onEventDropped`); the log line is for
   * the case where the number alone leaves the cause open - an isolated child drops a whole stream,
   * and one line per reason is what keeps that readable without logging every frame it shed.
   */
  #dropEventFrame(reason: string): void {
    this.#context.onEventDropped()
    if (this.#reportedEventDrops.has(reason)) return
    this.#reportedEventDrops.add(reason)
    logLine(`session ${this.#context.sessionId} dropped a subagent event frame (${reason})`)
  }
}
