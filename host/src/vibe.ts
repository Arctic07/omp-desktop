/**
 * Vibe mode: the body of the engine's TUI-only `/vibe` command, run by this host.
 *
 * The engine owns the mode - `activateVibeTools` installs the five worker tools, and
 * `VibeSessionRegistry` owns the persistent fast/good worker sessions, their journals and their
 * teardown - but only its terminal drives the mode (`interactive-mode.ts` `#enterVibeMode` /
 * `#exitVibeMode`). The engine offers no non-terminal controller for it (unlike goal mode's
 * `RpcGoalController`), so this module runs the engine's own sequence in the engine's order;
 * nothing here re-implements a worker, a tool or a persistence rule.
 *
 * What the desktop adds is only the shape of its own lifecycle: one entry per session, resumed at
 * open from the session's persisted `mode_change`, so a conversation reopened while it was
 * directing workers comes back as the director instead of as a plain session with no write tool.
 */

import type { AgentSession } from '@oh-my-pi/pi-coding-agent'
import type { ToolSession } from '@oh-my-pi/pi-coding-agent/tools'
import { VibeSessionRegistry, type VibeParentSession } from '@oh-my-pi/pi-coding-agent/vibe/runtime'

import { VIBE_EXIT_ABORT_GRACE_MS } from './constants.ts'

/** One worker row, as the conversation's mode strip draws it. */
export interface VibeWorkerRow {
  readonly id: string
  readonly cli: 'fast' | 'good'
  readonly state: string
  readonly killed: boolean
  readonly model: string | undefined
  readonly turns: number
  readonly queued: number
  readonly turnStartedAt: number | undefined
  readonly turnMessage: string | undefined
  readonly currentTool: string | undefined
  readonly currentToolArgs: string | undefined
  readonly lastIntent: string | undefined
  readonly lastActivityAt: number
}

/** One command result line, on the engine's own notice channel. */
export type VibeOutput = (text: string) => void

/** A sink that drops output, for a restore that has no reader waiting on it. */
const QUIET: VibeOutput = () => {}

/**
 * The toolset the director keeps while the mode is on.
 *
 * The same two names the engine's terminal uses: reading, plus the session's own todo list when it
 * has one. Everything that writes is gone on purpose - the director verifies and coordinates, the
 * workers do the work - and the five vibe tools are added by `activateVibeTools` itself.
 */
function directorTools(session: AgentSession): string[] {
  const tools = ['read']
  if (session.hasBuiltInTool('todo')) tools.push('todo')
  return tools
}

/** Whether this conversation is in vibe mode right now, as the engine records it. */
export function vibeModeEnabled(session: AgentSession): boolean {
  return session.getVibeModeState()?.enabled === true
}

/**
 * The session in the shape the worker registry addresses.
 *
 * The engine's terminal builds the same adapter for its own calls
 * (`interactive-mode.ts` `#vibeParentSession`): the registry keys workers by agent id plus the
 * session's durable identity and file, and reads the manager the workers' journals are written
 * to. Every field is the engine's own getter, so the scope this host computes is the scope the
 * engine's tools compute for the same session.
 */
function parentSession(session: AgentSession): VibeParentSession {
  const manager = session.sessionManager
  return {
    getAgentId: () => session.getAgentId() ?? null,
    getSessionId: () => manager.getSessionId(),
    getSessionFile: () => manager.getSessionFile() ?? null,
    sessionManager: manager,
    asyncJobManager: session.asyncJobManager,
    settings: session.settings,
  }
}

/**
 * The toolset each conversation had before vibe mode, for the exit path.
 *
 * The live snapshot is the accurate one while the session object survives; the persisted
 * `mode_change` is what an exit after a cold start has to use, because the live set of a
 * session built from its file is the default toolset rather than the pre-vibe one. The engine
 * reads that entry the same way on resume (`readPersistedToolNames`).
 */
const previousTools = new WeakMap<AgentSession, string[]>()

/**
 * The last mode entry on this conversation's active branch.
 *
 * A scan of the branch's entries, not `buildSessionContext()`: the mode is the last
 * `mode_change` entry, and the context builder additionally decodes every message on the branch.
 * The open path already pays for one context build for goal mode (`RpcGoalController.reconcile`),
 * so a second one here would cost every conversation - including the ones that never used vibe
 * mode - a full transcript replay on each open.
 */
function lastModeChange(
  session: AgentSession,
): { readonly mode: string; readonly data: unknown } | undefined {
  const entries = session.sessionManager.getBranch()
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry.type === 'mode_change') return { mode: entry.mode, data: entry.data }
  }
  return undefined
}

/** The toolset the journal says this conversation had before vibe mode, when it recorded one. */
function persistedPreviousTools(session: AgentSession): string[] | undefined {
  const entry = lastModeChange(session)
  if (entry?.mode !== 'vibe' || typeof entry.data !== 'object' || entry.data === null) return undefined
  if (!('previousTools' in entry.data)) return undefined
  const value = entry.data.previousTools
  if (!Array.isArray(value) || !value.every((name) => typeof name === 'string')) return undefined
  return value
}

/**
 * One entry in flight per conversation.
 *
 * Two `/vibe` prompts can overlap (a prompt is answered before the command finishes), and the
 * second one must not snapshot a toolset the first is still rewriting: it joins the first entry,
 * which is the engine's own rule for a repeated command.
 */
const entries = new WeakMap<AgentSession, Promise<void>>()

/**
 * Turns this conversation into the director of a vibe worker fleet.
 *
 * Answers `false` when another mode owns the conversation. The two conflicts are the engine's:
 * plan mode keeps delegated work read-only, and goal mode is a different consumer of the turn, so
 * the engine refuses both rather than letting the two modes rewrite the same toolset.
 */
export async function enterVibeMode(
  session: AgentSession,
  output: VibeOutput = QUIET,
  options: { persist?: boolean } = {},
): Promise<boolean> {
  if (vibeModeEnabled(session)) return true
  const inFlight = entries.get(session)
  if (inFlight !== undefined) {
    await inFlight
    return vibeModeEnabled(session)
  }
  if (session.getPlanModeState()?.enabled === true) {
    output('Exit plan mode first.')
    return false
  }
  if (session.getGoalModeState()?.enabled === true) {
    output('Exit goal mode first.')
    return false
  }
  const registry = VibeSessionRegistry.global()
  // An exit closes spawn admission for the scope; a new entry is what reopens it.
  registry.activateScope(registry.ownerScope(parentSession(session)))
  const before = session.getEnabledToolNames()
  const entry = (async (): Promise<void> => {
    await session.activateVibeTools(directorTools(session))
    previousTools.set(session, before)
    session.setVibeModeState({ enabled: true })
    // A turn already running keeps its messages; the director instructions arrive as a steer, the
    // way any other mid-turn guidance does.
    if (session.isStreaming) await session.sendVibeModeContext({ deliverAs: 'steer' })
    // A restore re-enters a mode the journal already records; writing it again would append a
    // second `mode_change` per reopen and replace the original toolset snapshot with the one this
    // process started from. The engine's own resume path skips the write for the same reason
    // (`interactive-mode.ts` `#enterVibeMode({ persistModeChange: false })`).
    if (options.persist !== false) {
      session.sessionManager.appendModeChange('vibe', { previousTools: before })
    }
  })()
  entries.set(session, entry)
  try {
    await entry
  } finally {
    if (entries.get(session) === entry) entries.delete(session)
  }
  return true
}

/**
 * Waits for the turn an exit aborts, but not past the grace.
 *
 * `abort()` answers when the turn reaches its end, and the turn that has to be ended here is often
 * the one most likely to resist it: a director blocked in `vibe_wait`, in a long tool, or in a
 * provider that has stopped answering. The engine's terminal can afford to wait; this command
 * cannot, because it is the conversation's only way out of a read-only toolset. The host's own stop
 * already refuses to hang on the same promise (`session-stop.ts::stopSession`), and this is that
 * rule applied to the exit.
 */
async function abortDirectorTurn(session: AgentSession, graceMs: number): Promise<void> {
  const settle = Promise.withResolvers<void>()
  const timer = setTimeout(settle.resolve, graceMs)
  try {
    await Promise.race([session.abort().catch(() => undefined), session.waitForIdle().catch(() => undefined), settle.promise])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Stops every worker this conversation owns and restores the toolset it had before.
 *
 * The teardown runs inside `runModeExitTeardown` because aborting the active turn would otherwise
 * let a queued steer or follow-up start against the still-installed vibe tools. The worker kill is
 * what persists `mode_change: none` (the engine's own mode-exit journal), so this path does not
 * write a second one.
 *
 * Leaving the mode does not depend on the workers being accounted for. A kill that fails (a journal
 * the engine could not write, a worker whose terminal record was refused) is reported on the
 * command's own line, but the toolset still comes back and the mode still goes off: the reader was
 * told the workers are gone, and a conversation left in the director's read-only toolset with no
 * way to leave it is the worse of the two truths. The survivors stay in the registry, where the next
 * entry `activateScope` reopens admission over them.
 *
 * @returns how many worker sessions the kill took, for the command's own line.
 */
export async function exitVibeMode(
  session: AgentSession,
  output: VibeOutput = QUIET,
  options: { abortGraceMs?: number } = {},
): Promise<number> {
  if (!vibeModeEnabled(session)) return 0
  const registry = VibeSessionRegistry.global()
  const parent = parentSession(session)
  const scope = registry.ownerScope(parent)
  const restore = previousTools.get(session) ?? persistedPreviousTools(session) ?? []
  let killed = 0
  let failure: unknown
  await session.runModeExitTeardown(async () => {
    if (session.isStreaming) await abortDirectorTurn(session, options.abortGraceMs ?? VIBE_EXIT_ABORT_GRACE_MS)
    try {
      killed = await registry.killAll(parent, scope)
    } catch (error) {
      failure = error
    }
    try {
      await session.deactivateVibeTools(restore)
    } finally {
      session.setVibeModeState(undefined)
    }
  })
  previousTools.delete(session)
  if (failure !== undefined) output(failure instanceof Error ? failure.message : String(failure))
  return killed
}

/**
 * The worker rows this conversation's director is driving, in spawn order.
 *
 * Read from the engine's own fleet snapshot (`VibeSessionRegistry.screens`), which is the same data
 * the terminal's TV wall and the `vibe_list` tool see: a second reading of the workers here would
 * be a second truth about state, model and progress.
 */
export function vibeWorkers(session: AgentSession): VibeWorkerRow[] {
  const registry = VibeSessionRegistry.global()
  // `screens` is typed against `ToolSession`, but its body only resolves the owner scope - the
  // three getters `parentSession()` answers - so this is the engine's own structural mismatch,
  // narrowed here instead of fabricating a session.
  const screens = registry.screens(parentSession(session) as unknown as ToolSession)
  return screens.map((worker) => ({
    id: worker.id,
    cli: worker.cli,
    state: worker.state,
    killed: worker.killed === true,
    model: worker.model,
    turns: worker.turns,
    queued: worker.queued,
    turnStartedAt: worker.turnStartedAt,
    turnMessage: worker.turnMessage,
    currentTool: worker.currentTool,
    currentToolArgs: worker.currentToolArgs,
    lastIntent: worker.lastIntent,
    lastActivityAt: worker.lastActivityAt,
  }))
}

/**
 * Restores the mode for a conversation that was directing workers when it closed.
 *
 * The journal is the authority: the last `mode_change` says whether the conversation was in vibe
 * mode, and the worker records are rebuilt from the same session before the mode is re-entered -
 * otherwise a reopened director would list no workers and its exit would leave them unaccounted.
 * A conversation that is already live in this process (mode still on) is left alone.
 */
export async function restoreVibeMode(session: AgentSession, output: VibeOutput = QUIET): Promise<void> {
  if (lastModeChange(session)?.mode !== 'vibe') return
  if (vibeModeEnabled(session)) return
  await VibeSessionRegistry.global().rehydrate(parentSession(session))
  await enterVibeMode(session, output, { persist: false })
}
