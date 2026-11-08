/**
 * Guided goal: the body of the engine's terminal-only `/guided-goal`, run by this host.
 *
 * The engine's flow is one hidden prompt plus the `goal` tool: the interview is an ordinary
 * conversation (the agent asks, the reader answers, the agent finishes by calling `goal create`),
 * which means the only terminal-specific pieces are the kickoff text and the tool exposure. Both
 * are the engine's own - the prompt template is imported as text and rendered with the engine's
 * renderer, and the goal tool is the session's own registration.
 *
 * The one bookkeeping this module keeps is the pre-interview toolset: the interview needs `goal`
 * active before a goal exists, so a reader who abandons the interview (a `/goal drop` instead of a
 * created goal) gets the toolset they started with back.
 */

import type { AgentSession } from '@oh-my-pi/pi-coding-agent'
import guidedGoalInterviewPrompt from '@oh-my-pi/pi-coding-agent/prompts/goals/guided-goal-interview' with { type: 'text' }
import { cfgGoalEnabled } from '@oh-my-pi/pi-coding-agent/goals/settings'
import { prompt } from '@oh-my-pi/pi-utils'

/** One command result line, on the engine's own notice channel. */
export type GuidedGoalOutput = (text: string) => void

/** The toolset before each conversation's interview, for a reader who never finishes it. */
const previousTools = new WeakMap<AgentSession, string[]>()

/** Whether this conversation's interview exposed the goal tool itself. */
const exposedGoalTool = new WeakMap<AgentSession, boolean>()

/** The toolset an abandoned interview restores. */
export function restoreAfterGuidedGoal(session: AgentSession): void {
  const previous = previousTools.get(session)
  previousTools.delete(session)
  if (previous === undefined) return
  if (exposedGoalTool.get(session) !== true) return
  exposedGoalTool.delete(session)
  void session.setActiveToolsByName(previous).catch(() => {
    // The interview was abandoned; a toolset that cannot be restored is not worth failing the
    // command that abandoned it over.
  })
}

/**
 * Starts the interview, or explains why it cannot start.
 *
 * The conflicts are the terminal command's: plan and vibe own the turn's prompt, and a goal that
 * exists (active or paused) is the one the reader has to finish or drop first.
 */
export async function startGuidedGoal(
  session: AgentSession,
  args: string,
  output: GuidedGoalOutput,
): Promise<boolean> {
  if (session.getPlanModeState()?.enabled === true) {
    output('Exit plan mode first.')
    return false
  }
  if (session.getVibeModeState()?.enabled === true) {
    output('Exit vibe mode first.')
    return false
  }
  if (!cfgGoalEnabled.get(session.settings)) {
    output('Goal mode is disabled. Enable it in settings (goal.enabled).')
    return false
  }
  const state = session.getGoalModeState()
  if (state?.enabled === true) {
    output('Goal mode is already active. Use /goal to manage it, or /goal drop to start over.')
    return false
  }
  if (state?.goal.status === 'paused') {
    output('Resume the current goal first, or drop it before setting a new objective.')
    return false
  }
  const enabled = session.getEnabledToolNames()
  previousTools.set(session, enabled)
  if (!enabled.includes('goal')) {
    exposedGoalTool.set(session, true)
    try {
      await session.setActiveToolsByName([...enabled, 'goal'])
    } catch (error) {
      previousTools.delete(session)
      exposedGoalTool.delete(session)
      output(error instanceof Error ? error.message : String(error))
      return false
    }
  }
  const initial = args.trim()
  const kickoff = prompt.render(guidedGoalInterviewPrompt, {
    initial: initial.length === 0 ? undefined : initial,
  })
  try {
    if (session.isStreaming) {
      // Queue behind the running turn rather than aborting it, as the terminal command does.
      await session.followUp(kickoff, undefined, { synthetic: true })
    } else {
      await session.prompt(kickoff, { synthetic: true })
    }
  } catch (error) {
    restoreAfterGuidedGoal(session)
    output(error instanceof Error ? error.message : String(error))
    return false
  }
  return true
}
