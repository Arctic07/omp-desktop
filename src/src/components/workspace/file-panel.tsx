/**
 * The file tab: the tree on the left, the preview on the right.
 *
 * One tab per conversation, opened by the strip's "文件" entry and closed like any other tab
 * (`state/panel-store.ts`). The panel owns nothing once it unmounts: the tree, the search and the
 * preview live in `useFilePanel`, so closing the tab releases every cached directory and every
 * read. While it is mounted the left pane can be widened, and the reader's chosen width is kept
 * for the life of the tab.
 *
 * The workspace watch is pointed here by `right-sidebar.tsx` whenever this tab is the one on
 * screen; the subscription below folds each coalesced report into one quiet refresh.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { revealWorkspaceEntry } from '@/api/workspace'
import {
  prefetchCodeLanguage,
  warmUpCodeHighlight,
} from '@/components/agents/code-highlight-client'
import { FILE_PANEL_COPY } from '@/components/workspace/file-panel-copy'
import { describeFile } from '@/components/workspace/file-language'
import { FileTree } from '@/components/workspace/file-tree'
import { FileViewer } from '@/components/workspace/file-viewer'
import { sameFilePath } from '@/lib/file-path'
import { useCopy } from '@/lib/i18n'
import { fileOpenRequestStore } from '@/state/file-open-request'
import { useFilePanel } from '@/state/file-panel-store'
import { useStoreSelector } from '@/state/store'
import {
  subscribeWorkspaceChange,
  workspaceChangeRevision,
} from '@/state/workspace-watch-store'

const TREE_MIN_WIDTH = 150
const TREE_MAX_WIDTH = 360
const TREE_DEFAULT_WIDTH = 210

export interface FilePanelProps {
  /** The conversation whose tab this is: what a transcript's "open this file" request names. */
  sessionId: string
  /** The workspace root the tab was opened on, or null when it had none. */
  workspaceRoot: string | null
  /** Whether the tab is on screen; a hidden panel catches up when it is shown again. */
  active: boolean
}

export function FilePanel({ sessionId, workspaceRoot, active }: FilePanelProps) {
  const copy = useCopy(FILE_PANEL_COPY)
  const panel = useFilePanel({ workspaceRoot, active })
  const [treeWidth, setTreeWidth] = useState(TREE_DEFAULT_WIDTH)
  const [revealFailed, setRevealFailed] = useState(false)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  /** The row's own "show in File Explorer": the desktop validates the path inside the workspace. */
  const revealEntry = useCallback(
    (path: string) => {
      if (workspaceRoot === null) return
      setRevealFailed(false)
      void revealWorkspaceEntry(workspaceRoot, path)
        .then((opened) => {
          if (!opened) setRevealFailed(true)
        })
        .catch(() => setRevealFailed(true))
    },
    [workspaceRoot],
  )

  const noteRef = useRef(panel.noteChange)
  useEffect(() => {
    noteRef.current = panel.noteChange
  }, [panel.noteChange])

  // A path clicked in the transcript: this tab's own conversation and root, and nothing else. The
  // request stays in the store, so it is answered once by the panel it names; a later click is a new
  // object and reveals the file again. Revealing opens the ancestors, which is what puts a file
  // outside the expanded branches on screen too.
  const openFile = panel.openFile
  const openRequest = useStoreSelector(fileOpenRequestStore, (request) => request)
  useEffect(() => {
    if (openRequest === null || workspaceRoot === null) return
    if (openRequest.sessionId !== sessionId) return
    if (!sameFilePath(openRequest.root, workspaceRoot)) return
    openFile(openRequest.path, true)
  }, [openFile, openRequest, sessionId, workspaceRoot])

  // Colours should be there when the file appears, not a beat later: the tab opening is the first
  // moment the highlighter is known to be wanted, and the reader spends the wait on the tree.
  useEffect(() => {
    warmUpCodeHighlight()
  }, [])

  // The path is known before the read is: ask for the grammar while the desktop is still reading.
  useEffect(() => {
    if (panel.selectedPath === null) return
    prefetchCodeLanguage(describeFile(panel.selectedPath).language)
  }, [panel.selectedPath])

  useEffect(
    () =>
      subscribeWorkspaceChange(() => {
        noteRef.current(workspaceChangeRevision())
      }),
    [],
  )

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (dragRef.current === null) return
      const delta = event.clientX - dragRef.current.startX
      setTreeWidth(
        Math.min(
          TREE_MAX_WIDTH,
          Math.max(TREE_MIN_WIDTH, dragRef.current.startWidth + delta),
        ),
      )
    }
    const stopDrag = () => {
      if (dragRef.current === null) return
      dragRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopDrag)
    window.addEventListener('pointercancel', stopDrag)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopDrag)
      window.removeEventListener('pointercancel', stopDrag)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [])

  return (
    <div
      role="region"
      aria-label={copy.title}
      className="flex h-full min-h-0 w-full"
    >
      <div
        className="flex min-h-0 min-w-0 shrink-0 flex-col border-border border-r"
        style={{ width: treeWidth }}
      >
        <FileTree
          workspaceRoot={workspaceRoot}
          rows={panel.rows}
          selectedPath={panel.selectedPath}
          query={panel.query}
          onQueryChange={panel.setQuery}
          search={panel.search}
          onRetrySearch={panel.retrySearch}
          rootLoaded={panel.rootLoaded}
          rootLoading={panel.rootLoading}
          rootError={panel.rootError}
          refreshing={panel.refreshing}
          onRefresh={panel.refresh}
          onToggleDirectory={panel.toggleDirectory}
          onOpenFile={panel.openFile}
          onRevealEntry={revealEntry}
          revealFailed={revealFailed}
        />
      </div>
      <div
        role="separator"
        aria-label={copy.resizeTree}
        aria-orientation="vertical"
        onPointerDown={(event) => {
          dragRef.current = { startX: event.clientX, startWidth: treeWidth }
          document.body.style.cursor = 'col-resize'
          document.body.style.userSelect = 'none'
        }}
        className="relative z-10 -mx-px w-1 shrink-0 cursor-col-resize transition-colors hover:bg-border"
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <FileViewer
          content={panel.content}
          save={panel.save}
          dirty={panel.dirty}
          active={active}
          onDraftChange={panel.setDraft}
          onToggleEditing={panel.toggleEditing}
          onSave={panel.saveDraft}
          onRetry={panel.retryContent}
        />
      </div>
    </div>
  )
}
