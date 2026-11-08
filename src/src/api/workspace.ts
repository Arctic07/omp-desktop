/**
 * The workspace file commands: one directory listing, one file read, one path search.
 *
 * The desktop owns every filesystem decision (`src-tauri/src/services/workspace.rs`): paths here
 * are workspace-relative, and the Rust side canonicalizes them, refuses escapes and ignored
 * directories, and bounds every read. The file panel draws what comes back; it never touches a
 * path on its own.
 */

import { call } from '@/api/client'
import { COMMANDS } from '@/api/types'

/** One row of a directory listing, as `list_workspace_entries` serializes it. */
export interface WorkspaceEntry {
  name: string
  kind: 'dir' | 'file' | string
  size: number
}

interface ListWorkspaceEntriesResult {
  entries: WorkspaceEntry[]
}

/**
 * One path, in the shapes the panel can draw.
 *
 * `text` carries the string, `image` a `data:` URL (the desktop limits it to 5 MiB), `binary` and
 * `tooLarge` carry no payload at all — only the size the desktop measured. `directory` is not a
 * failure: a path a transcript printed can name a folder, and the read says so (no payload, size 0)
 * instead of refusing it, so the page can open the tree or the file manager rather than drawing
 * "could not read this file" over a folder that plainly exists.
 */
export interface WorkspaceFileRead {
  kind: 'text' | 'image' | 'binary' | 'tooLarge' | 'directory' | string
  content?: string
  dataUrl?: string
  size: number
}

/** The answer to a path search: relative paths, and whether the walk held more matches. */
export interface WorkspacePathSearch {
  paths: string[]
  truncated: boolean
}

/** List one workspace directory; `'.'` names the root. */
export async function listWorkspaceEntries(
  root: string,
  path: string,
): Promise<WorkspaceEntry[]> {
  const result = await call<ListWorkspaceEntriesResult>(COMMANDS.listWorkspaceEntries, {
    root,
    path,
  })
  return result.entries
}

/** Read one workspace file by its workspace-relative path. */
export function readWorkspaceFile(root: string, path: string): Promise<WorkspaceFileRead> {
  return call<WorkspaceFileRead>(COMMANDS.readWorkspaceFile, { root, path })
}

/**
 * Replace one existing workspace text file's contents.
 *
 * The desktop re-resolves `path` inside `root` (relative, not ignored, not escaping through a link),
 * refuses anything that is not a regular file, bounds the payload like a read, and swaps the bytes
 * in through a temporary copy, so a save is all-or-nothing (`services/workspace.rs`).
 */
export function writeWorkspaceFile(
  root: string,
  path: string,
  content: string,
): Promise<void> {
  return call<void>(COMMANDS.writeWorkspaceFile, { root, path, content })
}

/** Reveal one workspace entry (file or folder) in the machine's own file manager. */
export function revealWorkspaceEntry(root: string, path: string): Promise<boolean> {
  return call<boolean>(COMMANDS.revealWorkspaceEntry, { root, path })
}

/**
 * Search workspace file paths, never contents.
 *
 * The desktop walks the workspace (or its git index when there is one) and ranks leaf matches
 * ahead of directory matches, so this is the same answer the composer's `@` picker uses.
 */
export function searchWorkspacePaths(
  root: string,
  query: string,
  maxResults = 100,
): Promise<WorkspacePathSearch> {
  return call<WorkspacePathSearch>(COMMANDS.searchWorkspacePaths, {
    root,
    query,
    maxResults,
  })
}
