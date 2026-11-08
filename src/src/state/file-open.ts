/**
 * Where a file path printed in a transcript opens.
 *
 * Two surfaces, decided by where the file sits. A path under the conversation's own workspace root
 * is the file tab's: the tab's tree reveals it and its preview draws it, which is exactly what a
 * click in the tree does. A path outside every root is a tab of its own
 * (`state/panel-store.ts` ⑥), read by the desktop's `read_external_file`.
 *
 * Which of the two is a **folder** is not decided here: only the filesystem knows, so the click
 * routes on where the path is and the read answers what it is. Both surfaces take the same answer —
 * the tree opens to the folder, the outside tab says what it is and offers the file manager — so a
 * transcript that prints `C:\Users` cannot draw a failed file read over a directory.
 *
 * The conversation that asked is the one whose strip gets the tab — read from the active record, not
 * guessed from whichever panel is on screen. A relative path is resolved against that root only;
 * with no workspace there is nothing to resolve it against, and the click does nothing rather than
 * opening a tab that cannot read.
 */

import { filePathInText, isAbsoluteFilePath, relativePathInsideRoot } from '@/lib/file-reference'
import { normaliseFilePath } from '@/lib/file-path'
import { requestFileOpen } from '@/state/file-open-request'
import { openFileTab, openSourceFileTab } from '@/state/panel-store'
import { panelState } from '@/state/panel-state'
import { activeRecord, sessionStore } from '@/state/session-store'
import { workspaceStore } from '@/state/workspace-store'

/** Reveal one workspace file in the conversation's file tab, opening that tab when it is closed. */
function openWorkspaceFile(sessionId: string, fallbackRoot: string, path: string): void {
  openFileTab(sessionId)
  // The tab captured its root when it was created; a tab already open keeps reading that root, and
  // asking it for a file from another tree would only draw an error.
  const root = panelState().fileOpen[sessionId] ?? fallbackRoot
  requestFileOpen(sessionId, root, path)
}

/**
 * Open one path a transcript printed: an inline-code span that reads as a file.
 *
 * The text is re-checked here rather than trusted from the renderer, because this is also the entry
 * point for any later surface that offers a path; a span that is not a path is not a click.
 */
export function openPrintedPath(text: string): void {
  const path = filePathInText(text)
  if (path === null) return
  const record = activeRecord(sessionStore.get())
  if (record === null) return
  const root = workspaceStore.get().items.find((item) => item.id === record.workspaceId)?.rootPath ?? null
  if (isAbsoluteFilePath(path)) {
    // The path is handed to the read as it was printed: a UNC path's leading `\\` is the
    // server's spelling, and the comparisons below normalise on their own.
    const relative = root === null ? null : relativePathInsideRoot(root, path)
    if (relative === null || root === null) openSourceFileTab(record.id, path)
    else openWorkspaceFile(record.id, root, relative)
    return
  }
  // A relative path is only meaningful inside the conversation's workspace.
  if (root !== null) openWorkspaceFile(record.id, root, normaliseFilePath(path))
}
