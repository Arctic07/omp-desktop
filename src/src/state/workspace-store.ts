/**
 * The workspaces this application knows, and which one is being worked in.
 *
 * A workspace is a folder the desktop has been told about, plus the store's own bookkeeping for it:
 * its name, whether the directory is still on disk, and when it was last opened. Nothing here reads
 * the folder's contents — the rail shows the *conversations* of each workspace, and those come from
 * the session store.
 */

import {
  currentWorkingDirectory,
  openDirectoryInFileManager,
  workspaceAdd,
  workspaceList,
  workspaceRemove,
  workspaceRename,
  workspaceReorder,
  workspaceTouch,
} from '@/api/agent'
import type { ApiError } from '@/api/client'
import { chooseFolder } from '@/api/dialog'
import type { WorkspaceSummary } from '@/api/types'
import { createStore } from '@/state/store'

export interface WorkspaceState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: ApiError | null
  items: WorkspaceSummary[]
  activeId: number | null
}

const EMPTY: WorkspaceState = {
  status: 'idle',
  error: null,
  items: [],
  activeId: null,
}

export const workspaceStore = createStore<WorkspaceState>(EMPTY)

function patch(state: Partial<WorkspaceState>): void {
  workspaceStore.set((previous) => ({ ...previous, ...state }))
}

export async function loadWorkspaces(): Promise<void> {
  patch({ status: 'loading', error: null })
  try {
    const items = await workspaceList()
    workspaceStore.set((previous) => {
      const stillThere = items.some((item) => item.id === previous.activeId)
      return {
        ...previous,
        status: 'ready',
        error: null,
        items,
        activeId: stillThere ? previous.activeId : null,
      }
    })
  } catch (error) {
    patch({ status: 'error', error: error as ApiError })
  }
}

/**
 * The first read of the workspace list, shared by its two callers.
 *
 * The startup shell's hand-over waits for this read (`src/main.tsx`), and the rail asks for it when
 * it mounts. Two `workspace_list` calls would race each other and could answer in either order, so
 * both share one promise. A later refresh — adding a workspace, or the rollback of a refused
 * reorder — calls {@link loadWorkspaces} directly, because it must see the write that preceded it.
 */
let bootLoad: Promise<void> | null = null

export function ensureWorkspacesLoaded(): Promise<void> {
  bootLoad ??= loadWorkspaces()
  return bootLoad
}

/**
 * Work in this workspace.
 *
 * The session store follows this — it is the single source of truth for which workspace is active,
 * so switching here is what loads that workspace's conversations.
 */
export async function activateWorkspace(workspaceId: number): Promise<void> {
  const workspace = workspaceStore.get().items.find((item) => item.id === workspaceId)
  if (!workspace) return
  patch({ activeId: workspaceId })
  try {
    await workspaceTouch(workspaceId)
  } catch {
    // Touching is bookkeeping for the workspace's own recency; failing it must not stop the user
    // from working in the workspace they just picked.
  }
  // The list is not re-ordered here. The touch is what the registry sorts by the next time it is
  // read, so the rail never reshuffles under the pointer that just picked a row; the same is true
  // of the manual order's baseline (`projects.sort_order_at`).
}

export async function addWorkspace(rootPath: string): Promise<WorkspaceSummary> {
  const workspace = await workspaceAdd(rootPath)
  await loadWorkspaces()
  await activateWorkspace(workspace.id)
  return workspace
}

/**
 * Ask for a folder with the desktop's own picker, then add it.
 *
 * The rail's button and the tray's "open workspace" entry are two ways to the same action, so the
 * action lives here rather than in either caller. A dismissed dialog adds nothing.
 */
export async function pickAndAddWorkspace(title: string): Promise<void> {
  const folder = await chooseFolder(title)
  if (folder !== null) await addWorkspace(folder)
}

export async function renameWorkspace(workspaceId: number, name: string): Promise<void> {
  const updated = await workspaceRename(workspaceId, name)
  workspaceStore.set((previous) => ({
    ...previous,
    items: previous.items.map((item) => (item.id === updated.id ? updated : item)),
  }))
}

/**
 * Put the rail's workspaces in the order the reader dragged them into.
 *
 * The store's list is what the rail draws, so the new order is written here first and the registry
 * is told after: a row that has already moved on screen must not wait for a round trip to stand
 * where it was dropped. A refusal reads the registry again, which puts the list back — and a
 * workspace added while the write was out is kept, which restoring a captured copy would not do.
 */
export async function reorderWorkspaces(workspaceIds: readonly number[]): Promise<void> {
  const byId = new Map(workspaceStore.get().items.map((item) => [item.id, item]))
  const next: WorkspaceSummary[] = []
  for (const id of workspaceIds) {
    const item = byId.get(id)
    if (item === undefined) continue
    byId.delete(id)
    next.push(item)
  }
  next.push(...byId.values())
  workspaceStore.set((previous) => ({ ...previous, items: next }))
  try {
    await workspaceReorder(workspaceIds)
  } catch (error) {
    await loadWorkspaces()
    throw error
  }
}

export async function removeWorkspace(workspaceId: number): Promise<void> {
  await workspaceRemove(workspaceId)
  workspaceStore.set((previous) => ({
    ...previous,
    items: previous.items.filter((item) => item.id !== workspaceId),
    activeId: previous.activeId === workspaceId ? null : previous.activeId,
  }))
}

export async function revealWorkspace(workspaceId: number): Promise<void> {
  const workspace = workspaceStore.get().items.find((item) => item.id === workspaceId)
  if (!workspace) return
  await openDirectoryInFileManager(workspace.rootPath)
}

/** The directory the desktop's own process is in — what "add the folder I am in" offers. */
export function workingDirectory(): Promise<string> {
  return currentWorkingDirectory()
}
