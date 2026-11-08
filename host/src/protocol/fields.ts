/**
 * Field shapes every inbound command shares.
 *
 * The registry and the commands split out of it (`session-reads.ts`, `session-files.ts`) each read
 * the same handful of request fields, and a second copy of "a string, required or not" is how two
 * commands start disagreeing about what an empty one means. Anything in a request that cannot be
 * stringified is a protocol violation, not a value.
 */

import { invalidInput } from './errors.ts'

/** A request field that has to be a non-empty string when it is required, and may be absent. */
export function text(value: unknown, field: string, required: boolean): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw invalidInput(`${field} is required.`)
    return undefined
  }
  if (typeof value !== 'string' || (required && value === '')) {
    throw invalidInput(`${field} must be a non-empty string.`)
  }
  return value
}
