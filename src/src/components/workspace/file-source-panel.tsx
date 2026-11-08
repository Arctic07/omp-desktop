/**
 * One path read from an absolute path outside every workspace root.
 *
 * A transcript prints paths the workspace tree has no row for — a scratch file beside a project, a
 * file another tool generated — and clicking one opens this: its own strip tab, drawn by the same
 * `FileViewer` the file panel uses, so a highlighted read, an image, a binary refusal and a
 * too-large notice all look the way they look inside a workspace. A path can also be a **folder**,
 * and the desktop answers that as its own kind: the tab then says what it is and opens it in the
 * file manager instead of drawing a failed read over a folder that plainly exists.
 *
 * What is missing is the tree, and with it the operations that need one: there is no selection to
 * move and nothing to save into, so the read is read-only (`draft` stays null, which is what hides
 * the editor's pencil and save). "Show in folder" still works — the desktop's reveal takes the
 * file's parent as its root and the file as the entry.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { readExternalFile, openDirectoryInFileManager } from '@/api/agent'
import { revealWorkspaceEntry } from '@/api/workspace'
import {
  prefetchCodeLanguage,
  warmUpCodeHighlight,
} from '@/components/agents/code-highlight-client'
import { FILE_PANEL_COPY } from '@/components/workspace/file-panel-copy'
import { describeFile } from '@/components/workspace/file-language'
import { FileViewer } from '@/components/workspace/file-viewer'
import { fileLeafName, fileParentPath } from '@/lib/file-path'
import { useCopy } from '@/lib/i18n'
import { fileErrorMessage, type FileContentState, type FileSaveState } from '@/state/file-panel-store'

/** Nothing is ever saved here, so the viewer's save line has one state for the tab's whole life. */
const NO_SAVE: FileSaveState = { phase: 'idle', error: null }

/** One read's state. The tab has no draft, so there is nothing to edit and nothing to save. */
function contentFrom(
  path: string,
  read: FileContentState['read'],
  error: string | null,
): FileContentState {
  return {
    phase: error === null ? (read === null ? 'loading' : 'ready') : 'error',
    path,
    read,
    error,
    draft: null,
    baseline: null,
    eol: '\n',
    editing: false,
  }
}

export interface FileSourcePanelProps {
  /** The absolute path this tab reads, as the transcript printed it (a UNC path keeps `\\`). */
  path: string
  /** Whether the tab is on screen; the viewer's own keyboard binding is the only reader. */
  active: boolean
}

export function FileSourcePanel({ path, active }: FileSourcePanelProps) {
  const copy = useCopy(FILE_PANEL_COPY)
  const [content, setContent] = useState<FileContentState>(() => contentFrom(path, null, null))
  const [revealFailed, setRevealFailed] = useState(false)
  const requestRef = useRef(0)

  const load = useCallback(() => {
    const token = ++requestRef.current
    void readExternalFile(path)
      .then((answer) => {
        if (requestRef.current !== token) return
        setContent(contentFrom(path, answer, null))
      })
      .catch((error: unknown) => {
        if (requestRef.current !== token) return
        setContent(contentFrom(path, null, fileErrorMessage(error, copy.fileFailed)))
      })
  }, [copy.fileFailed, path])

  // The first read starts with the tab; a retry resets the answer and asks again.
  useEffect(() => {
    load()
  }, [load])

  const retry = useCallback(() => {
    setContent(contentFrom(path, null, null))
    load()
  }, [load, path])

  // The path is known before the text is: ask for the grammar while the desktop is still reading,
  // and make sure the highlighter itself is up (the tab can be the first thing opened in a session).
  useEffect(() => {
    warmUpCodeHighlight()
    prefetchCodeLanguage(describeFile(path).language)
  }, [path])

  const reveal = useCallback(() => {
    const parent = fileParentPath(path)
    // `C:` is a drive, not a folder the file manager can open, so a file at a root has no reveal.
    if (parent === null || !parent.includes('/')) return
    setRevealFailed(false)
    void revealWorkspaceEntry(parent, fileLeafName(path))
      .then((opened) => {
        if (!opened) setRevealFailed(true)
      })
      .catch(() => setRevealFailed(true))
  }, [path])

  /**
   * A path the transcript printed can be a folder, and the tab then draws what it is rather than a
   * read. The desktop's open only answers `true` for a directory, so this cannot open a file.
   */
  const openFolder = useCallback(() => {
    setRevealFailed(false)
    void openDirectoryInFileManager(path)
      .then((opened) => {
        if (!opened) setRevealFailed(true)
      })
      .catch(() => setRevealFailed(true))
  }, [path])

  return (
    <FileViewer
      content={content}
      save={NO_SAVE}
      dirty={false}
      active={active}
      onRetry={retry}
      onReveal={reveal}
      onOpenFolder={openFolder}
      revealFailed={revealFailed}
    />
  )
}
