/**
 * The update status the interface reads, and the three acts it may ask for.
 *
 * The desktop owns the state machine; this store is its projection. It subscribes to `omp:update`
 * before reading the current value, so a transition that lands between the subscription and the read
 * is folded by one or the other and never lost. A read takes a sequence number and every event or
 * command answer invalidates it, so an older snapshot never overwrites a newer status; each whole
 * status is adopted instead of patching fields.
 */

import { toApiError, type ApiError } from '@/api/client'
import {
  subscribeUpdate,
  updateCheck,
  updateInstall,
  updateRelaunch,
  updateStatus,
  type UpdateStatus,
} from '@/api/update'
import { createStore } from '@/state/store'

export interface UpdateState {
  /** The last complete status the desktop published; `null` until the first read lands. */
  status: UpdateStatus | null
  /** A rejected command. The status's own `error` is a failed check, which is not this. */
  failure: ApiError | null
}

export const updateStore = createStore<UpdateState>({ status: null, failure: null })

/** One act at a time: a second press while one is in flight would ask the desktop twice. */
let inFlight = false

/** The newest answer's ticket: a read that started before an event or command answer is stale. */
let readSequence = 0

function adopt(status: UpdateStatus): void {
  readSequence += 1
  updateStore.set({ status, failure: null })
}

function fail(error: unknown): void {
  readSequence += 1
  updateStore.set((previous) => ({ ...previous, failure: toApiError(error) }))
}

/**
 * Subscribe to the desktop's channel and read the status it already holds.
 *
 * Returns the release path; the App's effect calls it once and its cleanup runs on unmount, so a
 * reload never leaves a second listener folding the same events.
 */
export function startUpdateWiring(): () => void {
  let disposed = false
  let unlisten: (() => void) | undefined

  void subscribeUpdate((status) => {
    if (!disposed) adopt(status)
  }).then((stop) => {
    if (disposed) stop()
    else unlisten = stop
  })

  const mine = ++readSequence
  void updateStatus()
    .then((status) => {
      if (!disposed && mine === readSequence) adopt(status)
    })
    .catch((error) => {
      if (!disposed && mine === readSequence) fail(error)
    })

  return () => {
    disposed = true
    unlisten?.()
  }
}

/** Ask the fixed feed; the answer, including a failure, lands in the store. */
export async function checkForUpdates(): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    adopt(await updateCheck())
  } catch (error) {
    fail(error)
  } finally {
    inFlight = false
  }
}

/** Download and install the announced release. On Windows the application restarts itself. */
export async function installUpdate(): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    adopt(await updateInstall())
  } catch (error) {
    fail(error)
  } finally {
    inFlight = false
  }
}

/** Restart into a downloaded release. */
export async function relaunchForUpdate(): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    await updateRelaunch()
  } catch (error) {
    fail(error)
  } finally {
    inFlight = false
  }
}
