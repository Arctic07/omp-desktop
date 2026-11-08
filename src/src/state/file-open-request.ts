/**
 * One "open this file" asked of the file panel from outside it.
 *
 * The file tab's tree, selection and preview are the panel's own (`state/file-panel-store.ts`), but
 * a path clicked in the transcript has to reach them without the panel being the caller: the panel
 * may not even be mounted yet. The request is the one hand-off — the caller names the tab's
 * conversation and the root it should read, the mounted panel with that exact owner consumes it and
 * reveals the file. A request is a fresh object per click, so clicking one path twice is two
 * requests and the second one reveals the file again rather than being swallowed as a no-op.
 */

import { createStore } from '@/state/store'

export interface FileOpenRequest {
  /** The conversation whose file tab should reveal the file; never another conversation's. */
  sessionId: string
  /** The workspace root the target tab was opened on. */
  root: string
  /** Workspace-relative path, `/`-separated. */
  path: string
}

export const fileOpenRequestStore = createStore<FileOpenRequest | null>(null)

/** Ask the file panel to select and reveal one workspace file. */
export function requestFileOpen(sessionId: string, root: string, path: string): void {
  fileOpenRequestStore.set({ sessionId, root, path })
}
