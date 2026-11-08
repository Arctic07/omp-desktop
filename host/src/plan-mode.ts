/**
 * Plan mode: the body of the engine's terminal-only `/plan`, run by this host.
 *
 * The engine's own non-terminal implementation is ACP's `#applyModeChange` /
 * `#handleAcpPlanProposal`, and this module follows it: plan mode is session state
 * (`setPlanModeState`) plus a plan-proposal handler that consumes the agent's `xd://propose`
 * write, asks the reader to approve or refine, and on approval hands the plan to the next turn as
 * context. The tool partition and the plan system prompt are the session's own (they read this
 * state), so nothing here re-implements the read-only guarantee.
 *
 * One deviation from the terminal, on purpose: the terminal also swaps the model to the `plan`
 * role while planning. ACP does not, and neither does this host - a desktop conversation keeps
 * the model its reader chose; the plan prompt is what shapes the turn. What the host does take from
 * the terminal is `plan.defaultOnStartup` (`restorePlanMode`): a fresh conversation opens planning
 * when the setting says so, because the desktop has the approval dialog the setting assumes.
 */

import type { AgentSession } from '@oh-my-pi/pi-coding-agent'
import {
  normalizePlanTitle,
  resolveApprovedPlan,
  type PlanApprovalDetails,
} from '@oh-my-pi/pi-coding-agent/plan-mode/approved-plan'
import { autosaveApprovedPlan } from '@oh-my-pi/pi-coding-agent/plan-mode/plan-autosave'
import { listPlanFiles, readPlanFile } from '@oh-my-pi/pi-coding-agent/plan-mode/plan-files'
import { cfgPlanDefaultOnStartup, cfgPlanEnabled } from '@oh-my-pi/pi-coding-agent/plan-mode/settings'
import type { AgentToolResult } from '@oh-my-pi/pi-coding-agent'

import type { UiBridge } from './ui.ts'

/** The plan file a conversation plans into when nothing else was recorded (ACP's default). */
const DEFAULT_PLAN_FILE_URL = 'local://PLAN.md'

/** How many plan lines the approval dialog shows before cutting the preview. */
const PREVIEW_LINES = 12

/** One command result line, on the engine's own notice channel. */
export type PlanOutput = (text: string) => void

/** A sink that drops output, for a restore that has no reader waiting on it. */
const QUIET: PlanOutput = () => {}

/** Whether this conversation is planning right now, as the engine records it. */
export function planModeEnabled(session: AgentSession): boolean {
  return session.getPlanModeState()?.enabled === true
}

/**
 * Where the session's `local://` URLs live, in the engine's own answer for the same values.
 *
 * `resolvePlanFilePath`/`readPlanFile`/`listPlanFiles` take this shape, and the engine's ACP host
 * builds it identically from the session manager (`acp-agent.ts` `#resolveAcpPlanFilePath`).
 */
function localProtocolOptions(session: AgentSession): {
  getArtifactsDir: () => string | null
  getSessionId: () => string
} {
  const manager = session.sessionManager
  return {
    getArtifactsDir: () => manager.getArtifactsDir(),
    getSessionId: () => manager.getSessionId(),
  }
}

/** Reads one plan URL as the approval path does: null when the file is not there. */
function readPlan(session: AgentSession, planUrl: string): Promise<string | null> {
  return readPlanFile(planUrl, {
    localProtocolOptions: localProtocolOptions(session),
    cwd: session.sessionManager.getCwd(),
  })
}

/** Candidate plan files for a proposal whose title could not be reconstructed (newest first). */
function listPlans(session: AgentSession): Promise<string[]> {
  return listPlanFiles({ localProtocolOptions: localProtocolOptions(session) })
}

/** The dialog a reader answers for a plan: execute it, or send it back for refinement. */
function planPreview(title: string, content: string): string {
  const lines = content.split('\n')
  const preview = lines.slice(0, PREVIEW_LINES).join('\n')
  const ellipsis = lines.length > PREVIEW_LINES ? '\n…' : ''
  return `Approve plan “${title}” and start implementation?\n\n${preview}${ellipsis}`
}

/** Asks the reader about one plan, and says whether it was approved. Dismissal is a refine. */
async function askApproval(ui: UiBridge, title: string, content: string): Promise<boolean> {
  const answer = await ui.context().select(
    planPreview(title, content),
    ['Execute the plan', 'Keep planning'],
    {},
  )
  return answer === 'Execute the plan'
}

/**
 * Runs the approval dialog for a plan and answers what the agent's `xd://propose` call gets.
 *
 * The three branches are the engine's ACP branches verbatim: a rejection keeps plan mode active
 * and points the next planning turn at the reviewed file; an approval clears the handler and the
 * mode, records the plan as the next turn's context, and autosaves a copy under the project's
 * plans directory when the setting asks for one.
 */
async function approvePlan(
  session: AgentSession,
  ui: UiBridge,
  suppliedTitle: string | undefined,
): Promise<{ approved: boolean; details: PlanApprovalDetails }> {
  const state = session.getPlanModeState()
  if (state === undefined || !state.enabled) throw new Error('Plan mode is not active.')
  const resolved = await resolveApprovedPlan({
    suppliedTitle,
    statePlanFilePath: state.planFilePath,
    readPlan: (url) => readPlan(session, url),
    listPlanFiles: () => listPlans(session),
  })
  const approved = await askApproval(ui, resolved.title, resolved.planContent)
  const details: PlanApprovalDetails = {
    planFilePath: resolved.planFilePath,
    title: resolved.title,
    planExists: true,
  }
  if (!approved) {
    if (state.planFilePath !== resolved.planFilePath) {
      session.setPlanModeState({ ...state, planFilePath: resolved.planFilePath })
    }
    return { approved, details }
  }
  session.setPlanReferencePath(resolved.planFilePath)
  session.setPlanProposalHandler(null)
  session.setPlanModeState(undefined)
  try {
    await autosaveApprovedPlan({
      settings: session.settings,
      cwd: session.sessionManager.getCwd(),
      title: resolved.title,
      planContent: resolved.planContent,
    })
  } catch {
    // Autosave is a copy; the plan file the agent wrote is the plan. A failed copy must not turn
    // an approval into a rejection.
  }
  session.sessionManager.appendModeChange('none')
  return { approved, details }
}

/** The agent-facing answer to one proposal, in the words the engine's ACP host uses. */
function proposalResult(
  approved: boolean,
  details: PlanApprovalDetails,
): AgentToolResult<unknown> {
  return {
    content: [
      {
        type: 'text',
        text: approved
          ? `Plan approved: ${details.planFilePath}. Execute it.`
          : `Plan refinement requested. Update the plan file, then write ${normalizePlanTitle(details.title).title} to xd://propose again when ready.`,
      },
    ],
    details,
  }
}

/**
 * Wires this conversation for plan mode and installs its proposal handler.
 *
 * The handler is what makes the mode a loop instead of a dead end: the plan prompt tells the agent
 * to finish by writing the plan title to `xd://propose`, and this is the other end of that write.
 */
function activate(session: AgentSession, ui: UiBridge, planFilePath: string, reentry: boolean): void {
  const previous = session.getPlanModeState()
  session.setPlanModeState({
    enabled: true,
    planFilePath,
    workflow: previous?.workflow ?? 'parallel',
    reentry,
  })
  session.setPlanProposalHandler(async (title) => {
    const { approved, details } = await approvePlan(session, ui, title)
    return proposalResult(approved, details)
  })
}

/**
 * Turns this conversation into a planner.
 *
 * Answers `false` when another mode owns it; goal and vibe are the engine's own conflicts, because
 * each mode rewrites the turn's prompt and tools.
 */
export async function enterPlanMode(
  session: AgentSession,
  ui: UiBridge,
  output: PlanOutput = QUIET,
): Promise<boolean> {
  if (planModeEnabled(session)) return true
  if (session.getGoalModeState()?.enabled === true) {
    output('Exit goal mode first.')
    return false
  }
  if (session.getVibeModeState()?.enabled === true) {
    output('Exit vibe mode first.')
    return false
  }
  if (!cfgPlanEnabled.get(session.settings)) {
    output('Plan mode is disabled. Enable it in settings (plan.enabled).')
    return false
  }
  activate(session, ui, journaledPlanFile(session) ?? DEFAULT_PLAN_FILE_URL, false)
  try {
    // A running turn keeps its messages; the plan instructions arrive as a steer.
    if (session.isStreaming) await session.sendPlanModeContext({ deliverAs: 'steer' })
  } catch (error) {
    session.setPlanProposalHandler(null)
    session.setPlanModeState(undefined)
    throw error
  }
  session.sessionManager.appendModeChange('plan', { planFilePath: session.getPlanModeState()?.planFilePath })
  return true
}

/**
 * Leaves plan mode without approving anything.
 *
 * The journal records `plan_paused`, which is the engine's own word for "the reader stepped out of
 * a plan that still exists": a later `/plan` re-enters against the same file rather than starting
 * over, and a reopened conversation simply is not planning.
 */
export async function exitPlanMode(
  session: AgentSession,
  output: PlanOutput = QUIET,
): Promise<void> {
  const state = session.getPlanModeState()
  if (state === undefined || !state.enabled) return
  session.setPlanProposalHandler(null)
  session.setPlanModeState(undefined)
  session.sessionManager.appendModeChange('plan_paused', { planFilePath: state.planFilePath })
}

/**
 * Re-opens the approval dialog for the plan the conversation is planning.
 *
 * The terminal's `/plan-review` shows the same dialog the proposal opened; here it reads the file
 * the mode is pointed at, so a reader can review or re-approve without another agent turn.
 */
export async function reviewPlan(
  session: AgentSession,
  ui: UiBridge,
  output: PlanOutput = QUIET,
): Promise<void> {
  const state = session.getPlanModeState()
  if (state === undefined || !state.enabled) {
    output('Plan mode is not active.')
    return
  }
  // Silent on both outcomes: an approval leaves the mode (the composer's chip goes with it), and a
  // refinement keeps the plan panel open, where the reader asked from.
  await approvePlan(session, ui, undefined)
}

/**
 * The plan file the journal last recorded for this conversation, when it recorded one.
 *
 * A paused plan keeps its file: `/plan` re-enters against the same markdown rather than starting
 * over, which is what the terminal's paused state means.
 */
function journaledPlanFile(session: AgentSession): string | undefined {
  const entries = session.sessionManager.getBranch()
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry.type !== 'mode_change') continue
    const data = entry.data
    const file =
      typeof data === 'object' && data !== null && 'planFilePath' in data && typeof data.planFilePath === 'string'
        ? data.planFilePath
        : undefined
    return entry.mode === 'plan' || entry.mode === 'plan_paused' ? file : undefined
  }
  return undefined
}

/**
 * Restores plan mode for a conversation whose journal ends in `plan`.
 *
 * `plan_paused` restores nothing on purpose: the tools and prompt were already restored when the
 * reader stepped out, and the terminal treats a paused plan as inert on reopen too.
 *
 * **A conversation nothing has been said in does not come back planning** (2026-10-26, user report:
 * a new conversation reopened with the plan chip on it). Plan mode is a way to do work, and an empty
 * conversation has no work: the only way it could have been entered there is against the empty seat
 * itself. Restoring it made a conversation the reader had never written in look like a planner. The
 * journal records the reader stepping out (`plan_paused`), so a message sent later does not bring the
 * mode back on the next open.
 */
export async function restorePlanMode(session: AgentSession, ui: UiBridge): Promise<void> {
  if (restoreJournaledPlan(session, ui)) return
  // `plan.defaultOnStartup` is the engine's own answer for a *fresh interactive* session
  // (`interactive-mode.ts::shouldEnterPlanModeOnStartup`): nothing said yet, no mode recorded, and
  // the setting on. The desktop is an interactive surface - it has the approval dialog - so the
  // setting is honored here too; a headless print run deliberately ignores it (there is nothing to
  // review a plan from).
  if (planModeEnabled(session)) return
  if (session.messages.length > 0) return
  if (session.sessionManager.getBranch().some((entry) => entry.type === 'mode_change')) return
  if (!cfgPlanEnabled.get(session.settings) || !cfgPlanDefaultOnStartup.get(session.settings)) return
  await enterPlanMode(session, ui, (line) => session.emitNotice('info', line, 'plan'))
}

/**
 * The plan a conversation was already in, as its journal records it.
 *
 * Answers whether the journal decided the question at all: a `mode_change` that is not `plan` ends
 * the walk (`plan_paused` and `none` both leave the mode off), so the startup default never
 * re-enters a conversation the reader stepped out of.
 */
function restoreJournaledPlan(session: AgentSession, ui: UiBridge): boolean {
  const entries = session.sessionManager.getBranch()
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry.type !== 'mode_change') return false
    if (entry.mode !== 'plan') return true
    if (planModeEnabled(session)) return true
    const planFilePath = journaledPlanFile(session) ?? DEFAULT_PLAN_FILE_URL
    if (session.messages.length === 0) {
      session.sessionManager.appendModeChange('plan_paused', { planFilePath })
      return true
    }
    activate(session, ui, planFilePath, true)
    return true
  }
  return false
}
