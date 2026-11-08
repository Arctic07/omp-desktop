/**
 * The MCP servers the engine found for the active workspace, plus whatever the live manager reports.
 *
 * A server's state is three facts, and the engine reports all three: whether its definition file
 * enables it (`configuredEnabled`), whether the user's own denylist/allowlist does (`enabled`), and
 * — once a manager exists — whether it is connected (`status`). Nothing here derives one from
 * another; the page renders what the host said.
 *
 * Writes go through the engine's own config writer rather than through this side, which is what lets
 * a definition this application does not own be handled the way the engine handles it.
 */

import {
  engineMcp,
  removeEngineMcp,
  setEngineMcpEnabled,
  upsertEngineMcp,
} from '@/api/capabilities'
import type { EngineMcpDefinitionInput, EngineMcpScope, EngineMcpView } from '@/api/capabilities-types'
import { toApiError, type ApiError } from '@/api/client'
import { createWorkspaceResource } from '@/state/resource'

export const mcpResource = createWorkspaceResource<EngineMcpView>((workspaceId) =>
  engineMcp(workspaceId),
)

export function readMcp(workspaceId: number | null, force = false): Promise<void> {
  return mcpResource.read(workspaceId, { force })
}

export async function writeMcpEnabled(
  workspaceId: number | null,
  name: string,
  enabled: boolean,
): Promise<ApiError | null> {
  try {
    mcpResource.adopt(await setEngineMcpEnabled(workspaceId, name, enabled))
    return null
  } catch (error) {
    return toApiError(error)
  }
}

/** Create one definition, or replace the keys an edit owns. */
export async function writeMcpDefinition(
  workspaceId: number | null,
  name: string,
  scope: EngineMcpScope,
  definition: EngineMcpDefinitionInput,
): Promise<ApiError | null> {
  try {
    mcpResource.adopt(await upsertEngineMcp(workspaceId, name, scope, definition))
    return null
  } catch (error) {
    return toApiError(error)
  }
}

/** Delete one definition from the file its scope names. */
export async function removeMcpDefinition(
  workspaceId: number | null,
  name: string,
  scope: EngineMcpScope,
): Promise<ApiError | null> {
  try {
    mcpResource.adopt(await removeEngineMcp(workspaceId, name, scope))
    return null
  } catch (error) {
    return toApiError(error)
  }
}
