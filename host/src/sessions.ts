/**
 * The session registry: one engine session per conversation, addressed by routing id.
 *
 * The engine's own session object is the single source of truth for a conversation's state
 * (design rule M4) - this module never keeps a second mutable transcript. Everything it exposes
 * is either read from that object or derived from the session file's path.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import type { RpcGoalController } from '@oh-my-pi/pi-coding-agent/modes/rpc/rpc-goal'
import type { InternalAvailableSlashCommand } from '@oh-my-pi/pi-coding-agent/slash-commands/available-commands'

import { FORCE_STOP_GRACE_MS, MAX_CONCURRENT_TURNS, MAX_LIVE_SESSIONS, MAX_PARALLEL_TOOL_CALLS, TURN_SILENCE_MS } from './constants.ts'
import type { HostPaths } from './env.ts'
import type { SessionEvents } from './events.ts'
import { selectEvictions } from './evict.ts'
import type { EvictionCandidate } from './evict.ts'
import { logError, logLine, sanitizeMessage } from './log.ts'
import { modelSummary } from './models.ts'
import type { FrameWriter } from './outbound.ts'
import { reloadPluginStateForSession } from './plugin-reload.ts'
import { ERROR_CODES, HostError, invalidInput } from './protocol/errors.ts'
import { withDesktopCommands } from './slash-desktop.ts'
import { text } from './protocol/fields.ts'
import type { BootServices } from './boot.ts'
import { resolveSessionFile, sessionIdFor } from './store.ts'
import type { AgentSession, MCPManager, SessionManager, SdkBundle } from './sdk.ts'
import { emitSessionState, sessionStateView } from './session-view.ts'
import type { RetryState } from './session-view.ts'
import { abandonOpen, disposeSession, disposeSessionsAtShutdown, releaseWorkspaceLsp, shutdownLsp } from './session-lifecycle.ts'
import { closeConversation, deleteConversation, forceStopConversation } from './session-files.ts'
import { readConfig, readHistoryPage, readState, replayEvents, respondUi } from './session-reads.ts'
import type { SessionReadsPort } from './session-reads.ts'
import { activateSession } from './session-activate.ts'
import type { SessionActivatePort } from './session-activate.ts'
import { branchConversation, branchFromEntry, readBranchPoints, rewindConversation } from './session-branch.ts'
import type { SessionBranchPort } from './session-branch.ts'
import type { SessionFilesPort } from './session-files.ts'
import { sendPrompt } from './session-prompt.ts'
import type { SessionPromptPort } from './session-prompt.ts'
import { callOffRelease, cancelBackgroundJob, cancellableCounts, isWorking, stopSession } from './session-stop.ts'
import type { SessionStopPort, StopOutcome } from './session-stop.ts'
import { silenceStoppedResults } from './stop-results.ts'
import type { SubagentWatch } from './subagents.ts'
import type { UiBridge } from './ui.ts'

/** The configured-thinking-level vocabulary the engine accepts. */
const THINKING_LEVELS = ['auto', 'inherit', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * One loaded conversation.
 *
 * Exported for the two modules the registry lends it to (`session-reads.ts`, `session-files.ts`):
 * both act on a record the registry owns, and both take it through a port rather than reaching into
 * the live map, so this type is the whole of what they are allowed to know about it.
 */
export interface LiveSession {
  /**
   * The routing id: the digest of the file this conversation currently lives in.
   *
   * Mutable because the engine can rewrite an open conversation onto another file - branching does
   * exactly that (`session-branch.ts`) - and the id is derived from the file, never chosen. A
   * record therefore moves to the id its file now digests to, and everything addressed by the old
   * one (frames, commands) is addressed by the new one from that point on.
   */
  sessionId: string
  /** The session file this conversation currently lives in; moves with {@link sessionId}. */
  sessionFile: string
  readonly cwd: string
  readonly manager: SessionManager
  readonly agent: AgentSession
  readonly events: SessionEvents
  readonly ui: UiBridge
  /**
   * The engine's own auto-continue nudge, sent when a compaction has to resume this conversation.
   *
   * Carried on the record rather than read from the engine by the one module that needs it: the
   * engine import seam is `sdk.ts`, and the wording belongs to the engine
   * (`host/src/upstream-compaction.ts`).
   */
  readonly autoContinuePrompt: string
  /**
   * The MCP manager this session was given, when it has one.
   *
   * `createAgentSession` registers a top-level session's manager as the process-global instance,
   * but that registration can be cleared while the session is still alive - which is why the
   * capability commands keep this reference as their second place to look (ruling C6).
   */
  readonly mcpManager: MCPManager | undefined
  /**
   * Frames this session's outbound path discarded before the wire.
   *
   * The queue's shedding callbacks are wired before the session record exists, and the transport
   * can also refuse one of its frames, so the count lives in an object both sides share rather
   * than in a number either side would have to copy. Every discarded frame lands here: shed
   * increments, snapshots merged into a newer one, and frames the transport could not encode.
   */
  readonly losses: { droppedFrames: number }
  lastActivityMs: number
  /**
   * When the engine last said anything about this conversation, in epoch ms.
   *
   * Stamped on every engine event the session publishes (`session-activate.ts`), which is the one
   * fact a caller cannot derive from anywhere else: the state view's `isStreaming` and
   * `pendingAsyncWork` say the session is busy, and none of them says whether the engine is still
   * doing anything about it. A long tool, a long think and a hung turn all read as "working"; only
   * this clock tells a reader how long it has been since the last thing happened. It is published
   * on the state frame as `lastEventAt` for exactly that reading.
   *
   * Deliberately not {@link lastActivityMs}: that one is stamped by *commands* (a prompt, a
   * rename, a stop) and is what the idle-eviction clock measures, so it moves for reasons that have
   * nothing to do with the engine still working.
   */
  lastEventAt: number
  /**
   * Whether the silence this session has been in was already written to the log.
   *
   * One line per silence episode rather than one per sweep: the sweep runs on a timer, and a
   * conversation stuck for an hour would otherwise fill the log with the same sentence.
   */
  silentNotified: boolean
  /**
   * The retry the engine is waiting on, in the shape its own `auto_retry_start` reports it; null
   * whenever the turn is not retrying. Part of the state view, so a screen that mounts while one
   * is in flight reads the same fact a screen that watched it start already has.
   */
  retry: RetryState | null
  /**
   * Set when the screen that owned this session let go while it was still working. The disposal
   * waits for the end of that work (see `session-stop.ts`'s `releaseIfDone`): a close must never cut
   * a running turn short, because what it is producing is what the user asked for. Any later use of
   * the session - a prompt, an `open` that finds it loaded - calls the release off
   * (`session-stop.ts`'s `callOffRelease`): the screen came back, so there is nothing left to
   * release it from.
   */
  releasePending: boolean
  /** Whether the deferred release above already has its one scheduled disposal. */
  releaseScheduled: boolean
  /**
   * How many engine events this session has published.
   *
   * A paged transcript read is a projection of the branch, and a walk asks for several pages in a
   * row. The revision is what lets those pages share one pass over the branch instead of scanning
   * it - twice - per page: every engine event bumps it (`session-activate.ts`), so a cached view
   * is used only while the transcript is still the one it was built from.
   *
   * Owner: this record. Bound: one counter. Released: with the record.
   */
  historyRevision: number
  /**
   * The branch as the paged read last projected it, and the revision it was taken at.
   *
   * `messages` is the branch's own message objects in order (the engine's objects, never copies);
   * `entryIds` pairs each of those objects with the entry id it was written as. One array of
   * references and one map per live conversation, both rebuilt when a page is read after an event
   * moved the revision, and dropped with the record. Pages of one walk therefore cost one branch
   * pass, not one per page.
   */
  transcript: TranscriptView | null
  /** The command list this session last advertised, in the engine's own entry shape. */
  commands: InternalAvailableSlashCommand[]
  /**
   * Goal mode's non-terminal half (`RpcGoalController`): the `goal` tool's place in the active
   * set, reattach after a rewrite, the continuation driver, and the `/goal` lifecycle commands.
   * One per engine session, owned by this record and released with it.
   */
  readonly goal: RpcGoalController
  /** Stops the engine's own name watch; called before the session's teardown. */
  readonly releaseNameWatch: () => void
  /**
   * Stops the engine's command-metadata watch.
   *
   * The engine reports a changed command set (a skill directory appearing, MCP prompts loading,
   * a plugin change) and the palette has to follow it: without this the list would only ever be
   * the one read when the session was opened.
   */
  readonly releaseCommandWatch: () => void
  /**
   * This session's children: the frames that report them, and the ids a stop still cancels.
   *
   * One per session, because the engine's observability bus is root-scoped to the session that
   * was given it - so this is where every descendant of this conversation reports.
   */
  readonly subagents: SubagentWatch
}

/**
 * One conversation's branch, projected for the paged read and kept until an engine event says it
 * moved (see {@link LiveSession.transcript}).
 */
export interface TranscriptView {
  /** The {@link LiveSession.historyRevision} this view was built at. */
  readonly revision: number
  /** The active branch's message objects, oldest first. */
  readonly messages: readonly unknown[]
  /** Each message object paired with the entry id it was written as, where it was written as one. */
  readonly entryIds: ReadonlyMap<unknown, string>
}

/** One `host_health.sessions[]` row. */
export interface SessionSummary {
  readonly sessionId: string
  readonly sessionFile: string
  readonly cwd: string
  readonly isStreaming: boolean
  readonly queuedMessages: number
  readonly lastActivityMs: number
}

/**
 * Engine services and paths one registry works against.
 */
export interface RegistryContext {
  readonly paths: HostPaths
  readonly sdk: SdkBundle
  readonly services: BootServices
  readonly writer: FrameWriter
}

/**
 * Owns every loaded conversation.
 *
 * Counters here are the ones `host_health` publishes, so an ignored or rejected frame is a number
 * rather than a silence.
 */
export class SessionRegistry {
  readonly #context: RegistryContext
  readonly #live = new Map<string, LiveSession>()
  /**
   * What `session-stop.ts` may do to the live map: check that a record is still the one it holds,
   * and take it out. Built once, because the child-set edge calls into it on every frame (see the
   * module's port).
   */
  readonly #stop: SessionStopPort
  #evicted = 0
  #droppedFrames = 0
  #coalescedFrames = 0
  #unknownFrames = 0
  #rejectedCommands = 0

  constructor(context: RegistryContext) {
    this.#context = context
    this.#stop = {
      sdk: context.sdk,
      held: live => this.#live.get(live.sessionId) === live,
      drop: sessionId => {
        this.#live.delete(sessionId)
      },
      usesWorkspace: cwd => this.#usesWorkspace(cwd),
    }
  }

  /** Live session count. */
  get size(): number {
    return this.#live.size
  }

  /**
   * An MCP manager a loaded session owns, for the capability commands to read live state from.
   *
   * This is a *read*: the registry never creates a manager, and a host with no active session
   * answers with `undefined`, which is what makes `mcp_list` report `live:false` instead of
   * inventing connections (ruling C6).
   */
  mcpManager(): MCPManager | undefined {
    return this.mcpManagers()[0]
  }

  /**
   * Every MCP manager the loaded sessions own, without duplicates.
   *
   * One is not enough: a top-level session builds its own manager, so a blank conversation opened
   * after another one holds a manager that has never connected anything. Reading a server's live
   * status from whichever manager happens to be newest is what made a refresh report a connected
   * server as disconnected; the caller asks all of them and reports the best answer.
   */
  mcpManagers(): MCPManager[] {
    const managers: MCPManager[] = []
    for (const session of this.#live.values()) {
      const manager = session.mcpManager
      if (manager !== undefined && !managers.includes(manager)) managers.push(manager)
    }
    return managers
  }

  /** Counters `host_health` reports. */
  get counters(): Record<string, number> {
    return {
      evicted: this.#evicted,
      droppedFrames: this.#droppedFrames,
      coalescedFrames: this.#coalescedFrames,
      unknownFrames: this.#unknownFrames,
      rejectedCommands: this.#rejectedCommands,
      maxConcurrentTurns: MAX_CONCURRENT_TURNS,
      maxParallelToolCalls: MAX_PARALLEL_TOOL_CALLS,
    }
  }

  /** Counts an inbound frame the host has no owner for. */
  noteUnknownFrame(): void {
    this.#unknownFrames += 1
  }

  /** Counts an inbound command refused because its shape was wrong. */
  noteRejectedCommand(): void {
    this.#rejectedCommands += 1
  }

  /**
   * Accounts for a frame the transport could not encode (contract §2.6 ruling A18 rule 3).
   *
   * The frame never reached the wire, so it is reported on the session it belonged to when that
   * session is still loaded, and host-wide otherwise. The notice itself is small, so it is not at
   * risk of the failure it reports. A response that could not be sent is answered with a small
   * failure under the same id, because the caller is waiting for exactly that id.
   */
  noteEncodeFailure(frame: unknown, reason: string): void {
    this.#droppedFrames += 1
    const record = typeof frame === 'object' && frame !== null ? (frame as Record<string, unknown>) : {}
    const sessionId = record.sessionId
    const live = typeof sessionId === 'string' ? this.#live.get(sessionId) : undefined
    const notice = { type: 'notice', level: 'error', message: `The host could not encode an outbound frame: ${reason}` }
    if (live !== undefined) {
      live.losses.droppedFrames += 1
      live.events.emitProtected(notice)
    } else this.#context.writer.send(notice)
    if (record.type === 'response' && typeof record.id === 'string') {
      this.#context.writer.send({
        type: 'response',
        id: record.id,
        success: false,
        error: sanitizeMessage(`The response was too large to send: ${reason}`),
        code: ERROR_CODES.invalid_input,
      })
    }
  }

  /** Live sessions as `host_health.sessions` rows. */
  summaries(): SessionSummary[] {
    return [...this.#live.values()].map(session => ({
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      cwd: session.cwd,
      isStreaming: session.agent.isStreaming,
      queuedMessages: session.agent.queuedMessageCount,
      lastActivityMs: session.lastActivityMs,
    }))
  }

  /** Whether a session id is currently loaded. */
  has(sessionId: string): boolean {
    return this.#live.has(sessionId)
  }

  /**
   * Opens - or returns - the conversation a request names.
   *
   * Three states are distinguished: the id is already loaded (return its current state), the file
   * exists (load it), or the path is new (create a conversation there). Nothing here activates a
   * session that was not asked for.
   *
   * Both already-loaded paths call off a deferred release on their way out: an `open` for a
   * session that is still loaded is a screen coming back to it, and a release left armed by an
   * earlier hand-back would otherwise dispose the record the moment that work ends - dropping the
   * conversation out from under the screen that just rejoined it.
   */
  async open(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestedId = text(request.sessionId, 'sessionId', false)
    const existing = requestedId === undefined ? undefined : this.#live.get(requestedId)
    if (existing !== undefined) {
      callOffRelease(existing)
      return await this.#openResponse(existing, false)
    }

    const cwd = await this.#resolveCwd(request.cwd)
    const requestedFile = text(request.sessionFile, 'sessionFile', false)
    const file = requestedFile === undefined ? null : resolveSessionFile(this.#context.paths, requestedFile)
    if (file !== null) {
      // Checked before the engine takes its single-writer lock on the file.
      const loaded = this.#live.get(sessionIdFor(file))
      if (loaded !== undefined) {
        callOffRelease(loaded)
        return await this.#openResponse(loaded, false)
      }
    }
    const existed = file !== null && fs.existsSync(file)

    const manager = file === null
      ? this.#context.sdk.SessionManager.create(cwd, this.#context.paths.sessionDir)
      : await this.#context.sdk.SessionManager.open(file, this.#context.paths.sessionDir, undefined, {
          initialCwd: cwd,
        })
    try {
      const live = await activateSession(this.#activationPort(), manager, cwd)
      return await this.#openResponse(live, !existed)
    } catch (error) {
      // Nothing of this attempt is reachable through the registry - the activation registers the
      // record last, so a failure before that leaves a manager holding the file's single-writer
      // lock and, for a file this open created, a transcript the registry never knew about. A
      // retry of the same open would then fail on the lock it left behind, so both are taken down
      // here and the original failure travels on unchanged.
      await abandonOpen(manager, existed)
      throw error
    }
  }

  /**
   * Closes a session; unknown ids answer `closed:false` rather than failing.
   *
   * `dropFile` discards a transcript nothing was written to as well, which is the one case a close
   * may take a file with it (see `session-files.ts`, which owns both file-addressed commands).
   */
  async close(sessionId: unknown, dropFile: boolean): Promise<{ closed: boolean }> {
    const id = text(sessionId, 'sessionId', true) as string
    const closed = await closeConversation(this.#files(), id, dropFile)
    // A session still working is not dropped here: it is handed back when its work ends (the
    // registry's deferred release), which is why the refusal is remembered rather than reported.
    const live = this.#live.get(id)
    if (!closed && live !== undefined) live.releasePending = true
    return closed
  }

  /** Deletes one conversation's files, refusing while its session is still working. */
  async delete(request: Record<string, unknown>): Promise<{ deleted: boolean }> {
    return await deleteConversation(this.#files(), request)
  }

  /** What the file-addressed commands see of this registry (see `session-files.ts`). */
  #files(): SessionFilesPort {
    return {
      peek: id => this.#live.get(id),
      take: id => {
        const live = this.#live.get(id)
        if (live !== undefined) this.#live.delete(id)
        return live
      },
      isWorking: live => isWorking(live),
      usesWorkspace: cwd => this.#usesWorkspace(cwd),
      paths: this.#context.paths,
      sdk: this.#context.sdk,
    }
  }

  /** Sends a prompt, or an acknowledgement plus a later failure under the same id. */
  async prompt(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await sendPrompt(this.#promptPort(), request)
  }

  /** What one prompt's run needs of this registry (see `session-prompt.ts`). */
  #promptPort(): SessionPromptPort {
    return {
      sdk: this.#context.sdk,
      require: id => this.#require(id),
      collect: () => {
        void this.collect()
      },
      refreshCommands: live => this.#refreshCommands(live),
    }
  }

  /**
   * Stops one session's work: its running turn, its running children, and its background jobs.
   *
   * The work itself - what "still working" means, the turn's abort-and-wait, the children's and
   * jobs' cancellation and the silencing of the wakes a kill would produce - is
   * `session-stop.ts`'s; this adds the registry's part, which is the lookup: the id is resolved to a
   * record here, or refused with `session_not_found`. What comes back is that module's own answer,
   * passed through unchanged - the caller needs to know what ended and what is still running.
   */
  async abort(sessionId: unknown, reason: unknown): Promise<StopOutcome> {
    const live = this.#require(text(sessionId, 'sessionId', true) as string)
    return await stopSession(this.#stop, live, reason)
  }

  /**
   * The step after a stop that did not land: ends the conversation by taking its record down.
   *
   * A turn that ignores its abort window cannot be ended from outside - the engine is inside a
   * frame the host has no handle on - so the one lever left is the engine's own teardown. The
   * session's record is taken out of the registry and disposed (`session-files.ts`), which is what
   * disposes the engine session: that cancels the background work the stop could not reach and
   * releases the workspace's language servers. The transcript is kept, because the conversation is
   * still the user's - what ends is this process's hold on it, and the next open loads it back.
   *
   * The stop is tried once more with a short window first: most of what a user calls a stuck turn
   * ends within a second or two of the abort, and tearing a record down is a heavier answer than
   * the user asked for. What is taken down is either half of "that stop was not enough": a turn that
   * ignored its window, or a stop that landed and left work behind (a child or a job the stop's own
   * levers could not reach). A queued message is neither - the stop already withdrew the reader's
   * own queued input and hands it back in `restored` (see `session-stop.ts`) - so it alone does not
   * earn a teardown, and the record is left exactly as the stop left it.
   *
   * `sessionFile` travels in the answer because the record is gone by the time the caller reads it:
   * it is the file the caller reopens to get the conversation back.
   */
  async forceStop(sessionId: unknown): Promise<Record<string, unknown>> {
    const id = text(sessionId, 'sessionId', true) as string
    const live = this.#require(id)
    const sessionFile = live.sessionFile
    const outcome = await stopSession(this.#stop, live, 'forced stop from the desktop', FORCE_STOP_GRACE_MS)
    if (!outcome.remaining.some(facet => facet !== 'queued')) {
      return {
        forced: false,
        cancelledSubagents: outcome.cancelledSubagents,
        cancelledJobs: outcome.cancelledJobs,
        restored: outcome.restored,
        sessionFile,
      }
    }
    // Read before the teardown, not after: disposing the session is what ends both sets, and once
    // the record is out of the registry there is nothing left to count.
    const counts = cancellableCounts(live)
    const forced = await forceStopConversation(this.#files(), id, 'session_force_stop')
    logLine(`session ${id} force-stopped (work left behind after the stop)`)
    return {
      forced,
      cancelledSubagents: counts.subagents,
      cancelledJobs: counts.jobs,
      restored: outcome.restored,
      sessionFile,
    }
  }

  /**
   * Ends one background job of a session, by the id the state frame published.
   *
   * The per-job form of the stop, for the roster the composer draws: a reader who wants one job
   * gone rather than every one of them. The ownership check lives in `session-stop.ts` with the
   * other cancellation rules - the job manager is process-wide, so this is the boundary that keeps
   * one conversation from killing another's work. A job that is gone, settled, or not this
   * session's answers `stopped:false` rather than failing: the caller asked for it to be over, and
   * it is.
   *
   * The job's result is silenced exactly as the whole-session stop silences it - a cancelled job
   * still delivers its outcome back into the conversation, which would start a fresh turn.
   */
  async stopJob(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const live = this.#require(text(request.sessionId, 'sessionId', true) as string)
    const jobId = text(request.jobId, 'jobId', true) as string
    const stopped = cancelBackgroundJob(live.agent, jobId)
    if (stopped) {
      silenceStoppedResults(live.agent, this.#context.sdk.asyncResultMessageType, [jobId])
      emitSessionState(live)
    }
    return { stopped }
  }

  /**
   * Writes one log line per session that has produced no engine event for a long time while still
   * reading busy.
   *
   * The host's own account of a silence the user-facing reading (`lastEventAt` on the state frame)
   * already measures - the log is where a report is diagnosed after the fact, and the frames that
   * would explain a wedged engine are exactly the ones that stopped arriving. Nothing is acted on:
   * a long tool, a long think and a hung turn are indistinguishable from here, so the host says
   * that nothing happened rather than judging what it means.
   */
  sweepSilence(): void {
    const now = Date.now()
    for (const live of this.#live.values()) {
      const silentMs = now - live.lastEventAt
      if (!isWorking(live) || silentMs <= TURN_SILENCE_MS) {
        live.silentNotified = false
        continue
      }
      if (live.silentNotified) continue
      live.silentNotified = true
      logLine(`session ${live.sessionId} has produced no engine event for ${silentMs}ms while still working`)
    }
  }

  /** Switches the model of one session and republishes its configuration. */
  async setModel(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const live = this.#require(text(request.sessionId, 'sessionId', true) as string)
    const provider = text(request.provider, 'provider', true) as string
    const modelId = text(request.modelId, 'modelId', true) as string
    const model = this.#context.services.registry.find(provider, modelId)
    if (model === undefined) throw invalidInput(`Unknown model ${provider}/${modelId}.`)
    await live.agent.setModel(model)
    live.lastActivityMs = Date.now()
    emitSessionState(live)
    await live.events.flush()
    return { state: sessionStateView(live) }
  }

  /**
   * Re-resolves every open conversation's model against the registry that has just been re-read.
   *
   * A session holds the model *object* it was bound to, and that object is where the engine reads the
   * two numbers a conversation is measured by: the context window, and where that window would be
   * compacted. A model whose context information the reader has just edited in the desktop's settings
   * therefore keeps its old numbers in every conversation that is already open — the field says one
   * thing, the gauge and the engine's own compaction boundary say another, and the reader's edit
   * looks like it did nothing until the session is reopened. `models_reload` is what re-reads the
   * registry, so this is the other half of it: each session is put back on the model it names, and
   * the ones whose numbers actually moved publish their state again so the reading follows. A model
   * the refreshed registry no longer carries is left alone — the session keeps what it is running on
   * rather than being moved somewhere the catalogue does not offer.
   */
  async rebindModels(): Promise<number> {
    let rebound = 0
    for (const live of this.#live.values()) {
      const current = live.agent.model
      if (current === undefined) continue
      const found = this.#context.services.registry.find(current.provider, current.id)
      if (found === undefined) continue
      // The numbers are what the reader was looking at, so they are what decides whether anything
      // has to move — not the identity of the object holding them, which a registry that rewrote its
      // own entry in place would leave alone.
      if (found.contextWindow === current.contextWindow && found.maxTokens === current.maxTokens) continue
      if (found !== current) {
        // A model the engine cannot resolve a credential for is one this session cannot be moved
        // onto: the rebind is a metadata refresh, and a conversation that is already running is left
        // where it is rather than being failed by a read.
        try {
          await live.agent.setModel(found)
        } catch (error) {
          logError(`session ${live.sessionId}: could not rebind model ${found.provider}/${found.id}`, error)
          continue
        }
      }
      emitSessionState(live)
      await live.events.flush()
      rebound += 1
    }
    return rebound
  }

  /**
   * Sets the thinking level of one session.
   *
   * The shape check below protects the protocol vocabulary, not model capability. The engine
   * resolves every level through its own clamping, so a level this model cannot take arrives as
   * the nearest one it can; the caller reads what actually applies from the state in this
   * response. A word outside the vocabulary is a protocol violation and remains invalid input.
   */
  async setThinking(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const live = this.#require(text(request.sessionId, 'sessionId', true) as string)
    const level = text(request.level, 'level', true) as string
    if (!THINKING_LEVELS.includes(level)) throw invalidInput(`Unknown thinking level ${level}.`)
    live.agent.setThinkingLevel(level as never, true)
    live.lastActivityMs = Date.now()
    live.events.emit({ type: 'thinking_level_changed', thinkingLevel: live.agent.thinkingLevel })
    emitSessionState(live)
    await live.events.flush()
    return { state: sessionStateView(live) }
  }

  /** Renames one session and tells the frontend the title changed. */
  async setName(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const live = this.#require(text(request.sessionId, 'sessionId', true) as string)
    const name = text(request.name, 'name', true) as string
    await live.agent.setSessionName(name, 'user')
    live.lastActivityMs = Date.now()
    // The rename is published by the name watch registered at activation, not here: the engine
    // reports user renames and its own auto titles through that one callback, and a single
    // publisher is what keeps a rename from arriving as two identical frames. The callback runs
    // synchronously inside `setSessionName`, so the frame still precedes the state frame below.
    emitSessionState(live)
    return {}
  }

  /** Current state of one session, published after the frames it counts. */
  async state(sessionId: unknown): Promise<Record<string, unknown>> {
    return await readState(this.#reads(), sessionId)
  }

  /** Reads one page of a transcript, from memory when the session is live and from disk otherwise. */
  async history(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await readHistoryPage({
      paths: this.#context.paths,
      sdk: this.#context.sdk,
      live: sessionId => this.#live.get(sessionId),
      require: sessionId => this.#require(sessionId),
    }, request)
  }

  /** Model, command and thinking-level catalogue for the engine, optionally scoped to a session. */
  config(sessionId: unknown): Record<string, unknown> {
    return readConfig(this.#reads(), sessionId)
  }

  /** Answers one engine dialog. */
  uiResponse(request: Record<string, unknown>): Record<string, unknown> {
    return respondUi(this.#reads(), request)
  }

  /** Replays a session's retained events. */
  replay(request: Record<string, unknown>): Record<string, unknown> {
    return replayEvents(this.#reads(), request)
  }

  /** What the branch commands see of this registry (see `session-branch.ts`). */
  #branch(): SessionBranchPort {
    return {
      skillPromptType: this.#context.sdk.skillPromptMessageType,
      require: id => this.#require(id),
      rekey: (live, next) => {
        // Only the record this registry holds may move: a record that was already replaced (a
        // close and a reopen, an eviction) is not the one the engine just rewrote.
        if (this.#live.get(live.sessionId) !== live) return
        this.#live.delete(live.sessionId)
        live.sessionId = next.sessionId
        live.sessionFile = next.sessionFile
        // A rewrite moved the conversation onto another file and branch: the projection cached
        // under the old one names rows this session no longer ends on.
        live.transcript = null
        live.events.rekey(next.sessionId)
        this.#live.set(next.sessionId, live)
      },
    }
  }

  /** The messages one conversation can branch from, as the picker draws them. */
  branchPoints(request: Record<string, unknown>): Record<string, unknown> {
    return readBranchPoints(this.#branch(), request)
  }

  /** Branches one conversation at a user message: a new session file, continuing from before it. */
  async branch(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await branchConversation(this.#branch(), request)
  }

  /** Takes a conversation back to just before one of its user messages (see `session-branch.ts`). */
  async rewind(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await rewindConversation(this.#branch(), request)
  }

  /** Starts a conversation of its own that continues from an entry inside this one. */
  async branchFrom(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await branchFromEntry(this.#branch(), request)
  }

  /** What the projection commands see of this registry (see `session-reads.ts`). */
  #reads(): SessionReadsPort {
    return {
      require: id => this.#require(id),
      models: () => this.#context.services.registry.getAvailable().map(model => modelSummary(model)),
      thinkingLevels: THINKING_LEVELS,
    }
  }

  /** Evicts every session the policy selects; returns how many were dropped. */
  async collect(): Promise<number> {
    const now = Date.now()
    const candidates: EvictionCandidate[] = [...this.#live.values()].map(session => ({
      sessionId: session.sessionId,
      // The session's whole busy fact, not the turn bit: a detached batch is idle-but-working.
      working: isWorking(session),
      queuedMessages: session.agent.queuedMessageCount,
      lastActivityMs: session.lastActivityMs,
    }))
    const victims = selectEvictions(candidates, now)
    const dropped: LiveSession[] = []
    // Every victim leaves the registry before the first teardown: the LSP release below asks the
    // live set which workspaces are still in use, and a victim still named there would answer for
    // itself.
    for (const sessionId of victims) {
      const live = this.#live.get(sessionId)
      if (live === undefined) continue
      logLine(`evicting session ${sessionId} (idle ${now - live.lastActivityMs}ms)`)
      this.#live.delete(sessionId)
      dropped.push(live)
      this.#evicted += 1
    }
    for (const live of dropped) {
      await disposeSession(live, 'eviction')
    }
    // One release per workspace the eviction emptied, and only for those: the language servers of a
    // workspace another live conversation still uses are that conversation's, and taking them down
    // would restart them under it (`session-lifecycle.ts`'s `releaseWorkspaceLsp`).
    for (const workspace of new Set(dropped.map(live => live.cwd))) {
      if (!this.#usesWorkspace(workspace)) await releaseWorkspaceLsp(this.#context.sdk, workspace, 'eviction')
    }
    return dropped.length
  }

  /**
   * Whether any session still loaded was opened in this workspace.
   *
   * Compared on resolved paths, not on the strings the sessions were opened with: the question
   * decides whether another conversation's shared language servers may be stopped, so two
   * spellings of one directory (`..`, a trailing separator, a verbatim prefix) must not answer
   * "empty" and release servers the surviving conversation is using. Windows casing is left as
   * spelled - `path.resolve` does not fold it - which matches the engine, whose clients are keyed
   * by the directory string it was spawned with.
   */
  #usesWorkspace(cwd: string): boolean {
    const workspace = path.resolve(cwd)
    for (const session of this.#live.values()) {
      if (path.resolve(session.cwd) === workspace) return true
    }
    return false
  }

  /** Disposes every session; the shutdown path. */
  async disposeAll(reason: string): Promise<void> {
    const sessions = [...this.#live.values()]
    this.#live.clear()
    // The one place a conversation nothing was written to is taken away with its file: every hero
    // the user looked at opened one, and the process ending is the last chance to leave no trace of
    // a screen rather than a conversation (see `session-lifecycle.ts`).
    const removed = await disposeSessionsAtShutdown(sessions, reason)
    if (removed > 0) logLine(`${removed} unwritten session file(s) removed at shutdown`)
    await shutdownLsp(this.#context.sdk, 'shutdown')
  }

  /**
   * Rebuilds plugin-derived state for every live session; answers how many were touched and how
   * many could not be.
   *
   * A plugin change is process-wide (the engine's plugin roots and caches are), so there is no
   * "which session" to ask: every loaded conversation has to re-read its skills and re-advertise
   * its commands, or it keeps running on the set the change replaced.
   *
   * The map is snapshotted like `disposeAll` does: a reload awaits engine work (agent discovery, a
   * skill scan), and sessions open and close while it runs, so the live map must not be iterated.
   * One conversation's failure is logged and counted rather than aborting the reload for the
   * others - a broken session would otherwise deny the new state to every healthy one - and the
   * count is returned so the caller can say the set did not converge everywhere.
   */
  async reloadPlugins(): Promise<{ reloaded: number; failed: number }> {
    const sessions = [...this.#live.values()]
    let reloaded = 0
    let failed = 0
    for (const session of sessions) {
      try {
        await reloadPluginStateForSession(this.#context.sdk, session.agent)
        reloaded += 1
      } catch (error) {
        failed += 1
        logError(`plugin reload failed for session ${session.sessionId}`, error)
      }
    }
    return { reloaded, failed }
  }

  #require(sessionId: string): LiveSession {
    const live = this.#live.get(sessionId)
    if (live === undefined) {
      throw new HostError(ERROR_CODES.session_not_found, `Unknown session ${sessionId}.`)
    }
    return live
  }

  async #resolveCwd(value: unknown): Promise<string> {
    const cwd = text(value, 'cwd', false) ?? this.#context.paths.defaultWorkspace
    if (!path.isAbsolute(cwd)) throw invalidInput('cwd must be an absolute path.')
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw invalidInput('cwd must be an existing directory.')
    }
    return cwd
  }

  /** What one activation needs of this registry (see `session-activate.ts`). */
  #activationPort(): SessionActivatePort {
    return {
      sdk: this.#context.sdk,
      services: this.#context.services,
      paths: this.#context.paths,
      writer: this.#context.writer,
      stop: this.#stop,
      peek: id => this.#live.get(id),
      register: live => {
        this.#live.set(live.sessionId, live)
        // The cap holds on the way in, not only at the sweep.
        //
        // A sweep is periodic by nature, and this registry's live set is not: every open holds an
        // engine session, a file handle, an event journal and an outbound budget, and a reader
        // clicking through a workspace's conversations opens them far faster than any timer runs.
        // Between two sweeps the live set was therefore only bounded by how many conversations the
        // screen had been through, which is exactly the kind of growth a cap exists to stop.
        //
        // Fire-and-forget on purpose: the session being opened must not wait on another
        // conversation's teardown (an eviction disposes an engine session and may stop a workspace's
        // language servers). The session just registered is the newest by activity, so the policy
        // never picks it, and a second open that arrives while this runs simply finds the victims
        // already out of the set.
        if (this.#live.size > MAX_LIVE_SESSIONS) void this.collect()
      },
      unregister: id => {
        this.#live.delete(id)
      },
      noteDroppedFrames: count => {
        this.#droppedFrames += count
      },
      noteCoalescedFrames: count => {
        this.#coalescedFrames += count
      },
      refreshCommands: (live, publishState) => this.#refreshCommands(live, publishState),
    }
  }

  /**
   * Rebuilds a session's advertised command list and republishes it as an event.
   *
   * The list itself travels in the session's state (that is the one snapshot a reader projects),
   * so a republished state follows the advertisement. `publishState` is false only for the caller
   * that publishes a state of its own right after this - an activation - and would otherwise
   * spend a second frame saying the same thing.
   */
  async #refreshCommands(live: LiveSession, publishState = true): Promise<void> {
    try {
      live.commands = withDesktopCommands(await this.#context.sdk.availableCommands(live.agent))
    } catch (error) {
      logError('command discovery failed', error)
      live.commands = []
    }
    live.events.emit({ type: 'available_commands_update', commands: live.commands })
    if (publishState) emitSessionState(live)
  }

  /**
   * The open response, written only after the session's queued frames have been published.
   *
   * The `state` it carries anchors the caller's expectation to the last event sequence; letting
   * the response overtake the frames that anchor counts would describe frames the caller has not
   * received yet, which a gap-detecting reader then reports as a hole.
   */
  async #openResponse(live: LiveSession, created: boolean): Promise<Record<string, unknown>> {
    await live.events.flush()
    return {
      sessionId: live.sessionId,
      sessionFile: live.sessionFile,
      created,
      loaded: true,
      state: sessionStateView(live),
    }
  }
}
