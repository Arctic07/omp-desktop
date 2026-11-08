/**
 * The worker protocol's frame codec: one NDJSON line per frame, bounded by the host's own ceiling.
 *
 * The worker speaks a *second* protocol from the host's (plan §6.2): its stdin/stdout carry
 * `worker_*` frames to and from the Rust supervisor, and none of the host's `rpc_chunk` splitting
 * applies. A frame that does not fit {@link MAX_FRAME_BYTES} is refused (`invalid_input`) rather
 * than chunked, because the supervisor's reader is a line reader and a chunk run would be a frame
 * vocabulary the two halves have not agreed on.
 *
 * The line scanner is the host's own (`protocol/frames.ts`), reused rather than forked: it already
 * enforces the physical ceiling, reports an overflow once and then re-syncs on the next newline, and
 * carries the head/tail probe that lets an oversized request id be recovered.
 */

import { Buffer } from 'node:buffer'

import { MAX_FRAME_BYTES, PLUGIN_WORKER_LOG_CHARS_MAX } from '../constants.ts'

/** The log levels `worker_log` carries, closed like the bridge's own `level` set. */
export const WORKER_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type WorkerLogLevel = (typeof WORKER_LOG_LEVELS)[number]

/** One decoded frame: a JSON object with a string `type`. */
export type WorkerFrame = Record<string, unknown> & { readonly type: string }

/** UTF-8 bytes one frame will occupy on the wire, newline included. */
export function workerFrameBytes(line: string): number {
  return Buffer.byteLength(line, 'utf8') + 1
}

/**
 * Serializes one frame, or answers `null` when it cannot go out as one line.
 *
 * `null` covers both a value that is not serializable (a handler returned something circular) and
 * one over the ceiling. The caller turns either into the frame's refusal - a result substitutes
 * `invalid_input`, an invoke is rejected locally before anything is sent - so a value the protocol
 * cannot carry never silently becomes a different frame.
 */
export function encodeWorkerFrame(frame: Record<string, unknown>): string | null {
  let line: string
  try {
    line = JSON.stringify(frame)
  } catch {
    return null
  }
  return workerFrameBytes(line) > MAX_FRAME_BYTES ? null : line
}

/** Parses one inbound line into a frame, or `null` when it is not one this protocol reads. */
export function parseWorkerFrame(text: string): WorkerFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const frame = parsed as Record<string, unknown>
  return typeof frame.type === 'string' ? (frame as WorkerFrame) : null
}

/**
 * Control characters replaced, the way the bridge's `log` treats a line: a control character would
 * split one log record into several, or reach a terminal as an escape sequence, and neither is a
 * thing a plugin's message should be able to do. Everything else is kept, then the line is bounded.
 */
export function cleanWorkerLogMessage(message: string): string {
  const cleaned = message.replace(/\p{Cc}/gu, ' ').trim()
  const points = [...cleaned]
  return points.length > PLUGIN_WORKER_LOG_CHARS_MAX ? points.slice(0, PLUGIN_WORKER_LOG_CHARS_MAX).join('') : cleaned
}

/** One `worker_log` frame, from an already-clean message. */
export function workerLogFrame(level: WorkerLogLevel, message: string): Record<string, unknown> {
  return { type: 'worker_log', level, message: cleanWorkerLogMessage(message) }
}

/** The fields a `worker_result` / `worker_invoke_result` may carry. */
export interface WorkerSettlement {
  readonly ok: boolean
  readonly value?: unknown
  readonly code?: string
  readonly message?: string
}

/** One answer frame for a request `id`, carrying only the fields the settlement names. */
export function settlementFrame(type: 'worker_result' | 'worker_invoke_result', id: string, settlement: WorkerSettlement): Record<string, unknown> {
  const frame: Record<string, unknown> = { type, id, ok: settlement.ok }
  if (settlement.ok && settlement.value !== undefined) frame.value = settlement.value
  if (!settlement.ok && settlement.code !== undefined) frame.code = settlement.code
  if (!settlement.ok && settlement.message !== undefined) frame.message = settlement.message
  return frame
}

/** A request `id` this protocol can echo: a bounded token with no control characters. */
export function workerFrameId(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return null
  return /\p{Cc}/u.test(value) ? null : value
}
