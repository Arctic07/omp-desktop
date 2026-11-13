/**
 * The engine's `/extensions` dashboard, as one workspace-keyed resource.
 *
 * Every settings section reads the host the same way (`state/resource.ts`): a whole payload, the
 * newest answer wins, and a write's own answer is adopted rather than patched. The page's first
 * version kept the list in component state, which let a read that started before the reader moved
 * to another workspace repaint the newer workspace's rows.
 *
 * The toggle answers with the refreshed dashboard, so the write adopts what it returned; the
 * per-row refusal is the caller's to render, not this module's.
 */

import { toApiError, type ApiError } from '@/api/client'
import { extensionsList, setExtension, type ExtensionsView } from '@/api/extensions'
import { createWorkspaceResource } from '@/state/resource'

export const extensionsResource = createWorkspaceResource<ExtensionsView>((workspaceId) =>
  extensionsList(workspaceId),
)

export function readExtensions(workspaceId: number | null, force = false): Promise<void> {
  return extensionsResource.read(workspaceId, { force })
}

/** Flip one item; the host answers with the dashboard as it stands after the write. */
export async function writeExtension(
  workspaceId: number | null,
  id: string,
  enabled: boolean,
): Promise<ApiError | null> {
  try {
    const view = await setExtension(workspaceId, id, enabled)
    extensionsResource.adopt(view, workspaceId)
    return null
  } catch (error) {
    return toApiError(error)
  }
}
