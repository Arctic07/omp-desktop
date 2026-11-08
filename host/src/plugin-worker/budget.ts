/**
 * The two budgets every plugin invoke passes: at most 64 unanswered and at most 200 per rolling
 * second (plan §6.3).
 *
 * Both are process-local and both are bounded by construction - the pending count by
 * `PLUGIN_WORKER_MAX_PENDING_INVOKES`, the window by `PLUGIN_WORKER_INVOKES_PER_SECOND` timestamps -
 * so neither is a container that can grow without a release point. A pending invoke leaves the
 * count when `worker_invoke_result` arrives; a timestamp leaves the window when it is older than
 * `PLUGIN_WORKER_INVOKE_WINDOW_MS`. A worker that dies takes both with it.
 *
 * The limits are the *plugin's* outbound pace, not the host's: the plugin is the untrusted side,
 * and the two refusals are the same code (`too_many_requests`) because both say the same thing to
 * its author - the worker is not going to carry this many right now.
 */

import {
  PLUGIN_WORKER_INVOKES_PER_SECOND,
  PLUGIN_WORKER_INVOKE_WINDOW_MS,
  PLUGIN_WORKER_MAX_PENDING_INVOKES,
} from '../constants.ts'

/** What one `take` decided: accepted, or the refusal the invoke is answered with. */
export type BudgetAnswer =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'too_many_requests'; readonly message: string }

const ACCEPTED: BudgetAnswer = { ok: true }

/** The pending/rate pair for one worker process. */
export class InvokeBudget {
  #pending = 0
  /** Accept times inside the current window, oldest first; at most the per-second ceiling. */
  #accepted: number[] = []

  /** How many invokes are waiting for their `worker_invoke_result`. */
  get pending(): number {
    return this.#pending
  }

  /** How many invokes were accepted inside the window ending at `now`. */
  used(now: number = Date.now()): number {
    this.#prune(now)
    return this.#accepted.length
  }

  /** Takes one invoke, or answers why it cannot go out. */
  take(now: number = Date.now()): BudgetAnswer {
    if (this.#pending >= PLUGIN_WORKER_MAX_PENDING_INVOKES) {
      return {
        ok: false,
        code: 'too_many_requests',
        message: `This plugin has ${PLUGIN_WORKER_MAX_PENDING_INVOKES} calls waiting for an answer.`,
      }
    }
    this.#prune(now)
    if (this.#accepted.length >= PLUGIN_WORKER_INVOKES_PER_SECOND) {
      return {
        ok: false,
        code: 'too_many_requests',
        message: `This plugin made more than ${PLUGIN_WORKER_INVOKES_PER_SECOND} calls in a second.`,
      }
    }
    this.#accepted.push(now)
    this.#pending += 1
    return ACCEPTED
  }

  /** One invoke answered (or abandoned): the pending slot comes back, the window entry stays. */
  release(): void {
    if (this.#pending > 0) this.#pending -= 1
  }

  /** Forgets the timestamps that fell out of the rolling window. */
  #prune(now: number): void {
    const cutoff = now - PLUGIN_WORKER_INVOKE_WINDOW_MS
    let drop = 0
    while (drop < this.#accepted.length && (this.#accepted[drop] as number) <= cutoff) drop += 1
    if (drop > 0) this.#accepted.splice(0, drop)
  }
}
