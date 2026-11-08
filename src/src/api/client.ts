/**
 * The one place this front end reaches the desktop through.
 *
 * Every command goes through `call`, so the command surface stays enumerable and no component
 * spells a command name or a channel by hand. A rejected call is normalized to `ApiError`: the
 * desktop answers `{ code, message }` (`src-tauri/src/errors.rs`), and anything else — a refusal
 * from the IPC layer itself, which is a bare string — is wrapped rather than rethrown raw, so a
 * caller can always read a stable code.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { SESSION_EVENT_CHANNEL_PREFIX } from '@/api/types'

export interface ApiError {
  code: string
  message: string
}

const UNKNOWN_CODE = 'unknown_error'

export function isApiError(value: unknown): value is ApiError {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { code?: unknown; message?: unknown }
  return typeof candidate.code === 'string' && typeof candidate.message === 'string'
}

export function toApiError(error: unknown): ApiError {
  if (isApiError(error)) return error
  if (typeof error === 'string' && error.length > 0) {
    return { code: UNKNOWN_CODE, message: error }
  }
  if (error instanceof Error) {
    return { code: UNKNOWN_CODE, message: error.message }
  }
  return { code: UNKNOWN_CODE, message: 'The desktop did not explain the failure.' }
}

/** True when the call failed with `code`. */
export function hasCode(error: unknown, code: string): boolean {
  return isApiError(error) && error.code === code
}

/**
 * Run one command.
 *
 * `args` is typed `never` by the wrappers in `agent.ts` so a caller cannot reach this directly with
 * a hand-built payload; the cast here is the single boundary where an untyped record crosses.
 */
export async function call<T>(
  command: string,
  args?: Record<string, unknown> | undefined,
): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    throw toApiError(error)
  }
}

/**
 * Subscribe to a Tauri event channel.
 *
 * The promise resolves to the unlisten function, so a caller's cleanup path is one call; an
 * unsubscribable channel resolves to a no-op instead of rejecting, because a listener that cannot
 * be registered must not take a component's effect down with it.
 */
export async function subscribe<T>(
  channel: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  return listen<T>(channel, (event) => handler(event.payload))
}

/**
 * The session channel for one conversation.
 *
 * The id is in the channel name, so the desktop replaces every character outside
 * `[A-Za-z0-9\-/:_]` with `-` (`src-tauri/src/services/runtime/mod.rs`); the same substitution has
 * to happen here or a subscription to a differently-shaped id would silently never fire.
 */
export function sessionChannel(sessionId: string): string {
  return `${SESSION_EVENT_CHANNEL_PREFIX}${sessionId.replace(/[^A-Za-z0-9\-/:_]/g, '-')}`
}
