/**
 * Turning an open session manager into a live record: the engine session, its watches, and the
 * subscription that feeds this record's event pipe.
 *
 * Split out of the registry because the whole body acts on services and on the record it is
 * building - it touches the registry's own map only to check for a copy that raced it, to register
 * the record at the end, or to take it back out when the activation fails (all behind
 * {@link SessionActivatePort}). The two error edges are the reason this is one function rather
 * than part of `open`: an extension that refuses its own initialization must leave no watches, no
 * engine session and no file handle behind, and the record is not reachable through the registry
 * until the very end - which is what makes that cleanup the caller's (`abandonOpen`) and this
 * one's own responsibility respectively.
 */

import { initializeExtensions } from '@oh-my-pi/pi-coding-agent/modes/runtime-init'
import engineTitleSystemPrompt from '@oh-my-pi/pi-coding-agent/prompts/system/title-system' with { type: 'text' }

import type { BootServices } from './boot.ts'
import type { HostPaths } from './env.ts'
import { SessionEvents } from './events.ts'
import { logError, logLine } from './log.ts'
import type { FrameWriter } from './outbound.ts'
import { continueLoop } from './loop-mode.ts'
import { restorePlanMode } from './plan-mode.ts'
import { disposeSession } from './session-lifecycle.ts'
import { callOffRelease, noteChildSet, releaseWhenDone } from './session-stop.ts'
import type { SessionStopPort } from './session-stop.ts'
import { emitSessionState, isToolMountNotice, noteRetry } from './session-view.ts'
import type { SessionManager, SdkBundle } from './sdk.ts'
import type { LiveSession } from './sessions.ts'
import { canonicalSessionPath, sessionIdFor } from './store.ts'
import { SubagentWatch } from './subagents.ts'
import { browserPreviewTool, browserTool, workspaceTerminalTool, type SessionPipe } from './tools.ts'
import { UiBridge, configuredUiTimeoutMs } from './ui.ts'
import { adoptUpstreamCompaction, upstreamCompactionExtension } from './upstream-compaction.ts'
import { restoreVibeMode } from './vibe.ts'
import { writeGuardExtension } from './write-guard.ts'

/**
 * The prompt that names a conversation in this application.
 *
 * The engine's own prompt is imported as text rather than restated, so its form (3-6 words, the
 * `<title>` line, `<title/>` for greetings, the `<chat>` fallback) stays the installed engine's
 * business. The one rule added here is the operator's: the name follows the language the user
 * writes in. Without it the model answers in English regardless of a Chinese, Japanese or Russian
 * request, because the prompt itself is English.
 *
 * Passing this override also moves naming off the engine's forked side turn
 * (`title.generator: fork`) onto its title model: the fork path renders a card prompt of its own
 * and ignores `titleSystemPrompt` (`agent-session.ts` `#cardsAutoTitles`). This surface shows
 * plain names, so the language rule is worth that swap.
 */
const TITLE_SYSTEM_PROMPT = `${engineTitleSystemPrompt.trimEnd()}

Language:
- Write the title in the language the user wrote their latest message in: the language of their own words, not the language of this prompt or its examples. A Chinese request gets a Chinese title, a Japanese request a Japanese title, and so on.
- If that message mixes languages, follow the language most of its words are written in; if it is mostly code, paths or identifiers, follow the language of the nearest earlier user message that has prose.
- Keep proper nouns, product and model names, file and symbol names, error codes and quoted text exactly as the user wrote them, even inside a title in another language.

Markers:
- The wrapper is two literal ASCII tag names: <title> opens the line and </title> closes it, with no attributes and no other tag around them. The tag name stays Latin whatever the language of the title itself: never translate, localise or re-spell it, and never put a translated word between the angle brackets. That envelope is transport, not part of the name.
- Output the marker line and nothing else - no preamble, no commentary, no code fence.
`

/** What an activation needs from the registry that will own the record. */
export interface SessionActivatePort {
  /** Engine services: the session constructor, the event bus, and the UI vocabulary. */
  readonly sdk: SdkBundle
  /** The boot-time services the engine session is constructed with (settings, auth, registry). */
  readonly services: BootServices
  /** Where the engine's data lives: the agent directory pinned for this application. */
  readonly paths: HostPaths
  /** This host's stdout writer, the drain behind the record's event pipe. */
  readonly writer: FrameWriter
  /** The stop/release port the record's child-set edge and deferred release read. */
  readonly stop: SessionStopPort
  /** The registry's lookup: an activation that races a loaded copy resolves to that copy. */
  peek: (sessionId: string) => LiveSession | undefined
  /** Publishes the record under its id; nothing of the activation is reachable before this. */
  register: (live: LiveSession) => void
  /** Takes a failed activation's record back out, before it is disposed. */
  unregister: (sessionId: string) => void
  /** Charges dropped frames to the registry-wide counter (the record's own counter is beside it). */
  noteDroppedFrames: (count: number) => void
  /** Charges frames the queue coalesced to the registry-wide counter. */
  noteCoalescedFrames: (count: number) => void
  /** Rebuilds the session's advertised command list and republishes it. */
  refreshCommands: (live: LiveSession, publishState: boolean) => Promise<void>
}

/** Builds the live session around an already-open manager and subscribes to its events. */
export async function activateSession(
  port: SessionActivatePort,
  manager: SessionManager,
  cwd: string,
): Promise<LiveSession> {
  // The file is written before the id is derived, so the id is taken over the same resolved
  // path a later reopen will observe.
  await manager.ensureOnDisk()
  const opened = canonicalSessionPath(manager.getSessionFile() as string)
  const sessionId = sessionIdFor(opened)
  const already = port.peek(sessionId)
  if (already !== undefined) {
    // The engine took a writer lock this session does not need; the loaded one stays.
    await manager.close().catch(() => {})
    // A screen may be returning to a session it had handed back while that was still working:
    // it is watched again, so the deferred release it left behind is called off here.
    callOffRelease(already)
    return already
  }

  // The engine's default identity for a top-level session is `Main`, and an embedder that passes
  // nothing registers unconditionally: a second conversation would replace the first one's
  // registration, and the two would share one identity for everything the engine scopes by agent
  // id - background-job ownership, delivery sinks, the pending-async-work check. Identity, not a
  // private registry: a registry this host supplied is not inherited by the session's own `task`
  // children (no spawn path forwards it), so it would split a conversation from its children
  // while fixing nothing. Derived from the routing id, which is a hash of the session file's
  // canonical path - stable across restarts, unique per conversation, inside the engine's
  // agent-id alphabet.
  const agentId = `Desktop-${sessionId.slice(1)}`
  // One bus for both slots, which is the engine's documented way to wire them: the subagent
  // observability channels are re-emitted onto `subagentEventBus` unless it *is* `eventBus`, in
  // which case the alias is skipped and every frame is delivered exactly once.
  const eventBus = new port.sdk.EventBus()
  // The one tool this host adds to every session: the agent's way to read or type into the terminal
  // the user has open in this workspace (`host/src/tools.ts`). It publishes through this session's
  // own pipe, which is built from the session the call below returns - hence the slot, filled the
  // moment the pipe exists. Nothing can call it before that: a tool call belongs to a turn, and a
  // turn belongs to a prompt this host serves only once the session is live. The terminal tool
  // carries the session's own directory, because that is how the application matches a terminal to a
  // workspace.
  const pipe: SessionPipe = { events: null, ownerSessionFile: opened }
  const created = await port.sdk.createAgentSession({
    cwd,
    agentDir: port.paths.agentDir,
    settings: port.services.settings,
    authStorage: port.services.auth,
    modelRegistry: port.services.registry,
    sessionManager: manager,
    agentId,
    // The label the engine shows for this agent wherever it lists agents. It follows the id
    // rather than naming the surface, because the engine's own default (`main`) is a claim about
    // being the only one.
    agentDisplayName: agentId,
    eventBus,
    subagentEventBus: eventBus,
    hasUI: true,
    // The engine names an unnamed session itself once the reply to the operator's latest message
    // begins: it reads the operator text, skips low-signal input, and runs the request as a
    // background side turn (forked from the streaming reply, or through the title model). This is
    // the engine's own replacement for the host-side `maybeStartTitleGeneration` call it used to
    // make per prompt; the host keeps watching the name and republishes it.
    autoTitle: true,
    // The engine names an unnamed session in the user's own language; see TITLE_SYSTEM_PROMPT.
    titleSystemPrompt: TITLE_SYSTEM_PROMPT,
    interactivePrompts: true,
    skipPythonPreflight: true,
    customTools: [workspaceTerminalTool(pipe, cwd), browserTool(pipe, cwd), browserPreviewTool(pipe, cwd)],
    // The one cross-conversation safety this host adds: a `write` whose file another conversation
    // changed after this one read it is refused before it runs, so the two edits cannot silently
    // overwrite each other (`host/src/write-guard.ts`). It is an inline extension, so it travels
    // with this session only and needs no discovery, no settings and no UI.
    //
    // The second extension is the other engine seam this host needs: an upstream endpoint that
    // compacts a conversation on its own leaves a summary where work should be, and
    // `session_before_compact` is where that summary becomes this conversation's compaction instead
    // of a second summarizer call (`host/src/upstream-compaction.ts`).
    extensions: [writeGuardExtension(sessionId, cwd), upstreamCompactionExtension(sessionId)],
  })
  // Goal mode's automatic continuation is opt-in per run mode (`goal.continuationModes`, default
  // `["interactive"]`). The desktop is the non-terminal front-end here, so its own marker is added
  // to the session's runtime override layer - the same layer `/goal`'s controller reads - without
  // rewriting the user's saved configuration. A list that already carries it is left alone.
  const continuationModes = port.sdk.goalSettings.continuationModes.get(created.session.settings)
  if (!continuationModes.includes(port.sdk.goalSettings.rpcContinuationMode)) {
    port.sdk.goalSettings.continuationModes.override(created.session.settings, [
      ...continuationModes,
      port.sdk.goalSettings.rpcContinuationMode,
    ])
  }
  const losses = { droppedFrames: 0 }
  const events = new SessionEvents(
    sessionId,
    port.writer,
    count => {
      port.noteDroppedFrames(count)
      losses.droppedFrames += count
    },
    count => {
      port.noteCoalescedFrames(count)
      losses.droppedFrames += count
    },
  )
  pipe.events = events
  const live: LiveSession = {
    sessionId,
    sessionFile: opened,
    cwd,
    manager,
    agent: created.session,
    events,
    autoContinuePrompt: port.sdk.autoContinuePrompt,
    mcpManager: created.mcpManager,
    losses,
    // Every subagent frame - the two roster channels, and a child's own events - goes out
    // through this session's event pipe: one queue, one sequence, one shedding rule.
    subagents: new SubagentWatch({
      sdk: port.sdk,
      bus: eventBus,
      sessionId,
      // A child's own frames are this session's engine activity as much as the session's own are,
      // and they do not travel `session.subscribe`: a detached batch that outlives its turn keeps
      // producing them, so the silence clock is moved here too. Without it a session doing nothing
      // but that reads as silent and `sweepSilence` logs a silence over work that is running.
      publish: frame => {
        live.lastEventAt = Date.now()
        events.emit(frame)
      },
      // A child event the watch cannot address is a frame this session lost, so it is charged to
      // the same counters the queue's own shedding charges (`SessionEvents.noteDroppedFrames`).
      onEventDropped: () => events.noteDroppedFrames(1),
      // Only ever called from a bus frame or from `SubagentWatch.cancel`, both of which happen
      // after this record exists - the watch's own construction subscribes and nothing else.
      onLiveChange: () => noteChildSet(port.stop, live),
    }),
    ui: new UiBridge(
      events,
      {
        selectOptionLabel: port.sdk.selectOptionLabel,
        theme: port.sdk.theme,
        timedOutAsk: port.sdk.timedOutAsk,
        htmlForm: port.sdk.htmlForm,
      },
      configuredUiTimeoutMs(),
    ),
    lastActivityMs: Date.now(),
    // An open is the engine being asked about this conversation, so the silence clock starts here
    // rather than at zero: a session whose engine never answers reads as silent from its open, not
    // from the epoch.
    lastEventAt: Date.now(),
    silentNotified: false,
    retry: null,
    releasePending: false,
    releaseScheduled: false,
    historyRevision: 0,
    transcript: null,
    commands: [],
    // Goal mode's front-end half, constructed now so the subscription below can feed it every
    // event from the session's first turn. One controller per engine session; it holds no timer
    // of its own and dies with the session.
    goal: new port.sdk.RpcGoalController(created.session),
    // The engine names a session in the background (its own title sidecar) and reports a user
    // rename through the same manager callback, so one subscription carries both and publishes
    // the frame the rename command already published. It is registered as the record is built,
    // and the callback reads the manager's own session and event pipe instead of this record -
    // which does not exist yet at that point - so a name reported the moment the session goes
    // live is never missed.
    releaseNameWatch: manager.onSessionNameChanged(() => {
      events.emit({
        type: 'session_info_update',
        title: created.session.sessionName,
        sessionId,
      })
    }),
    // The engine re-advertises when the command set itself changes - MCP prompts loading,
    // skill reloads, a plugin enable/disable - and the palette reads the list from here, so
    // the change is republished instead of waiting for the next session open.
    releaseCommandWatch: created.session.subscribeCommandMetadataChanged(() => {
      void port.refreshCommands(live, true)
    }),
  }
  created.setToolUIContext(live.ui.context(), true)
  // Idle maintenance: the engine's own recap and idle compaction, which it offers to the owner of a
  // session and its terminal opts into (`modes/interactive-mode.ts`). Neither runs by itself - the
  // scheduler that arms them exists only once somebody calls this - so a host that skips it leaves
  // the reader's `recap.enabled` / `compaction.idleEnabled` settings with nothing behind them.
  //
  // Both remain the engine's decisions: this call only says the session is attended, and what is
  // generated, after how long idle, and whether a compaction happens at all stay the settings'
  // (`recap.*`, `compaction.idle*`, which are off for compaction by default).
  //
  // The two probes are the facts this host knows. A dialog is this session asking the reader
  // something, so autonomous work waits - the engine re-reads that probe at the moment work would
  // start, not only when it arms. A turn the reader has not typed yet is not something this host
  // can see (the desktop's composer holds the draft), and the engine's own quiet check already
  // covers everything it can: no stream, no admitted submission, no queued message.
  created.session.enableIdleMaintenance({
    isBlocked: () => live.ui.openRequests > 0,
    // The engine writes every recap to its history database as well; this is the reader-facing
    // half, and the conversation's own notice strip is where this host says things to the reader.
    onRecap: recap => {
      events.emit({ type: 'notice', level: 'info', code: 'engine_recap', message: recap })
    },
  })
  // The extension runner keeps its own UI context, and that one is what the per-tool approval gate
  // consults: `ExtensionToolWrapper` refuses any call that needs consent while `runner.hasUI()` is
  // false ("requires approval but no interactive UI available"), and a runner nobody initialized
  // holds the engine's no-op context for the session's whole life. `setToolUIContext` above feeds
  // the tool context instead - what `ask` and the built-in confirmations read - and leaves the
  // runner untouched, so the wiring the engine's own hosts perform (`modes/runtime-init.ts`, used
  // by print and RPC mode) is performed here too. Skipping it turns a non-`yolo`
  // `tools.approvalMode` into a hard failure for every gated tool call, before any dialog could
  // reach the user; with it, approval requests travel the same `extension_ui_request` path the
  // rest of the engine's dialogs use.
  //
  // Everything from here on can throw - an extension that refuses its own initialization is the
  // case this was written for - and none of it is reachable through the registry yet, so the
  // record is disposed here rather than left with watches, a running engine session and a file
  // handle that nothing would ever collect (`open` takes the manager back for the rest).
  try {
    await initializeExtensions(created.session, {
      mode: 'rpc',
      uiContext: live.ui.context(),
      reportSendError: (action, error) => logError(`extension ${action}`, error),
      reportRuntimeError: error =>
        logError(`extension ${error.event} in ${error.extensionPath}`, error.error),
    })
    // One line per session saying whether the gate can ask: it is the fact a missing approval dialog
    // is diagnosed from, and it costs nothing when everything works.
    logLine(
      `session ${sessionId} extensions initialized (interactive UI available: ${created.session.extensionRunner?.hasUI() === true})`,
    )
    created.session.subscribe(event => {
      const frame = event as unknown as Record<string, unknown>
      // Every engine event moves the silence clock, which is what makes it a measurement of the
      // engine rather than of this host: nothing else in this process stamps it.
      live.lastEventAt = Date.now()
      // The same edge moves the transcript: a paged read that cached the branch before this event
      // must rebuild it, and one that reads after it can share the pass with the pages that follow.
      live.historyRevision += 1
      // Goal mode decides at a yield whether its next turn is due, so it observes the event before
      // the frame is published: a continuation admitted here starts before any reader of this
      // event could act on it.
      live.goal.observe(event)
      // A turn can also have ended on an upstream endpoint's own compaction summary instead of the
      // work (`host/src/upstream-compaction.ts`). The engine's ending is the only moment that
      // arrival can be recognized - `prompt()` resolves when a turn is dispatched, not when it
      // settles - so the adoption starts here.
      //
      // Loop mode decides on the same ending, and it must not decide first: its submission would
      // send the history the summary was just about, and the compaction would then abort that live
      // turn. One check followed by one of the two, never both, and the loop's next iteration is
      // decided by whichever turn ends next.
      //
      // A summary also arrives on the ending the engine pauses for background work
      // (`awaitingAsyncWork`): that job's report resumes the turn, so the summary is adopted there
      // as well - the case where skipping it would re-send the refused history on the wake - and
      // the engine's own continuation carries on from the compacted context.
      const endsTurn = frame.type === 'agent_end' && (frame.isTerminal !== false || frame.awaitingAsyncWork === true)
      if (endsTurn) {
        const terminal = frame.isTerminal !== false
        void (async () => {
          const adopted = await adoptUpstreamCompaction(live, { continueAfter: terminal })
          if (adopted || !terminal) return
          // The terminal's own controller is not here to re-submit the loop prompt.
          await continueLoop(created.session, (line) => {
            created.session.emitNotice('info', line, 'loop')
          })
        })()
      }
      // The retry edges are this record's bookkeeping as well as the frontend's: the attempt is
      // part of the state view, and the snapshot published here is what a screen mounting
      // mid-retry reads.
      if (noteRetry(live, frame)) emitSessionState(live)
      // A goal's own lifecycle (created, paused, resumed, dropped, completed) arrives as its own
      // event, not as a turn edge: the mode strip reads the state snapshot, so it is republished
      // here instead of waiting for whatever turn happens next.
      if (frame.type === 'goal_updated') emitSessionState(live)
      // The engine's `xd://` mount churn is its terminal's status line, not this conversation's
      // record. It announces every toolset swap - so entering and leaving vibe or plan mode writes
      // a pair of `xd://: unmounted …` / `xd://: mounted …` lines into the composer - and it names
      // devices the reader never addressed: the mode strip and `/tools` are where the tool surface
      // is read. The model still learns about the delta through the engine's own prompt path
      // (`#pendingXdevMountDelta` rides the next prompt), so nothing is lost by dropping the line.
      if (!isToolMountNotice(frame)) {
        // An `agent_end` can be delivered for a run that is already replaced: the engine defers it
        // until its prompt unwinds (`agent-session.ts::#flushPendingAgentEnd`), so a post-turn
        // continuation can be streaming by the time the frame reaches a reader. The engine's own
        // TUI refuses exactly that frame (`event-controller.ts::#handleAgentEnd` — a streaming
        // session means this end belongs to a turn a live one has replaced), and this host owes the
        // projector the same fact: closing the turn on it would tear down the row of the run that
        // is still going. The engine's live reading travels with the frame; every other frame is
        // forwarded as it is.
        live.events.emit(
          frame.type === 'agent_end' ? { ...frame, sessionStreaming: created.session.isStreaming } : frame,
        )
      }
      // A session handed back while it was still working is dropped on the edge that ends that
      // work: the one moment a close can no longer cut anything short. Idle-but-queued sessions
      // pass this gate too - the queue's own turn will end, and that edge is a later one.
      releaseWhenDone(port.stop, live)
    })
    port.register(live)
    // The engine's own account of a conversation it could not reopen on the model it recorded: it
    // resolved another one instead (`ModelControls`/`sdk.ts` `modelFallbackMessage`), and the
    // session's record is now a model the reader did not pick. That is the fact a reopened
    // conversation reads as "it forgot the model I chose last", so it is said in the log and on the
    // conversation's own notice line rather than left to be discovered (2026-10-29, user report).
    if (created.modelFallbackMessage !== undefined) {
      logLine(`session ${sessionId} opened on a substituted model: ${created.modelFallbackMessage}`)
      created.session.emitNotice('warning', created.modelFallbackMessage, 'model')
    }
    // Goal state belongs to the transcript: a conversation reopened mid-goal gets it back here,
    // before its first prompt, exactly as the engine's own RPC host does at startup.
    await live.goal.reconcile()
    // Vibe mode is journalled the same way. Re-entering it rebuilds the worker records from this
    // session's own log first, so a reopened director still lists the workers it left behind and
    // its exit can account for them.
    await restoreVibeMode(created.session)
    // Plan mode journals `plan` / `plan_paused` the same way; only `plan` is live on reopen (the
    // paused entry means the reader already left, with the plan file kept for the next entry).
    await restorePlanMode(created.session, live.ui)
  } catch (error) {
    if (port.peek(sessionId) === live) port.unregister(sessionId)
    await disposeSession(live, 'session_open_failed')
    throw error
  }

  logLine(`session ${sessionId} activated (cwd=${cwd})`)
  // The snapshot below is this activation's own, so the refresh does not publish a second one.
  await port.refreshCommands(live, false)
  emitSessionState(live)
  return live
}
