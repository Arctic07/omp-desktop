/**
 * What one conversation looks like to the frontend, read from the engine object.
 *
 * Split out of the session registry because it is the one part of the record that is pure
 * projection: it reads the engine's own getters and the bookkeeping the registry keeps beside
 * them, and it writes nothing but the frame it publishes. Every field here therefore has the
 * engine as its source of truth, which is what keeps a published snapshot from drifting away
 * from the session it describes.
 */

import type { InternalAvailableSlashCommand } from '@oh-my-pi/pi-coding-agent/slash-commands/available-commands'
import { getSessionCompactionBoundaries } from '@oh-my-pi/pi-coding-agent/session/context-usage-runtime'

import type { SessionEvents } from './events.ts'
import { sanitizeMessage } from './log.ts'
import type { AgentSession, SessionManager } from './sdk.ts'
import { loopModeEnabled, loopModeView } from './loop-mode.ts'
import { vibeWorkers, type VibeWorkerRow } from './vibe.ts'

/** One planning-mode row: the plan file the conversation is pointed at. */
export interface PlanModeView {
  readonly planFilePath: string
}

/** One goal-mode row: the objective and the accounting the engine keeps for it. */
export interface GoalModeView {
  readonly enabled: boolean
  readonly status: string
  readonly objective: string
  readonly tokensUsed: number
  readonly tokenBudget: number | null
  readonly timeUsedSeconds: number
}

/** The modes one conversation is in, as the composer's strip draws them. */
export interface LoopModeView {
  readonly enabled: boolean
  readonly paused: boolean
  readonly prompt?: string
  readonly limit?: string
  readonly condition?: string
}

export interface SessionModesView {
  readonly goal?: GoalModeView
  readonly plan?: PlanModeView
  readonly vibe?: { readonly workers: readonly VibeWorkerRow[] }
  readonly loop?: LoopModeView
}

/**
 * The modes this conversation is in.
 *
 * Goal and plan are the engine's own mode records; vibe's worker rows come from its own fleet
 * snapshot. A mode that is off is absent rather than `{enabled:false}`: "not in this mode" and
 * "the host never heard of it" are the same drawing, and the strip draws a chip per present mode.
 */
function modesFor(agent: AgentSession): SessionModesView {
  const modes: {
    goal?: GoalModeView
    plan?: PlanModeView
    vibe?: { workers: readonly VibeWorkerRow[] }
    loop?: LoopModeView
  } = {}
  const goal = agent.getGoalModeState()
  if (goal !== undefined) {
    modes.goal = {
      enabled: goal.enabled,
      status: goal.goal.status,
      objective: goal.goal.objective,
      tokensUsed: goal.goal.tokensUsed,
      tokenBudget: goal.goal.tokenBudget ?? null,
      timeUsedSeconds: goal.goal.timeUsedSeconds,
    }
  }
  const plan = agent.getPlanModeState()
  if (plan?.enabled === true) modes.plan = { planFilePath: plan.planFilePath }
  if (agent.getVibeModeState()?.enabled === true) modes.vibe = { workers: vibeWorkers(agent) }
  if (loopModeEnabled(agent)) modes.loop = loopModeView(agent)
  return modes
}

/** One retry in flight, as the engine reports it: which attempt, and what it is retrying from. */
export interface RetryState {
  readonly attempt: number
  readonly maxAttempts: number
  readonly delayMs: number
  readonly errorMessage: string | null
}

/** The record fields a state view is built from. */
export interface SessionViewSource {
  readonly sessionId: string
  readonly agent: AgentSession
  /**
   * The watch whose live set a stop walks.
   *
   * The count below is read from it rather than tracked beside it, so what a state frame says a stop
   * can cancel and what `cancel` actually cancels are one fact - which is why the session's own
   * agent id is handed to it: the watch answers with the children its frames saw *and* the ones the
   * engine's registry holds for that agent, and the stop cancels the same two sources.
   */
  readonly subagents: { liveIds(ownerId?: string): readonly string[] }
  /** The command list this session last advertised, in the engine's own entry shape. */
  commands: InternalAvailableSlashCommand[]
  /**
   * When the engine last said anything about this conversation, in epoch ms.
   *
   * The one fact on this view that measures rather than states: everything else here says what the
   * session *is* (`isStreaming`, `pendingAsyncWork`, a child count), and a reader that wants to know
   * whether any of it is still moving has nothing to compare against. Published as `lastEventAt` so
   * the frontend measures a silence against the host's own clock rather than its own frame arrivals
   * - which a frame this host publishes during the silence would reset.
   */
  lastEventAt: number
  /** Set by {@link noteRetry}: true while the engine waits to retry the last request. */
  retry: RetryState | null
  /** Frames this session's outbound path discarded before the wire. */
  readonly losses: { droppedFrames: number }
  readonly events: SessionEvents
  /**
   * The conversation's own manager: the state view reads the active path's tip off it (`tipEntryId`).
   */
  readonly manager: SessionManager
}

/**
 * The last message entry on the conversation's active path, or null while it holds none.
 *
 * This is what a rewind from the newest row of a conversation names. The engine's log is
 * append-only and carries bookkeeping beside the conversation (`title_change`, model and thinking
 * entries, labels), so the tip is the newest entry that is a *message*: the answer a turn ended on,
 * or the result of the call it ended with. A live row this desktop drew from frames has no entry id
 * of its own, which is exactly why the host reports this one - the turn that just settled is the
 * turn those rows belong to.
 */
function tipEntryId(manager: SessionManager): string | null {
  const entries = manager.getBranch()
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry?.type === 'message') return entry.id
  }
  return null
}

/** A finite engine number, or zero: a field the engine did not report counts as none of it. */
function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Where the engine would compact this session, as a share of the window it measured, or null.
 *
 * `getSessionCompactionBoundaries` is the engine's own boundary arithmetic: it reads the session's
 * compaction settings (whether the switch is on, the strategy, a configured percent or token cap)
 * and answers null when nothing would run. The host asks it rather than re-deriving the rule, which
 * is what keeps the trigger a reader sees and the trigger the engine acts on the same number.
 */
function autoCompactPercent(agent: AgentSession, contextWindow: number): number | null {
  const percent = getSessionCompactionBoundaries(agent.settings, contextWindow, agent.model)
    ?.thresholdPercent
  return typeof percent === 'number' && Number.isFinite(percent) ? percent : null
}

/**
 * Thinking levels the current session model offers in the frontend vocabulary.
 *
 * An empty answer is a fact, not a missing report: the model has no reasoning surface at all, and a
 * control over it would be offering a strength the engine refuses (`getAvailableThinkingLevels` is
 * empty for every non-reasoning model). A lone `auto` is not a substitute - one stop still reads as
 * "there is something to choose" - so the composer hides the control on an empty answer
 * (2026-10-29, user report).
 *
 * Otherwise `auto` is always first because it means "let the engine decide"; `off` is offered for
 * every reasoning model, and the engine's effort ladder follows in its own least-to-most order.
 */
function thinkingLevelsFor(agent: AgentSession): string[] {
  if (!agent.model?.reasoning) return []
  return [
    'auto',
    'off',
    ...(agent.getAvailableThinkingLevels() as readonly string[]),
  ]
}

/**
 * The session's running background jobs, in the engine's own words.
 *
 * Read from the manager the engine owns rather than tracked beside it, so what the state frame
 * reports and what a stop cancels are the same set - the same rule `cancellableSubagents` follows
 * for the children. These are the jobs a turn's abort does not reach: a bash or eval call that
 * outlived its foreground wait, or a detached `task` batch. They are published separately from the
 * children because a reader has to be able to say *what* is still running - a count of subagents
 * names none of them - and because a stop control drawn on the children alone is absent exactly when
 * only one of these is left.
 */
function backgroundJobsFor(agent: AgentSession): Array<Record<string, unknown>> {
  const manager = agent.asyncJobManager
  const ownerId = agent.getAgentId()
  // No owner id means no way to scope the read to this conversation, and another session's jobs
  // read as this one's would be worse than reading none: the same rule `liveIds` follows.
  if (manager === undefined || ownerId === undefined) return []
  return manager.getRunningJobs({ ownerId }).map(job => ({
    id: job.id,
    type: job.type,
    label: job.label,
    startedAt: job.startTime,
  }))
}

/**
 * The state view (contract §2.7).
 *
 * Every field is read from the engine object, so a state the host publishes cannot drift from the
 * session it describes.
 */
export function sessionStateView(source: SessionViewSource): Record<string, unknown> {
  const agent = source.agent
  // One call answers four questions: the engine's own breakdown already carries the occupancy its
  // `getContextUsage()` returns (`usedTokens` and `contextWindow`, with its own percentage), plus
  // the per-category split that no other getter exposes. Calling both would tokenize the system
  // prompt and walk the branch twice for the same numbers.
  const breakdown = (agent.getContextBreakdown() ?? null) as Record<string, unknown> | null
  const contextWindow = numberOrZero(breakdown?.contextWindow)
  const usedTokens = numberOrZero(breakdown?.usedTokens)
  // The session's cumulative totals, from the engine's own index rather than summed from frames
  // here: how much of a conversation's traffic the provider served from its prompt cache is a fact
  // about the whole session, and only the engine counts it.
  const totals = source.manager.getUsageStatistics()
  return {
    model: agent.model,
    thinkingLevels: thinkingLevelsFor(agent),
    thinkingLevel: agent.thinkingLevel,
    isStreaming: agent.isStreaming,
    // Whether this conversation is directing vibe workers. A fact about the session rather than
    // about any turn, so it travels in the snapshot: the composer's mode strip draws from it, and
    // a screen mounting mid-mode has no edge to have missed.
    modes: modesFor(agent),
    // The engine's own fact that background work can still re-wake this session - the state a
    // detached `task` batch leaves behind, where `isStreaming` alone says "idle" while a stop
    // still has something to stop.
    pendingAsyncWork: agent.hasPendingAsyncWork(),
    // The one fact a stop control can act on beyond the turn: the children this host holds and can
    // cancel, read from the watch that does the cancelling under this session's own agent id, so it
    // is the same set `cancel` walks. The engine's background work above is the wider fact - it can
    // owe this session a result with nothing left to cancel - so a control drawn on it would press,
    // do nothing and report nothing, which is what it did before this field existed.
    cancellableSubagents: source.subagents.liveIds(source.agent.getAgentId()).length,
    isCompacting: agent.isCompacting,
    steeringMode: agent.steeringMode,
    followUpMode: agent.followUpMode,
    interruptMode: agent.interruptMode,
    sessionFile: agent.sessionFile,
    sessionId: agent.sessionId,
    // The active path's tip, for the actions that continue a conversation from where it stands.
    tipEntryId: tipEntryId(source.manager),
    sessionName: agent.sessionName ?? null,
    autoCompactionEnabled: agent.autoCompactionEnabled,
    queuedMessageCount: agent.queuedMessageCount,
    todoPhases: agent.getTodoPhases(),
    messageCount: agent.messages.length,
    contextUsage: {
      tokens: usedTokens,
      contextWindow,
      // The engine's own formula for the same two numbers (`session/session-stats.ts::
      // getContextUsage`: used over window, zero without a window).
      percent: contextWindow > 0 ? (usedTokens / contextWindow) * 100 : 0,
      // Whether those numbers stand on something the provider actually reported. The engine walks
      // the transcript for the newest assistant snapshot that carried usage and adds what came
      // after it, so `false` means the whole figure is its own tokenizer estimate - which is what
      // the card marks with `≈` rather than presenting as a measurement.
      anchored: breakdown?.anchored === true,
      // Where the engine would compact this conversation, as a share of the window it measured:
      // the engine's own boundary arithmetic rather than a copy of its rule - the threshold is
      // `window - reserve` (or the configured percent, or the configured token cap), and the same
      // helper draws the engine's own status-line gauge, so the number a reader sees on this
      // desktop is the number the engine acts on. `null` means the engine would not compact at all
      // (compaction off, or no method configured); it is published even then, which is how a
      // caller tells "will not compact" apart from a host that never said.
      autoCompactPercent: autoCompactPercent(agent, contextWindow),
      // The engine's own split of what is in use, under its own category ids: the popover's bar and
      // legend are drawn from these, and the caller leaves out the categories the engine reports as
      // empty rather than drawing a row for nothing.
      categories: {
        systemPrompt: numberOrZero(breakdown?.systemPromptTokens),
        systemTools: numberOrZero(breakdown?.systemToolsTokens),
        systemContext: numberOrZero(breakdown?.systemContextTokens),
        skills: numberOrZero(breakdown?.skillsTokens),
        messages: numberOrZero(breakdown?.messagesTokens),
      },
    },
    // What this session's calls have spent so far, from the engine's own index rather than summed
    // from frames here: only the engine counts what a provider billed, and the numbers are the
    // session's, not any one turn's.
    sessionUsage: {
      // Prompt tokens the provider billed as fresh, i.e. the misses a hit rate is measured against.
      inputTokens: numberOrZero(totals.input),
      cacheReadTokens: numberOrZero(totals.cacheRead),
      cacheWriteTokens: numberOrZero(totals.cacheWrite),
    },
    commands: source.commands,
    // The work this session is running that neither the turn bit nor the child count describes: a
    // bash or eval call the engine moved to the background, or a detached `task` batch. Empty for
    // most sessions, and hidden on the wire by the Rust projection when it is.
    backgroundJobs: backgroundJobsFor(agent),
    // When the engine last said anything here, so a reader can measure a silence against the host's
    // own clock instead of its own frame arrivals - see the field's own comment on the view source.
    lastEventAt: source.lastEventAt,
    // The retry the engine is waiting on, or null. In the snapshot because it is a fact about
    // the session as a whole: a screen that mounts mid-retry has no event to have missed.
    retry: source.retry,
    // Losses this session's outbound path took (contract §5): a consumer that only reads
    // `host_health` cannot tell which conversation lost frames, and the conversation is where
    // the missing rows are read.
    droppedFrames: source.losses.droppedFrames,
    // Resync anchor (contract §2.7): the sequence number this view reflects, i.e. the last
    // frame published before the payload was built. A caller that reopens an already-loaded
    // session continues counting from here instead of resetting to 1 and replaying the whole
    // journal - which the frontend would project a second time.
    seq: source.events.seq,
  }
}

/**
 * Whether an engine event is one of the `xd://` mount announcements.
 *
 * The engine emits one per toolset change (`session-tools.ts::#notifyXdevMountDelta`), which makes
 * it a status line for its terminal's tool bar: every mode that swaps tools - vibe's director set,
 * plan mode's read-only set - writes a pair of them, and the devices it names (`ast_edit`, `debug`,
 * `lsp`) are the ones this desktop never addresses through the transport. Its content is also not
 * the model's only notice of the change: the same delta rides the next prompt as a system line.
 */
export function isToolMountNotice(event: Record<string, unknown>): boolean {
  return event.type === 'notice' && event.source === 'xdev'
}

/** Publishes the state view above on the session's own event pipe. */
export function emitSessionState(source: SessionViewSource): void {
  source.events.emit({ type: 'state', state: sessionStateView(source) })
}

/**
 * Records the engine's retry edges on the live session.
 *
 * Returns true when the retry moved, i.e. when the state view a consumer holds is now stale and
 * has to be republished. The end edge clears the record unconditionally: an engine that reports
 * an end this host never saw start still has to leave no retry behind.
 */
export function noteRetry(source: SessionViewSource, event: Record<string, unknown>): boolean {
  if (event.type === 'auto_retry_end') {
    if (source.retry === null) return false
    source.retry = null
    return true
  }
  if (event.type !== 'auto_retry_start') return false
  source.retry = {
    attempt: typeof event.attempt === 'number' ? event.attempt : 0,
    maxAttempts: typeof event.maxAttempts === 'number' ? event.maxAttempts : 0,
    delayMs: typeof event.delayMs === 'number' ? event.delayMs : 0,
    errorMessage: typeof event.errorMessage === 'string' ? sanitizeMessage(event.errorMessage) : null,
  }
  return true
}
