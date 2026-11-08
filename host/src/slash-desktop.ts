/**
 * The `/` commands this front-end carries because the engine only implements them for its terminal.
 *
 * The engine advertises a command to non-terminal clients only when it has a text-mode `handle`
 * (`slash-commands/available-commands.ts`: `if (!command.handle) continue`). Commands whose body
 * lives in the interactive UI - `/goal`, `/guided-goal`, `/vibe`, `/loop`, `/logout`, `/settings`,
 * `/plan`, `/queue` - therefore never reach the ACP list, which is why the desktop palette used to
 * show only the ACP half of the CLI's catalog.
 *
 * Goal mode is the one of those the engine also ships a non-terminal controller for:
 * `RpcGoalController` is what its own RPC host runs, and the durable lifecycle (create/resume/
 * pause/drop, accounting, transcript journaling, continuation) is the session's `goalRuntime`.
 * This module advertises `/goal` and dispatches it to that controller, so the desktop gets the
 * engine's behaviour rather than a second implementation of it.
 *
 * `/vibe` is the second one the desktop carries. The engine has the mode itself - the five worker
 * tools, the persistent worker sessions and their journal (`session.activateVibeTools`,
 * `VibeSessionRegistry`) - but only its terminal drives the mode, so the desktop runs that same
 * sequence in `vibe.ts` and this command turns it on and off, with the directive after the word
 * (`/vibe <prompt>`) handed back to the prompt path as the director's first turn.
 *
 * The remaining UI-only commands stay unadvertised until the desktop has the surface their body
 * needs (an OAuth provider picker, a plan-mode screen, a loop editor). Listing them here without
 * that surface would offer commands that cannot run.
 */

import type { RpcGoalResult } from '@oh-my-pi/pi-coding-agent/modes/rpc/rpc-goal'
import type { InternalAvailableSlashCommand } from '@oh-my-pi/pi-coding-agent/slash-commands/available-commands'

import type { SlashCommandOptions, SlashCommandRun } from './slash.ts'
import { servedCommandEntries } from './slash-catalog.ts'
import { askBtw, btwHistory, cancelBtw, clearBtw } from './btw.ts'
import { parseCleanseArgs, cleanseRunning, startCleanse } from './cleanse.ts'
import { dispatchTan } from './tan.ts'
import { restoreAfterGuidedGoal, startGuidedGoal } from './guided-goal.ts'
import { enableLoop, loopModeEnabled, noteLoopPrompt } from './loop-mode.ts'
import { enterPlanMode, exitPlanMode, planModeEnabled, reviewPlan } from './plan-mode.ts'
import { enterVibeMode, exitVibeMode, vibeModeEnabled } from './vibe.ts'

/** The subcommands the engine's `/goal` help lists (`builtin-modes.ts`). */
const GOAL_SUBCOMMANDS: Record<string, true> = {
  set: true,
  show: true,
  pause: true,
  resume: true,
  drop: true,
  budget: true,
}

/** One command that ran here and started no turn. */
const HANDLED: SlashCommandRun = { kind: 'handled', agentInvoked: false }

/** The last row of every `/goal` answer, so the spelling has one owner. */
const GOAL_USAGE = 'Usage: /goal <objective> | /goal show | pause | resume | drop | budget <N|off>'

/**
 * The desktop's own builtins, in the engine's advertisement shape.
 *
 * One row per command in `slash-catalog.ts`'s `SERVED` table, built from the engine's own registry
 * entry (`servedCommandEntries`), so an engine upgrade that changes a description, hint or
 * subcommand updates the palette with it, and a new TUI-only command cannot be served here yet
 * appear with hand-written words that drift.
 */
export const DESKTOP_COMMANDS: readonly InternalAvailableSlashCommand[] = servedCommandEntries()

/**
 * The engine's advertisement with the desktop's own builtins added.
 *
 * One name is one command: an engine entry that a desktop command shares a name with is the
 * engine's file/custom command for the same word, and the desktop's dispatcher runs first, so
 * leaving both would draw two rows of which only one can run. The desktop's entries sit after the
 * engine's builtins so the palette keeps the engine's grouping.
 */
export function withDesktopCommands(
  commands: readonly InternalAvailableSlashCommand[],
): InternalAvailableSlashCommand[] {
  const names = new Set(DESKTOP_COMMANDS.map((command) => command.name))
  const engine = commands.filter((command) => !names.has(command.name))
  const afterBuiltins = engine.findLastIndex((command) => command.source === 'builtin') + 1
  return [...engine.slice(0, afterBuiltins), ...DESKTOP_COMMANDS, ...engine.slice(afterBuiltins)]
}

/**
 * Runs a desktop-owned command, or answers `null` for everything the engine's own paths handle.
 *
 * Called before the engine's builtin dispatch: the engine answers `false` for a command it ships
 * only for the TUI, and the caller would then hand the literal text to `session.prompt()` as prose.
 */
export async function runDesktopCommand(
  options: SlashCommandOptions,
  text: string,
): Promise<SlashCommandRun | null> {
  const parsed = options.sdk.parseSlashCommand(text)
  if (parsed === null) return null
  if (parsed.name === 'vibe') return await runVibeCommand(options, parsed.args)
  if (parsed.name === 'plan') return await runPlanCommand(options, parsed.args)
  if (parsed.name === 'plan-review') return await runPlanReviewCommand(options)
  if (parsed.name === 'loop') return await runLoopCommand(options, parsed.args)
  if (parsed.name === 'guided-goal') return await runGuidedGoalCommand(options, parsed.args)
  if (parsed.name === 'cleanse') return runCleanseCommand(options, parsed.args)
  if (parsed.name === 'btw') return await runBtwCommand(options, parsed.args)
  if (parsed.name === 'tan') return await runTanCommand(options, parsed.args)
  if (parsed.name !== 'goal') return null
  try {
    return await runGoalCommand(options, parsed.args)
  } catch (error) {
    options.output(error instanceof Error ? error.message : String(error))
    return HANDLED
  }
}

/**
 * One `/plan` invocation.
 *
 * Two states, not the terminal's three: on turns it off (paused, the plan file kept), and off turns
 * it back on against the same file. The terminal's third "paused → off" step exists to clear the
 * mode entry without a plan; here that is what approving or dropping the plan does, and a reader
 * who wants a fresh plan can say so in their prompt.
 */
async function runPlanCommand(
  options: SlashCommandOptions,
  args: string,
): Promise<SlashCommandRun> {
  const session = options.session
  try {
    if (planModeEnabled(session)) {
      const confirmed = await options.ui
        .context()
        .confirm('Exit plan mode?', 'This exits plan mode without approving a plan.')
      if (confirmed !== true) return HANDLED
      await exitPlanMode(session, options.output)
      return HANDLED
    }
    if (!(await enterPlanMode(session, options.ui, options.output))) return HANDLED
    const directive = args.trim()
    if (directive.length === 0) return HANDLED
    if (!session.isStreaming) return { kind: 'prompt', text: directive }
    await session.prompt(directive, { streamingBehavior: 'steer' })
    return { kind: 'handled', agentInvoked: true }
  } catch (error) {
    options.output(error instanceof Error ? error.message : String(error))
    return HANDLED
  }
}

/**
 * One `/loop` invocation: toggle, then start the first iteration.
 *
 * The parse, the limit arithmetic and the condition are the engine's own (`loop-mode.ts`); this
 * handler only words the answer and hands an inline prompt back to the prompt path (or steers it
 * into a running turn, the way the every-other mode command does).
 */
async function runLoopCommand(options: SlashCommandOptions, args: string): Promise<SlashCommandRun> {
  const session = options.session
  const result = enableLoop(session, args)
  if (!result.ok) {
    options.output(result.error)
    return HANDLED
  }
  // No banner on either edge: the composer's loop chip and its panel are the reading, and a mode
  // turning on is not news the conversation column has to carry.
  const prompt = result.prompt?.trim()
  if (prompt === undefined || prompt.length === 0) return HANDLED
  if (session.isStreaming) {
    await session.prompt(prompt, { streamingBehavior: 'steer' })
    return { kind: 'handled', agentInvoked: true }
  }
  noteLoopPrompt(session, prompt)
  return { kind: 'prompt', text: prompt }
}

/**
 * One `/btw` invocation.
 *
 * A question starts a side conversation (the answer streams into the side panel, never into the
 * transcript). `cancel` ends a running one, `clear` drops the panel, and no argument lists the
 * topics the engine has checkpointed.
 */
async function runBtwCommand(options: SlashCommandOptions, args: string): Promise<SlashCommandRun> {
  const emit = (frame: Parameters<typeof options.emit>[0]): void => options.emit(frame)
  const word = args.trim()
  if (word === 'cancel') {
    if (!cancelBtw(options.session)) options.output('No side question is running.')
    return HANDLED
  }
  if (word === 'clear') {
    clearBtw(options.session, emit)
    return HANDLED
  }
  if (word.length === 0) {
    const topics = await btwHistory(options.session, emit)
    options.output(
      topics.length === 0
        ? 'No side questions yet. Ask one with /btw <question>.'
        : topics
            .map((topic, index) => `${index + 1}. [${topic.status}] ${topic.question}\n   ${topic.answer.trim() || '(no answer yet)'}`)
            .join('\n'),
    )
    return HANDLED
  }
  try {
    await askBtw(options.session, word, emit)
  } catch (error) {
    options.output(error instanceof Error ? error.message : String(error))
  }
  return HANDLED
}

/** One `/guided-goal`: the hidden interview kickoff, then the agent's own `goal create`. */
async function runGuidedGoalCommand(
  options: SlashCommandOptions,
  args: string,
): Promise<SlashCommandRun> {
  const started = await startGuidedGoal(options.session, args, options.output)
  return started ? { kind: 'handled', agentInvoked: true } : HANDLED
}

/**
 * One `/tan`: tangential work in a background fork of this conversation.
 *
 * Silent on dispatch: the engine's own background-dispatch message is the record, and the job's
 * result arrives in the conversation when it settles. Only a dispatch that could not start speaks.
 */
async function runTanCommand(options: SlashCommandOptions, args: string): Promise<SlashCommandRun> {
  try {
    await dispatchTan(options.session, args, options.mcpManager)
  } catch (error) {
    options.output(error instanceof Error ? error.message : String(error))
  }
  return HANDLED
}

/** One `/cleanse`: the engine's own run, in the background, reporting lines as they settle. */
function runCleanseCommand(options: SlashCommandOptions, args: string): SlashCommandRun {
  const parsed = parseCleanseArgs(args)
  if (typeof parsed === 'string') {
    options.output(parsed)
    return HANDLED
  }
  const started = startCleanse(options.session, parsed, options.output)
  if (!started.started) options.output(started.reason)
  return HANDLED
}

/** One `/plan-review`: the approval dialog for the plan this conversation is planning. */
async function runPlanReviewCommand(options: SlashCommandOptions): Promise<SlashCommandRun> {
  try {
    await reviewPlan(options.session, options.ui, options.output)
  } catch (error) {
    options.output(error instanceof Error ? error.message : String(error))
  }
  return HANDLED
}

/**
 * One `/vibe` invocation.
 *
 * Toggle-only, which is the terminal command's behaviour: with the mode already on, the word turns
 * it off and any argument is dropped. On entry, a directive after the word is the director's first
 * prompt: handed back to the prompt path when the conversation is idle, and steered into the turn
 * that is already running - the same delivery the terminal command chooses, and the reason the
 * directive never races the mode's own context steer.
 */
async function runVibeCommand(
  options: SlashCommandOptions,
  args: string,
): Promise<SlashCommandRun> {
  const session = options.session
  try {
    if (vibeModeEnabled(session)) {
      await exitVibeMode(session, options.output)
      return HANDLED
    }
    if (!(await enterVibeMode(session, options.output))) return HANDLED
    const directive = args.trim()
    if (directive.length === 0) return HANDLED
    if (!session.isStreaming) return { kind: 'prompt', text: directive }
    await session.prompt(directive, { streamingBehavior: 'steer' })
    return { kind: 'handled', agentInvoked: true }
  } catch (error) {
    // A failed teardown leaves the mode as the engine found it; the message is the engine's.
    options.output(error instanceof Error ? error.message : String(error))
    return HANDLED
  }
}

/** One `/goal` invocation, in the order the engine's terminal command uses. */
async function runGoalCommand(
  options: SlashCommandOptions,
  args: string,
): Promise<SlashCommandRun> {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args)
  const word = match?.[1]?.toLowerCase()
  const rest = (match?.[2] ?? '').trim()
  const state = (await options.goal.handle({ op: 'get' })).state

  if (word !== undefined && GOAL_SUBCOMMANDS[word] === true) {
    return await runGoalSubcommand(options, word, rest, state)
  }
  return await startGoal(options, args.trim(), state)
}

async function runGoalSubcommand(
  options: SlashCommandOptions,
  subcommand: string,
  rest: string,
  state: RpcGoalResult['state'],
): Promise<SlashCommandRun> {
  switch (subcommand) {
    case 'show':
      options.output(describeGoal(state))
      return HANDLED
    case 'set':
      if (rest.length === 0) {
        options.output('Usage: /goal set <objective>')
        return HANDLED
      }
      return await startGoal(options, rest, state)
    case 'pause': {
      if (state === null || !state.enabled) {
        options.output('No active goal to pause.')
        return HANDLED
      }
      await options.goal.handle({ op: 'pause' })
      // Silent: the goal panel is the status line for this mode.
      return HANDLED
    }
    case 'resume': {
      if (state?.goal.status !== 'paused') {
        options.output('No paused goal to resume.')
        return HANDLED
      }
      await options.goal.handle({ op: 'resume' })
      // Silent: the goal panel is the status line for this mode.
      return HANDLED
    }
    case 'drop': {
      if (state === null) {
        options.output('No goal to drop.')
        return HANDLED
      }
      await options.goal.handle({ op: 'drop' })
      // A guided-goal interview exposed the goal tool before any goal existed; abandoning it puts
      // the pre-interview toolset back rather than leaving the tool on for nothing.
      restoreAfterGuidedGoal(options.session)
      return HANDLED
    }
    case 'budget':
      return setGoalBudget(options, rest, state)
    default:
      return HANDLED
  }
}

/**
 * Starts or replaces a goal from an objective, then sends the objective as the first turn.
 *
 * Both halves are the engine terminal command's behaviour (`interactive-mode.ts`
 * `#startGoalFromObjective` / `#replaceGoalFromObjective`): an active goal is replaced, a paused
 * one has to be dropped or resumed first, and the objective itself is the prompt that starts the
 * work.
 */
async function startGoal(
  options: SlashCommandOptions,
  objective: string,
  state: RpcGoalResult['state'],
): Promise<SlashCommandRun> {
  // The engine refuses the opposite direction for the same reason (`interactive-mode.ts`
  // `#enterGoalMode`): both modes rewrite the active toolset, so one has to be left first.
  if (vibeModeEnabled(options.session)) {
    options.output('Exit vibe mode first.')
    return HANDLED
  }
  let target = objective
  if (target.length === 0) {
    if (state !== null) {
      options.output(`${describeGoal(state)}\n\n${GOAL_USAGE}`)
      return HANDLED
    }
    // The terminal command opens an editor for the objective; this is the desktop's own box over
    // the column, asked on the engine's editor wire so the reader answers it where dialogs live.
    const answer = await options.ui.requestText(
      'Goal mode',
      'What should the agent pursue? State the outcome, how it is verified, and when to stop.',
      'Describe the objective, success criteria and stop conditions...',
    )
    target = answer?.trim() ?? ''
    if (target.length === 0) return HANDLED
  }
  if (state?.enabled === true) {
    const replaced = await options.session.goalRuntime.replaceGoal({ objective: target })
    options.session.setGoalModeState(replaced)
    // A running turn gets the new objective's context as a steer before the objective itself, as
    // the engine's terminal command does; an idle turn receives it from the prompt path.
    if (options.session.isStreaming) await options.session.sendGoalModeContext({ deliverAs: 'steer' })
    // Silent: the goal panel shows the new objective.
  } else if (state?.goal.status === 'paused') {
    options.output('Resume the current goal first, or drop it before setting a new objective.')
    return HANDLED
  } else {
    await options.goal.handle({ op: 'create', objective: target })
    // Silent: the goal panel carries the objective and its accounting.
  }
  return await sendObjective(options, target)
}

/**
 * Sends the objective that just became the goal.
 *
 * A running turn takes it as a steer, exactly as the terminal command does; an idle session gets
 * it through the prompt path (`{ kind: 'prompt' }`), which is also the path that carries the
 * caller's acknowledgement and the turn's own result.
 */
async function sendObjective(
  options: SlashCommandOptions,
  objective: string,
): Promise<SlashCommandRun> {
  if (!options.session.isStreaming) return { kind: 'prompt', text: objective }
  await options.session.prompt(objective, { streamingBehavior: 'steer' })
  return { kind: 'handled', agentInvoked: true }
}

/** `/goal budget <positive integer|off>` on the engine runtime, as the terminal command does. */
async function setGoalBudget(
  options: SlashCommandOptions,
  rest: string,
  state: RpcGoalResult['state'],
): Promise<SlashCommandRun> {
  if (state === null || !state.enabled) {
    options.output('No active goal.')
    return HANDLED
  }
  if (state.goal.status === 'complete') {
    options.output('Goal is already complete.')
    return HANDLED
  }
  const value = rest.trim().toLowerCase()
  let budget: number | undefined
  if (value !== 'off') {
    const parsed = Number.parseInt(value, 10)
    if (!Number.isInteger(parsed) || parsed <= 0) {
      options.output('Goal budget must be a positive integer or `off`.')
      return HANDLED
    }
    budget = parsed
  }
  await options.session.goalRuntime.onBudgetMutated(budget)
  // Silent: the budget is a field in the goal panel.
  return HANDLED
}

/** The goal panel a status line shows, in the words the engine's own `/goal show` uses. */
function describeGoal(state: RpcGoalResult['state'] | undefined): string {
  if (state === null || state === undefined) return 'No goal set.'
  const goal = state.goal
  const budget =
    goal.tokenBudget === undefined
      ? `${goal.tokensUsed.toLocaleString()} (no budget)`
      : `${goal.tokensUsed.toLocaleString()} / ${goal.tokenBudget.toLocaleString()}`
  return [
    `Objective: ${goal.objective}`,
    `Status: ${goal.status}${state.enabled ? '' : ' (paused)'}`,
    `Tokens: ${budget}`,
    `Time spent: ${formatSeconds(goal.timeUsedSeconds)}`,
  ].join('\n')
}

function formatSeconds(total: number): string {
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${total % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
