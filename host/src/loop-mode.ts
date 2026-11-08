/**
 * Loop mode: the body of the engine's terminal-only `/loop`, run by this host.
 *
 * The terminal keeps the loop in its own input controller: the next prompt becomes the loop prompt,
 * and after every yield it re-submits that prompt until a limit or a shell condition says stop. The
 * parsing, the limit arithmetic and the condition evaluation are the engine's own modules
 * (`modes/loop-limit`, `modes/loop-condition`) — this file only owns the part the terminal's input
 * controller owned: which prompt is repeating, and when the next iteration is due.
 *
 * A turn ending is the host's event to act on (`agent_end` with `isTerminal !== false`); a stop
 * pauses the loop instead of dropping it, which is the terminal's Esc.
 */

import type { AgentSession } from '@oh-my-pi/pi-coding-agent'
import {
  consumeLoopLimitIteration,
  createLoopLimitRuntime,
  describeLoopLimitRuntime,
  isLoopDurationExpired,
  isLoopLimitExhausted,
  parseLoopArgs,
  type ParsedLoopArgs,
} from '@oh-my-pi/pi-coding-agent/modes/loop-limit'
import {
  describeLoopCondition,
  evaluateLoopCondition,
  type LoopConditionVerdict,
} from '@oh-my-pi/pi-coding-agent/modes/loop-condition'
import { cfgLoopConditionTimeoutMs } from '@oh-my-pi/pi-coding-agent/modes/settings'

/** The condition one `/loop` carries, as its own parser typed it. */
type LoopCondition = NonNullable<ParsedLoopArgs['condition']>

/** One conversation's loop, as the mode strip and the driver read it. */
class LoopState {
  enabled = false
  paused = false
  /** The prompt that repeats, once one has been submitted (or given inline). */
  prompt: string | undefined = undefined
  parsed: ParsedLoopArgs | undefined = undefined
  /** The engine's own iteration/deadline arithmetic, created fresh on every entry. */
  #limit = createLoopLimitRuntime(undefined)
  #running = false
  /** The condition evaluation in flight, if any (see {@link evaluate}). */
  #conditionAbort: AbortController | undefined

  reset(parsed: ParsedLoopArgs | undefined): void {
    this.abortCondition()
    this.enabled = true
    this.paused = false
    this.prompt = parsed?.prompt
    this.parsed = parsed
    this.#limit = createLoopLimitRuntime(parsed?.limit)
  }

  get limit() {
    return this.#limit
  }

  /** One iteration's budget, consumed when the loop decides to run it. */
  takeIteration(): boolean {
    return consumeLoopLimitIteration(this.#limit)
  }

  exhausted(): boolean {
    return isLoopLimitExhausted(this.#limit)
  }

  /**
   * One condition evaluation, aborted when the mode ends under it.
   *
   * The command is a child process with its own deadline (`loop.conditionTimeoutMs`, the terminal's
   * setting); a prior evaluation is dropped rather than left running, which is what would leak a
   * process nothing could reach once the loop was paused or a second evaluation started.
   */
  async evaluate(condition: LoopCondition, session: AgentSession): Promise<LoopConditionVerdict> {
    this.abortCondition()
    const controller = new AbortController()
    this.#conditionAbort = controller
    try {
      return await evaluateLoopCondition(condition, {
        cwd: session.sessionManager.getCwd(),
        timeoutMs: cfgLoopConditionTimeoutMs.get(session.settings),
        signal: controller.signal,
        sessionId: session.sessionManager.getSessionId(),
      })
    } finally {
      if (this.#conditionAbort === controller) this.#conditionAbort = undefined
    }
  }

  abortCondition(): void {
    this.#conditionAbort?.abort()
    this.#conditionAbort = undefined
  }

  get running(): boolean {
    return this.#running
  }

  set running(value: boolean) {
    this.#running = value
  }
}

const loops = new WeakMap<AgentSession, LoopState>()

function stateOf(session: AgentSession): LoopState {
  let state = loops.get(session)
  if (state === undefined) {
    state = new LoopState()
    loops.set(session, state)
  }
  return state
}

/** Whether this conversation is looping, as the strip draws it. */
export function loopModeEnabled(session: AgentSession): boolean {
  return stateOf(session).enabled
}

/** The loop's state, as the modes object publishes it. */
export function loopModeView(session: AgentSession): {
  readonly enabled: boolean
  readonly paused: boolean
  readonly prompt?: string
  readonly limit?: string
  readonly condition?: string
} {
  const state = stateOf(session)
  if (!state.enabled) return { enabled: false, paused: state.paused }
  return {
    enabled: true,
    paused: state.paused,
    prompt: state.prompt,
    limit: state.limit === undefined ? undefined : describeLoopLimitRuntime(state.limit),
    condition:
      state.parsed?.condition === undefined ? undefined : describeLoopCondition(state.parsed.condition),
  }
}

/**
 * `/loop [count|duration] [--while|--until '<cmd>'] [prompt]`.
 *
 * Answers the prompt the caller should submit (the inline one), or an error line. `undefined` with
 * no error means the mode is waiting for the reader's next prompt.
 */
export function enableLoop(
  session: AgentSession,
  args: string,
): { readonly ok: true; readonly prompt?: string } | { readonly ok: false; readonly error: string } {
  const state = stateOf(session)
  if (state.enabled) {
    state.enabled = false
    state.paused = false
    state.prompt = undefined
    state.parsed = undefined
    return { ok: true }
  }
  const parsed = parseLoopArgs(args)
  if (typeof parsed === 'string') return { ok: false, error: parsed }
  state.reset(parsed)
  return { ok: true, prompt: parsed.prompt }
}

/** Stops the loop. The line the reader gets is the caller's, where it has one. */
export function disableLoop(session: AgentSession): void {
  const state = stateOf(session)
  state.abortCondition()
  state.enabled = false
  state.paused = false
  state.prompt = undefined
  state.parsed = undefined
}

/** Suspends the loop until the reader turns it back on, which is the terminal's Esc. */
export function pauseLoop(session: AgentSession): void {
  const state = stateOf(session)
  if (!state.enabled) return
  state.paused = true
}

/**
 * Records the prompt that will repeat.
 *
 * The first prompt submitted after `/loop` (or the inline one) is the loop's text: the terminal's
 * input controller captured it the same way, and an empty loop has nothing to repeat.
 */
export function noteLoopPrompt(session: AgentSession, text: string): void {
  const state = stateOf(session)
  if (!state.enabled || state.paused) return
  if (state.prompt !== undefined) return
  const trimmed = text.trim()
  if (trimmed.length === 0) return
  state.prompt = trimmed
}

/**
 * The next iteration, if this yield earns one.
 *
 * Called once per settled turn. Every branch that ends the loop reports why through `output` — a
 * loop that stopped silently would read as a stall.
 *
 * The order of the gates is the terminal's own (`interactive-mode.ts`, `#loopIteration`): an
 * exhausted budget first, because a loop out of iterations must not run the condition one last time
 * for nothing; then the shell condition, which is an await point and may halt the loop — a halt must
 * not spend an iteration that never ran; then the budget is consumed and the prompt goes out. The
 * busy re-check after the condition is the terminal's too: the command can take seconds, and a turn
 * that started meanwhile (a steered message, a background wake) would turn this submission into a
 * second prompt on a session that is already answering.
 */
export async function continueLoop(
  session: AgentSession,
  output: (text: string) => void,
): Promise<void> {
  const state = stateOf(session)
  if (!state.enabled || state.paused || state.prompt === undefined) return
  if (state.running) return
  // A submission into a session that is already answering is a second turn, not the next iteration.
  // The three are the terminal's own busy reading (`#isAutoSubmitBlocked`); the next settled turn
  // calls this again.
  if (session.isStreaming || session.isCompacting || session.hasPostPromptWork) return
  if (state.exhausted()) {
    disableLoop(session)
    output('Loop mode finished its budget. Loop mode disabled.')
    return
  }
  const condition = state.parsed?.condition
  if (condition !== undefined) {
    const verdict = await state.evaluate(condition, session)
    // The condition is an await point: a stop or a second `/loop` may have landed meanwhile.
    if (!state.enabled || state.paused) return
    if (verdict.kind === 'halt' || verdict.kind === 'error') {
      disableLoop(session)
      output(verdict.message)
      return
    }
    if (verdict.kind === 'aborted') return
    if (session.isStreaming || session.isCompacting || session.hasPostPromptWork) return
  }
  if (!state.takeIteration()) {
    disableLoop(session)
    output('Loop mode finished its budget. Loop mode disabled.')
    return
  }
  // The condition and the budget check are both reads of a clock: a slow command can cross the
  // loop's own deadline in between, which the terminal answers with its own line rather than one
  // more turn.
  if (isLoopDurationExpired(state.limit)) {
    disableLoop(session)
    output('Loop mode finished its deadline. Loop mode disabled.')
    return
  }
  const prompt = state.prompt
  // Submit without waiting for the turn: the next iteration is decided by that turn's own ending,
  // which arrives as the next `agent_end`. Waiting here would hold the flag until the turn settled
  // and the ending it needs would be dropped as a re-entry.
  state.running = true
  void session.prompt(prompt, { synthetic: true }).catch((error: unknown) => {
    // A loop that cannot submit again is over: the reader gets the engine's words, not a silent
    // stall that looks like work.
    disableLoop(session)
    output(`Loop mode stopped: ${error instanceof Error ? error.message : String(error)}`)
  })
  // The guard is only against this one ending deciding twice; it is cleared before the turn it
  // just submitted can end.
  queueMicrotask(() => {
    state.running = false
  })
}
