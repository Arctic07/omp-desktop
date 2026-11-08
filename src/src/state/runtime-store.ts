/**
 * The engine's own runtime: whether a host is up, which build it is, and where its data lives.
 *
 * Read together because the About page states them together, and because the two answers come from
 * the same process: a status read that succeeds while the path read fails is a host that is being
 * restarted, and the page should show one failure rather than a half-filled table.
 */

import { engineDataPaths, runtimeStatus } from '@/api/agent'
import type { EngineDataPaths, RuntimeStatus } from '@/api/types'
import { createResource } from '@/state/resource'

interface EngineStatus {
  runtime: RuntimeStatus
  paths: EngineDataPaths
}

export const runtimeResource = createResource<EngineStatus>(async () => {
  const [runtime, paths] = await Promise.all([runtimeStatus(), engineDataPaths()])
  return { runtime, paths }
})

/** Read the engine's status, or re-read it. `force` is the About page's retry. */
export function readEngineStatus(force = false): Promise<void> {
  return runtimeResource.read({ force })
}
