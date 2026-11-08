/**
 * Workspace memory: the backend the engine runs, and — while that backend keeps files — the
 * documents a workspace's memory consists of.
 *
 * Two reads, because they answer different questions. The *view* is the engine's own status for the
 * active project (which backend is selected, what it would inject). The *catalog* is this
 * application's walk over every named workspace's memory root, which the host resolves from the
 * store's workspace ids rather than from any path this side would hand it.
 *
 * The backend is an engine setting, so a change answers with the refreshed view; the catalog is
 * re-read after it because a different backend means a different set of roots.
 */

import {
  engineMemory,
  engineMemoryCatalog,
  revealEngineMemoryFile,
  runEngineMemoryAction,
} from '@/api/capabilities'
import type { EngineMemoryCatalogView, EngineMemoryView } from '@/api/capabilities-types'
import { toApiError, type ApiError } from '@/api/client'
import { createKeyedResource, createWorkspaceResource } from '@/state/resource'

export const memoryResource = createWorkspaceResource<EngineMemoryView>((workspaceId) =>
  engineMemory(workspaceId),
)

/**
 * The catalog, keyed by the workspace ids it was read for.
 *
 * The key is the ids joined, so a workspace being added or removed asks again while a re-render with
 * the same set does not.
 */
export const memoryCatalogResource = createKeyedResource<string, EngineMemoryCatalogView>(
  (key) => engineMemoryCatalog(key === '' ? [] : key.split(',').map(Number)),
)

export function readMemory(workspaceId: number | null, force = false): Promise<void> {
  return memoryResource.read(workspaceId, { force })
}

export function readMemoryCatalog(workspaceIds: number[], force = false): Promise<void> {
  return memoryCatalogResource.read([...workspaceIds].sort((a, b) => a - b).join(','), { force })
}

/** Switch the backend. `off` is how the workspace switch turns memory off. */
export async function setMemoryBackend(
  workspaceId: number | null,
  backend: string,
): Promise<ApiError | null> {
  try {
    memoryResource.adopt(await runEngineMemoryAction(workspaceId, 'set_backend', backend))
    return null
  } catch (error) {
    return toApiError(error)
  }
}

/** Reveal one memory document in the platform's file manager. */
export function revealMemoryFile(workspaceId: number, name: string): Promise<{ ok: boolean }> {
  return revealEngineMemoryFile(workspaceId, name)
}
