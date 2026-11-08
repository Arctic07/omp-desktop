/**
 * The two preferences the General page reads from the desktop rather than from the engine.
 *
 * Each is one boolean-ish setting owned by the host process — whether the engine compacts a filling
 * context, whether closing the window leaves the app in the tray — and each answers with its own
 * small shape rather than with an engine view. They are two resources rather than one because they
 * fail independently: a host that cannot answer for the tray still knows its own compaction
 * behaviour.
 */

import {
  presenceGet,
  presenceSet,
  type PresenceSettings,
} from '@/api/preferences'
import {
  engineCompactionStatus,
  setEngineCompactionEnabled,
  setEngineCompactionOptions,
} from '@/api/capabilities'
import type { EngineCompactionStatus } from '@/api/capabilities-types'
import { toApiError, type ApiError } from '@/api/client'
import { createResource } from '@/state/resource'

/** Whether the engine compacts a filling context by itself (its own `compaction.enabled`). */
export const compactionResource = createResource<EngineCompactionStatus>(() =>
  engineCompactionStatus(),
)

/** Whether closing the window leaves the application running in the system tray. */
export const presenceResource = createResource<PresenceSettings>(() => presenceGet())

export function readCompaction(force = false): Promise<void> {
  return compactionResource.read({ force })
}

export function readPresence(force = false): Promise<void> {
  return presenceResource.read({ force })
}

/** Turn context compaction on or off. The engine's own setting, read back as it resolved it. */
export async function writeCompaction(enabled: boolean): Promise<ApiError | null> {
  try {
    compactionResource.adopt(await setEngineCompactionEnabled(enabled))
    return null
  } catch (error) {
    return toApiError(error)
  }
}

/**
 * Write one or both idle switches. Each is written by itself (an omitted one is untouched), and the
 * answer is the engine's resolved values, so the card can show both at once.
 */
export async function writeCompactionOptions(options: {
  idleEnabled?: boolean
  recapEnabled?: boolean
}): Promise<ApiError | null> {
  try {
    compactionResource.adopt(await setEngineCompactionOptions(options))
    return null
  } catch (error) {
    return toApiError(error)
  }
}

export async function writePresence(closeToTray: boolean): Promise<ApiError | null> {
  try {
    presenceResource.adopt(await presenceSet(closeToTray))
    return null
  } catch (error) {
    return toApiError(error)
  }
}
