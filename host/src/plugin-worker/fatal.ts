/**
 * The one refusal a plugin worker writes before it leaves.
 *
 * `worker_fatal` is the worker's startup answer (plan §6.2): the entry was missing, did not parse,
 * exported no `onLoad`, or `onLoad` threw. It goes out as exactly one NDJSON line on stdout - the
 * same channel the rest of the protocol uses - and the process then exits with a code distinct
 * from the host's own startup refusals, so a support case can tell a plugin from an application.
 *
 * Written with `fs.writeSync` on purpose: this runs on paths where the worker loop has not started
 * (bad argv, entry resolution), so there is no queue to flush and no reader that could be awaiting
 * a frame. The message is the host's redactor's business like every other diagnostic: no stack, no
 * paths ([`sanitizeMessage`]).
 */

import * as fs from 'node:fs'

import { sanitizeMessage } from '../log.ts'

/**
 * The exit code a worker leaves with when it refused to start.
 *
 * Distinct from the host's own codes: `2` is a `host_fatal`, `3` a protocol mismatch (the launcher
 * sets it) and `4` a lost stdout. Rust folds any non-zero worker exit into `crashed`; the number is
 * for the log, not for a second state machine.
 */
export const WORKER_EXIT_FATAL = 5

/** The exit code a worker leaves with when its stdout can no longer be written. */
export const WORKER_EXIT_WRITE_FAILED = 6

/** One `worker_fatal` line, then the process ends. */
export function workerFatal(code: string, message: string): never {
  fs.writeSync(1, `${JSON.stringify({ type: 'worker_fatal', code, message: sanitizeMessage(message) })}\n`)
  process.exit(WORKER_EXIT_FATAL)
}
