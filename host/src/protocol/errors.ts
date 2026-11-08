/**
 * Stable error codes (contract §2.8).
 *
 * The code is part of the wire contract: the Rust host maps it to a user-visible message, so a
 * failure is never reported as free text alone.
 *
 * `host_failed` is a lifecycle code - the launcher folds it into the host's own failure state,
 * because the process is leaving.
 */

export const ERROR_CODES = {
  host_not_ready: 'host_not_ready',
  session_not_found: 'session_not_found',
  session_busy: 'session_busy',
  /**
   * `session_branch` refused before it rewrote anything.
   *
   * The engine's branch emits a cancellable `session_before_branch` event, so an installed hook
   * (the engine's own `git-checkpoint` example is one) can decline it. Nothing was written in that
   * case, which is why it is an answer rather than a half-applied branch.
   */
  branch_cancelled: 'branch_cancelled',
  stale_cursor: 'stale_cursor',
  invalid_session_path: 'invalid_session_path',
  invalid_input: 'invalid_input',
  protocol_mismatch: 'protocol_mismatch',
  env_pin_failed: 'env_pin_failed',
  host_failed: 'host_failed',
  timeout: 'timeout',
  /**
   * Plugin commands (`plugins_*`, `marketplaces_*`).
   *
   * The four codes below are the host's own classification of what the engine said: the engine
   * reports a missing plugin, a malformed spec and a failed install as one `Error` shape, and the
   * desktop branches on the difference (a stale row is not an offline npm registry). `not found`
   * and `invalid spec` are answers about the request, so they are separate from the install
   * failure that means "the request was fine and the work did not finish".
   */
  plugin_not_found: 'plugin_not_found',
  plugin_invalid_spec: 'plugin_invalid_spec',
  plugin_install_failed: 'plugin_install_failed',
  /**
   * The work never ran: this machine cannot perform it (spec §15.1-6).
   *
   * The engine's install paths spawn external tools - `bun` for npm installs, `git` for a
   * marketplace clone, the filesystem's symlink permission for a link - and when one of them is
   * missing or refuses, the honest answer is about the environment, not about the plugin. The
   * message names what is missing (`bun`, `git`, or the link permission) in a redacted sentence;
   * the page renders it as "this machine cannot install plugins", which is a different action for
   * the user than "this plugin failed to install".
   */
  plugin_install_unavailable: 'plugin_install_unavailable',
  /**
   * A write the engine cannot honour in the scope it was asked for.
   *
   * npm and link installs live in the user plugin root only (`PluginManager` has one directory),
   * so `scope: "project"` has nowhere to land; saying so is the only honest answer.
   */
  plugin_scope_mismatch: 'plugin_scope_mismatch',
  /**
   * The consent gate (contract §2.2). Reserved for the Rust slice: the host registers the code so
   * both sides share one vocabulary, and never raises it itself - the gate is enforced where the
   * grant table lives, before a plugin's code is enabled.
   */
  plugin_permission_required: 'plugin_permission_required',
  /**
   * The global rules file (`<agentDir>/RULES.md`) is over the size this host will carry.
   *
   * An answer rather than a truncation: the engine puts the whole body into every request, and a
   * body cut at an arbitrary byte reads like a rule set that says less than the user wrote - the
   * page would then save that shortened version back over the real one. The message names the
   * path, the measured size and the ceiling (`RULES_CONTENT_MAX_BYTES`), and the page sends the
   * user to an external editor, which is the one place a file this large is still editable.
   */
  rules_too_large: 'rules_too_large',
  /**
   * A model call this process started did not produce an answer: no model resolved, no key for the
   * one that did, or the provider refused it.
   *
   * It is one code because the plugin's action is the same for all three - the machine is not set
   * up to complete anything - and the engine's own sentence travels in the message, which is where
   * the difference between "no key" and "the selector matched nothing" is readable.
   */
  engine_request_failed: 'engine_request_failed',
  /**
   * A ceiling this process enforces is spent for the caller: the sockets one installation may hold.
   *
   * The rate and concurrency budgets of `agent.complete` are the desktop's (`services::plugins::
   * agent_budget`) and are refused there; this code covers the one ceiling that lives beside the
   * socket table itself.
   */
  host_busy: 'host_busy',
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

/** A command failure carrying the stable code the wire response must publish. */
export class HostError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'HostError'
    this.code = code
  }
}

/** Shorthand for the most common failure: a request whose fields cannot be used. */
export function invalidInput(message: string): HostError {
  return new HostError(ERROR_CODES.invalid_input, message)
}
