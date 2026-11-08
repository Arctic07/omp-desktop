/**
 * The file tree: one search field over a lazily loaded, virtualized directory list.
 *
 * Rows come from `state/file-panel-store.ts` already flattened and bounded; this component draws
 * them. A folder toggles on click and reports its loading state on the row, a file opens the one
 * preview beside the tree. Search results are a flat list of paths — the desktop's path search
 * never reads contents — and opening one reveals its ancestors in the tree behind the search.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  AtSign,
  ChevronRight,
  CircleAlert,
  Copy,
  Files,
  FolderOpen,
  LoaderCircle,
  Search,
  X,
} from 'lucide-react'

import { ResourceMenuAction } from '@/components/agents/ai-sidebar'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from '@/components/motion/popover-morph'
import { FILE_PANEL_COPY } from '@/components/workspace/file-panel-copy'
import { describeFile } from '@/components/workspace/file-language'
import { copyText } from '@/lib/clipboard'
import { absolutePathOf } from '@/lib/file-path'
import { useCopy } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { attachFileToComposer } from '@/state/composer-prefill'
import {
  beginFileDrag,
  cancelFileDrag,
  finishFileDrag,
  moveFileDrag,
} from '@/state/file-drag-store'
import type { FileSearchState, FileTreeRow } from '@/state/file-panel-store'

const TREE_ROW_HEIGHT = 28
const SEARCH_ROW_HEIGHT = 40

export interface FileTreeProps {
  workspaceRoot: string | null
  rows: readonly FileTreeRow[]
  selectedPath: string | null
  query: string
  onQueryChange: (query: string) => void
  search: FileSearchState
  onRetrySearch: () => void
  rootLoaded: boolean
  rootLoading: boolean
  rootError: string | null
  refreshing: boolean
  onRefresh: () => void
  onToggleDirectory: (path: string) => void
  onOpenFile: (path: string, reveal?: boolean) => void
  /** Reveal a row in the system file manager — what the row's context menu asks for. */
  onRevealEntry: (path: string) => void
  /** The last reveal attempt failed, so the tree says so above its list. */
  revealFailed: boolean
}

export function FileTree({
  workspaceRoot,
  rows,
  selectedPath,
  query,
  onQueryChange,
  search,
  onRetrySearch,
  rootLoaded,
  rootLoading,
  rootError,
  refreshing,
  onRefresh,
  onToggleDirectory,
  onOpenFile,
  onRevealEntry,
  revealFailed,
}: FileTreeProps) {
  const copy = useCopy(FILE_PANEL_COPY)
  const scrollRef = useRef<HTMLDivElement>(null)
  /**
   * The row the reader right-clicked, and where on the window.
   *
   * The point is viewport coordinates because the menu is a beUI popover: it portals out of the
   * tree and anchors to the pointer, not to the row (a row can scroll away under an open menu).
   */
  const [menu, setMenu] = useState<{ row: FileTreeRow; x: number; y: number } | null>(null)
  /** The last thing the row menu could not do, said above the list where the reader is looking. */
  const [menuNotice, setMenuNotice] = useState<string | null>(null)
  /** Confirmation for a copy, which has no visible result of its own. */
  const [announcement, setAnnouncement] = useState('')
  const searching = query.trim() !== ''

  const closeMenu = useCallback(() => setMenu(null), [])

  /** The row menu's "add to conversation": the file into the draft of the conversation on screen. */
  const addToConversation = useCallback(
    async (path: string) => {
      closeMenu()
      const imported = await attachFileToComposer(absolutePathOf(workspaceRoot ?? '', path))
      if (imported.added.length > 0) return
      const refusal = imported.refusal
      setMenuNotice(
        refusal === null || refusal.kind === 'desktop'
          ? copy.addToConversationFailed
          : refusal.kind === 'directory'
            ? copy.addToConversationDirectory
            : copy.addToConversationTooLarge(refusal.name),
      )
    },
    [closeMenu, copy, workspaceRoot],
  )

  /** The row menu's "copy path": the absolute path the reader could paste anywhere. */
  const copyEntryPath = useCallback(
    async (path: string) => {
      closeMenu()
      const ok = await copyText(absolutePathOf(workspaceRoot ?? '', path))
      setMenuNotice(ok ? null : copy.copyPathFailed)
      if (ok) setAnnouncement(copy.copied)
    },
    [closeMenu, copy, workspaceRoot],
  )

  // oxlint-disable-next-line react/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => rows[index]?.path ?? String(index),
    estimateSize: (index) =>
      rows[index]?.detail === undefined ? TREE_ROW_HEIGHT : SEARCH_ROW_HEIGHT,
    overscan: 16,
  })

  // Revealing a file from a search result expands its ancestors behind the search; clearing the
  // query then shows the row. Scroll it into view once it exists.
  const selectedIndex = useMemo(
    () => (selectedPath === null ? -1 : rows.findIndex((row) => row.path === selectedPath)),
    [rows, selectedPath],
  )
  const lastScrollKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (selectedPath === null || selectedIndex < 0) return
    const key = `${selectedPath}:${searching ? 'search' : 'tree'}`
    if (lastScrollKeyRef.current === key) return
    lastScrollKeyRef.current = key
    rowVirtualizer.scrollToIndex(selectedIndex, { align: 'auto' })
  }, [rowVirtualizer, searching, selectedIndex, selectedPath])

  const handleRow = useCallback(
    (row: FileTreeRow) => {
      if (row.kind === 'dir') {
        onToggleDirectory(row.path)
        return
      }
      onOpenFile(row.path, row.detail !== undefined)
    },
    [onOpenFile, onToggleDirectory],
  )

  const handleRowKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, row: FileTreeRow) => {
      if (row.kind !== 'dir') return
      if (event.key === 'ArrowRight' && !row.expanded) {
        event.preventDefault()
        onToggleDirectory(row.path)
      } else if (event.key === 'ArrowLeft' && row.expanded) {
        event.preventDefault()
        onToggleDirectory(row.path)
      }
    },
    [onToggleDirectory],
  )

  const noRoot = workspaceRoot === null
  // `rootLoading` is true only after the read starts; reserving the loading state for `!rootLoaded`
  // as well means the first frame after a workspace switch is the loading line, not a blank list.
  const initialLoading = !noRoot && !rootLoaded && rootError === null
  const blockingError = !noRoot && !rootLoaded && rootError !== null
  const emptyTree = !noRoot && rootLoaded && rows.length === 0 && !searching
  // An answer for a different query is not this query's answer: while the debounce or the read is
  // in flight, the tree shows its loading line instead of the previous query's rows.
  const staleSearch = search.query !== query.trim()
  const searchLoading = searching && (staleSearch || search.phase === 'loading')
  const searchFailed = searching && !staleSearch && search.phase === 'error'
  const searchEmpty = searching && !staleSearch && !searchLoading && !searchFailed

  return (
    <section
      aria-label={copy.treeLabel}
      className="relative flex h-full min-h-0 min-w-0 flex-col"
    >
      <div className="shrink-0 px-2 pt-2 pb-1.5">
        <div className="relative">
          <Input
            value={query}
            onChange={onQueryChange}
            placeholder={copy.searchPlaceholder}
            aria-label={copy.searchLabel}
            leftIcon={<Search />}
            classNames={{
              field: 'h-8 rounded-lg',
              input: 'pr-8 text-xs',
              leftIcon: 'left-2.5',
            }}
          />
          {query.length > 0 ? (
            <button
              type="button"
              aria-label={copy.clearSearch}
              title={copy.clearSearch}
              onClick={() => onQueryChange('')}
              className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      {noRoot ? (
        <TreeNotice
          icon={<Files aria-hidden="true" className="size-5" />}
          title={copy.noWorkspace}
          description={copy.noWorkspaceHint}
        />
      ) : blockingError ? (
        <TreeNotice
          icon={<CircleAlert aria-hidden="true" className="size-5 text-destructive" />}
          title={copy.readFailed}
          description={rootError}
          action={
            <Button variant="outline" size="sm" onClick={onRefresh}>
              {copy.retry}
            </Button>
          }
        />
      ) : initialLoading ? (
        <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
          <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
          <span role="status">{copy.loading}</span>
        </div>
      ) : searchLoading ? (
        <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
          <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
          <span role="status">{copy.searching}</span>
        </div>
      ) : searchFailed ? (
        <TreeNotice
          icon={<CircleAlert aria-hidden="true" className="size-5 text-destructive" />}
          title={copy.searchFailed}
          description={search.error}
          action={
            <Button variant="outline" size="sm" onClick={onRetrySearch}>
              {copy.retry}
            </Button>
          }
        />
      ) : searchEmpty && rows.length === 0 ? (
        <TreeNotice
          icon={<Search aria-hidden="true" className="size-5" />}
          title={copy.searchEmpty}
        />
      ) : emptyTree ? (
        <TreeNotice icon={<Files aria-hidden="true" className="size-5" />} title={copy.emptyWorkspace} />
      ) : (
        <>
          {rootError !== null ? (
            <p
              role="alert"
              className="mx-2 mb-1 flex items-center gap-1.5 rounded-md border border-destructive/40 px-2 py-1 text-[11px] text-destructive"
            >
              <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate" title={rootError}>
                {copy.readFailed}
              </span>
            </p>
          ) : null}
          {revealFailed ? (
            <p
              role="alert"
              className="mx-2 mb-1 flex items-center gap-1.5 rounded-md border border-destructive/40 px-2 py-1 text-[11px] text-destructive"
            >
              <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{copy.revealFailed}</span>
            </p>
          ) : null}
          {menuNotice !== null ? (
            <p
              role="alert"
              className="mx-2 mb-1 flex items-center gap-1.5 rounded-md border border-destructive/40 px-2 py-1 text-[11px] text-destructive"
            >
              <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{menuNotice}</span>
            </p>
          ) : null}
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1">
            <div
              role="tree"
              aria-label={copy.treeLabel}
              aria-busy={refreshing || rootLoading}
              className="relative w-full"
              style={{ height: rowVirtualizer.getTotalSize() }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const row = rows[virtualRow.index]
                if (row === undefined) return null
                return (
                  <div
                    key={virtualRow.key}
                    className="absolute inset-x-0 top-0"
                    style={{
                      height: virtualRow.size,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <TreeRow
                      row={row}
                      workspaceRoot={workspaceRoot}
                      selected={row.path === selectedPath}
                      onActivate={handleRow}
                      onKeyDown={handleRowKeyDown}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        setMenuNotice(null)
                        setMenu({
                          row,
                          x: event.clientX,
                          y: event.clientY,
                        })
                      }}
                    />
                  </div>
                )
              })}
            </div>
          </div>
          {searching && search.truncated ? (
            <p className="shrink-0 px-3 py-1.5 text-[11px] text-muted-foreground">
              {copy.searchTruncated}
            </p>
          ) : null}
        </>
      )}
      {/* The row's own menu, opened at the pointer by a right-click: the same beUI popover and rows
          the rail's menus use, anchored to a zero-size trigger at the click. The popover owns
          dismissal (the next press anywhere, Escape) and flips above the pointer near the floor. */}
      {menu !== null ? (
        <MorphPopover
          key={`${menu.row.path}:${menu.x}:${menu.y}`}
          open
          onOpenChange={(open) => {
            if (!open) closeMenu()
          }}
          className="fixed size-0"
        >
          <MorphPopoverTrigger>
            <span
              className="pointer-events-none fixed size-0"
              style={{ left: menu.x, top: menu.y }}
            />
          </MorphPopoverTrigger>
          <MorphPopoverContent
            side="bottom"
            align="start"
            sideOffset={2}
            radius={12}
            className="w-56 p-1.5"
            onOpenAutoFocus={(content) => content.querySelector<HTMLElement>('button')?.focus()}
          >
            {menu.row.kind === 'file' ? (
              <ResourceMenuAction icon={AtSign} onSelect={() => void addToConversation(menu.row.path)}>
                {copy.addToConversation}
              </ResourceMenuAction>
            ) : null}
            <ResourceMenuAction
              icon={FolderOpen}
              onSelect={() => {
                onRevealEntry(menu.row.path)
                closeMenu()
              }}
            >
              {copy.reveal}
            </ResourceMenuAction>
            <ResourceMenuAction icon={Copy} onSelect={() => void copyEntryPath(menu.row.path)}>
              {copy.copyPath}
            </ResourceMenuAction>
          </MorphPopoverContent>
        </MorphPopover>
      ) : null}
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </section>
  )
}

function TreeRow({
  row,
  workspaceRoot,
  selected,
  onActivate,
  onKeyDown,
  onContextMenu,
}: {
  row: FileTreeRow
  workspaceRoot: string | null
  selected: boolean
  onActivate: (row: FileTreeRow) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, row: FileTreeRow) => void
  onContextMenu: (event: React.MouseEvent<HTMLButtonElement>) => void
}) {
  const copy = useCopy(FILE_PANEL_COPY)
  const display = row.kind === 'file' ? describeFile(row.path) : null
  const Icon = display?.icon
  const isSearchResult = row.detail !== undefined
  const movedRef = useRef(false)

  // The pointer drag (`state/file-drag-store.ts`): a file can be dragged from this tree into the
  // composer. HTML5 drag-and-drop cannot do it here — the window has Tauri's file-drop channel on,
  // which is what makes Explorer and VS Code drops carry paths — so the row runs the gesture itself.
  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (row.kind !== 'file' || workspaceRoot === null) return
    if (event.button !== 0 || (event.pointerType !== 'mouse' && event.pointerType !== 'pen')) return
    movedRef.current = false
    const payload = { path: absolutePathOf(workspaceRoot, row.path), name: row.name }
    const start = { x: event.clientX, y: event.clientY }
    let moved = false

    const finish = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    const onMove = (move: PointerEvent) => {
      if (!moved) {
        if (Math.abs(move.clientX - start.x) + Math.abs(move.clientY - start.y) < 4) return
        moved = true
        movedRef.current = true
        beginFileDrag(payload, { x: move.clientX, y: move.clientY })
        document.body.style.cursor = 'grabbing'
        document.body.style.userSelect = 'none'
      }
      moveFileDrag({ x: move.clientX, y: move.clientY })
    }
    const onUp = (up: PointerEvent) => {
      finish()
      if (!moved) return
      up.preventDefault()
      finishFileDrag({ x: up.clientX, y: up.clientY })
    }
    const onCancel = () => {
      finish()
      cancelFileDrag()
    }
    const onKey = (key: KeyboardEvent) => {
      if (key.key !== 'Escape') return
      finish()
      cancelFileDrag()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey)
  }

  return (
    <button
      type="button"
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={row.kind === 'dir' ? row.expanded : undefined}
      aria-selected={selected}
      title={row.path}
      draggable={false}
      onPointerDown={handlePointerDown}
      onContextMenu={onContextMenu}
      onClick={() => {
        // A drag that ended back over its own row must not also open the file.
        if (movedRef.current) {
          movedRef.current = false
          return
        }
        onActivate(row)
      }}
      onKeyDown={(event) => onKeyDown(event, row)}
      style={{ paddingLeft: 6 + row.depth * 12 }}
      className={cn(
        'flex w-full items-center gap-1.5 rounded-md pr-1.5 text-left text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
        isSearchResult ? 'h-9' : 'h-7',
        selected
          ? 'bg-muted text-foreground'
          : 'text-foreground/85 hover:bg-muted/55 hover:text-foreground',
      )}
    >
      {row.kind === 'dir' ? (
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform',
            row.expanded && 'rotate-90',
          )}
        />
      ) : Icon !== undefined ? (
        <Icon aria-hidden="true" className={cn('size-3.5 shrink-0', display?.iconClassName)} />
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{row.name}</span>
        {isSearchResult ? (
          <span className="truncate text-[10px] leading-3 text-muted-foreground/70">
            {row.detail === '.' ? copy.root : row.detail}
          </span>
        ) : null}
      </span>
      {row.loading ? (
        <LoaderCircle aria-hidden="true" className="size-3 shrink-0 animate-spin text-muted-foreground" />
      ) : row.error !== null ? (
        // The desktop's own message rides behind this side's sentence; the title keeps both one
        // hover away without making the row itself taller.
        <span
          title={`${copy.directoryFailed} ${row.error ?? ''}`.trim()}
          className="shrink-0"
        >
          <CircleAlert aria-hidden="true" className="size-3 text-destructive" />
        </span>
      ) : null}
    </button>
  )
}

function TreeNotice({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode
  title: string
  description?: string | null
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-muted-foreground">
      {icon}
      <p className="text-xs font-medium text-foreground">{title}</p>
      {description ? <p className="text-[11px] leading-4 break-words">{description}</p> : null}
      {action}
    </div>
  )
}
