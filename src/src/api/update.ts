/**
 * The application's own update channel, as the shell reports it.
 *
 * One status per transition, whole: the desktop publishes the complete value on `omp:update` and
 * answers the same shape from `update_status`, so a reader that subscribed late and one that saw
 * every event draw the same screen. A failed check is a status (`phase: 'error'`) rather than a
 * rejected call; the page words the failure itself.
 */

import type { UnlistenFn } from '@tauri-apps/api/event'

import { call, subscribe } from '@/api/client'
import { COMMANDS, UPDATE_EVENT } from '@/api/types'

export type UpdatePhase =
  | 'idle'
  | 'unsupported'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'

export interface UpdateStatus {
  phase: UpdatePhase
  /** The announced version, while there is one to name. */
  version: string | null
  /** The feed's release notes, capped by the desktop. */
  notes: string | null
  /** Whole percent while a download's total is known. */
  progress: number | null
  /** The failure's own words, present only with `phase: 'error'`. */
  error: string | null
}

/** The last status the desktop published. */
export function updateStatus(): Promise<UpdateStatus> {
  return call<UpdateStatus>(COMMANDS.updateStatus)
}

/** Ask the fixed release feed whether this build is the newest one. */
export function updateCheck(): Promise<UpdateStatus> {
  return call<UpdateStatus>(COMMANDS.updateCheck)
}

/** Download and install the announced release. On Windows the application exits into the installer. */
export function updateInstall(): Promise<UpdateStatus> {
  return call<UpdateStatus>(COMMANDS.updateInstall)
}

/** Restart into a downloaded release; refused unless one is waiting. */
export function updateRelaunch(): Promise<void> {
  return call<void>(COMMANDS.updateRelaunch)
}

/** Every transition of that status, as the desktop publishes it. */
export function subscribeUpdate(handler: (status: UpdateStatus) => void): Promise<UnlistenFn> {
  return subscribe<UpdateStatus>(UPDATE_EVENT, handler)
}
