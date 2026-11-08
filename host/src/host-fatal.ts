/**
 * The one startup refusal the host writes on stdout: `host_fatal`.
 *
 * Its own module so both entry paths can name it without loading the other: `main.ts` writes it for
 * a failure that happened before the ordinary run was even imported, and `host-run.ts` writes it
 * for every pinned/engine failure. The line is the launcher's contract (contract §2.8): one JSON
 * object, redacted, then exit `2`.
 */

import * as fs from 'node:fs'

import { sanitizeMessage } from './log.ts'
import { ERROR_CODES, type ErrorCode } from './protocol/errors.ts'

/** Emits `host_fatal` on stdout, which is where the launcher reads startup refusals from. */
export function fatal(code: ErrorCode, detail: string): never {
  fs.writeSync(1, `${JSON.stringify({ type: 'host_fatal', code, detail: sanitizeMessage(detail) })}\n`)
  process.exit(2)
}

/** The exit code a host leaves with when it cannot even be entered (`host_failed`). */
export function fatalHostFailure(error: unknown): never {
  fatal(ERROR_CODES.host_failed, error instanceof Error ? error.message : String(error))
}
