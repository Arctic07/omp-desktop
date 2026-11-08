/**
 * The checks and bounds every capability command shares.
 *
 * Skills, MCP, memory and usage all take the same three kinds of caller input - a working
 * directory, a value from a frozen vocabulary, and a bounded row set - and all have to answer with
 * bounded payloads. Doing that in one place is what keeps four commands from growing four
 * slightly different definitions of "a path I will accept" (contract §1.4).
 *
 * Nothing here reaches the engine: these are pure shape and size rules, and the engine's own
 * answers stay the single source of truth for what a capability actually contains.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { CAPABILITY_CWD_MAX } from './constants.ts'
import type { HostPaths } from './env.ts'
import { invalidInput } from './protocol/errors.ts'

/** Sentinel {@link withTimeout} answers with when the work outlived its budget. */
export const TIMED_OUT = Symbol('timed-out')

/** True when `candidate` is `root` itself or lies underneath it. */
export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** A required string field, refused when it is not a string, is empty, or is too long. */
export function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalidInput(`${field} must be a non-empty string.`)
  if (value.length > max) throw invalidInput(`${field} must be at most ${max} characters.`)
  return value
}

/** A required boolean field. A truthy string is not a boolean, and is refused. */
export function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw invalidInput(`${field} must be a boolean.`)
  return value
}

/**
 * The target id of a skill write: `targetId`, else the older `id` spelling.
 *
 * Contract §2.3 named that field `id`, which collides with the response-correlation `id` every
 * request envelope carries: the desktop's Rust host writes its own value into that key before a
 * frame is encoded (`src-tauri/src/services/runtime/host/ops.rs`, `call_inner`), so a target sent as
 * `id` is *overwritten* on the way - the write would address whatever the counter spelled instead
 * (contract §2.3, ruling C14). `id` is still accepted as the fallback because a caller written
 * against the literal text keeps working, and the unambiguous field wins when both are present (see
 * `findings/FINDING-w1-host.md`).
 *
 * A frame added after that ruling reads `targetId` alone and refuses a frame without it: the plugin
 * commands do exactly that (`plugins.ts`), because no legacy caller depends on the fallback and one
 * would silently address the correlation key the call path just wrote.
 */
export function targetIdField(frame: Record<string, unknown>): unknown {
  return frame.targetId ?? frame.id
}

/** A boolean flag the caller may omit, defaulting to `false`. */
export function booleanOr(value: unknown, field: string): boolean {
  if (value === undefined || value === null) return false
  return requireBoolean(value, field)
}

/** One value of a frozen vocabulary, refused when it is not a member. */
export function enumField<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string') throw invalidInput(`${field} must be one of: ${allowed.join(', ')}.`)
  const match = allowed.find(entry => entry === value)
  if (match === undefined) throw invalidInput(`${field} must be one of: ${allowed.join(', ')}.`)
  return match
}

/**
 * The working directory a capability command addresses.
 *
 * A caller that omits `cwd` means "the workspace this host runs in", which is what
 * `paths.defaultWorkspace` is for. A caller that supplies one has to name an absolute, existing
 * directory: the engine resolves skills and MCP configs relative to it, so a relative or
 * non-existent path would quietly produce a *different* answer than the caller asked for.
 *
 * The answer is the resolved path, so every payload and every write addresses one spelling of it.
 */
export function resolveCwd(paths: HostPaths, requested: unknown): string {
  if (requested === undefined || requested === null) return resolveDirectory(paths.defaultWorkspace)
  const raw = requireText(requested, 'cwd', CAPABILITY_CWD_MAX)
  if (raw.includes('\n') || raw.includes('\r')) throw invalidInput('cwd must be a single path.')
  if (!path.isAbsolute(raw)) throw invalidInput('cwd must be an absolute path.')
  return resolveDirectory(raw)
}

/** The real path of an existing directory, or `invalid_input` naming what was wrong. */
function resolveDirectory(target: string): string {
  let real: string
  try {
    real = fs.realpathSync.native(target)
  } catch {
    throw invalidInput('cwd does not exist.')
  }
  let isDirectory: boolean
  try {
    isDirectory = fs.statSync(real).isDirectory()
  } catch {
    throw invalidInput('cwd cannot be read.')
  }
  if (!isDirectory) throw invalidInput('cwd must be a directory.')
  return real
}

/** A string capped to `max` characters; `null`/`undefined` stay `null` so absent stays absent. */
export function clampText(value: string | null | undefined, max: number): { text: string | null; truncated: boolean } {
  if (value === undefined || value === null) return { text: null, truncated: false }
  if (value.length <= max) return { text: value, truncated: false }
  return { text: value.slice(0, max), truncated: true }
}

/** The leading rows of a list, with the one flag that says rows were left out. */
export function takeRows<T>(rows: readonly T[], max: number): { rows: T[]; truncated: boolean } {
  if (rows.length <= max) return { rows: [...rows], truncated: false }
  return { rows: rows.slice(0, max), truncated: true }
}

/**
 * Awaits `work`, answering {@link TIMED_OUT} when it outlives `ms`.
 *
 * The timer is always cleared: a leaked interval keeps a host process alive, and this one runs on
 * a backend whose `status()` may never settle (contract §2.6).
 */
export async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>(resolve => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Runs `work` over every item, never more than `limit` at a time, keeping the input order.
 *
 * Usage scanning is the caller: a session directory may hold thousands of files, and starting a
 * stream per file at once would exhaust file handles rather than go faster.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Math.max(1, Math.min(limit, items.length))
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const index = next
        next += 1
        if (index >= items.length) return
        results[index] = await work(items[index] as T, index)
      }
    }),
  )
  return results
}
