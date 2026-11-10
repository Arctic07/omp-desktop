import { useCallback, useState } from 'react'

import { useStoreSelector } from '@/state/store'
import { workspaceStore, type WorkspaceState } from '@/state/workspace-store'

/**
 * Which scope a capability page acts on: the user's own machine, or one workspace.
 *
 * The engine resolves skills, MCP definitions and plugin registries per directory, so a page that
 * followed only the rail's active workspace could not answer "what does this other project have".
 * The picker is the one control that names the directory; `user` is the machine-wide scope, where
 * only user-level rows apply.
 *
 * The pick is local to the page: a capability page opens on `用户 · 本机`, and naming a workspace
 * changes only that page. Choosing a workspace here does not activate it, so the conversation column
 * keeps the workspace it was showing. A workspace removed from the store takes the page back to the
 * machine-wide scope rather than addressing an id the host no longer knows. The marketplace is the
 * one exception: it can be handed the plugin page's current pick when it is opened from there.
 */
/** The scope a capability page reads and writes. */
export type WorkspaceScopeTarget = 'user' | number

const selectWorkspaces = (state: WorkspaceState) => state.items

export function useWorkspaceScope(initial: WorkspaceScopeTarget = 'user'): {
  /** The directory the host is asked about: the pick, or none for the machine-wide scope. */
  workspaceId: number | null
  target: WorkspaceScopeTarget
  setTarget: (target: WorkspaceScopeTarget) => void
} {
  const workspaces = useStoreSelector(workspaceStore, selectWorkspaces)
  const [picked, setPicked] = useState<WorkspaceScopeTarget>(initial)
  const target =
    picked === 'user' || workspaces.some((workspace) => workspace.id === picked) ? picked : 'user'
  const setTarget = useCallback((next: WorkspaceScopeTarget) => setPicked(next), [])
  // The user scope asks the host about its own default workspace, not the rail's: with a project
  // directory the engine would dedupe a user definition against a same-named project one and the
  // page would then filter that project row out, hiding the user row it was supposed to show.
  return { workspaceId: target === 'user' ? null : target, target, setTarget }
}
