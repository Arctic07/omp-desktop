/**
 * The file panel's state: one lazily loaded tree, one path search, one preview.
 *
 * The desktop owns the filesystem (`api/workspace.ts` → `src-tauri/src/services/workspace.rs`).
 * This hook owns the panel's half: which directories have been read, which are open, which file is
 * selected, the answer the reader is currently looking at, and the tokens that keep a stale answer
 * off the screen.
 *
 * Bounds: every directory read, search and preview is bounded on the Rust side. On this side the
 * tree holds only the directories this panel has opened (the root at first, then one per expanded
 * folder), the search holds one page of paths, and the preview holds one file. Everything is
 * released when the tab closes, because the tab's panel is the only owner.
 *
 * The workspace watch (`right-sidebar.tsx`) bumps one window-wide revision; `noteChange` folds it
 * into a single quiet refresh of the visible tree and the selected file. A change that arrives
 * while the tab is hidden is remembered and served when the tab is shown again.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  listWorkspaceEntries,
  readWorkspaceFile,
  searchWorkspacePaths,
  writeWorkspaceFile,
  type WorkspaceEntry,
  type WorkspaceFileRead,
} from '@/api/workspace'
import { joinRelativePath } from '@/lib/file-path'
import { workspaceChangeRevision } from '@/state/workspace-watch-store'

/** The root's own path in every command; the desktop resolves it against the workspace root. */
const ROOT = '.'

/** One page of path matches, the same ceiling the composer's `@` picker uses. */
const SEARCH_RESULT_LIMIT = 100
/** A keystroke is not a query yet: wait long enough for a word to be typed. */
const SEARCH_DEBOUNCE_MS = 180
/** Coalesce the watch's reports; one save burst should cost one refresh. */
const REFRESH_DEBOUNCE_MS = 180
/** Directory reads in one refresh wave; enough to feel parallel without flooding the IPC. */
const REFRESH_CONCURRENCY = 4

export interface FileTreeRow {
  /** Workspace-relative, `/`-separated; unique among rows. */
  path: string
  name: string
  kind: 'dir' | 'file'
  depth: number
  expanded: boolean
  loading: boolean
  error: string | null
  /** For a search result, the directory above the leaf; absent on tree rows. */
  detail?: string
}

interface DirectoryState {
  entries: readonly WorkspaceEntry[]
  loaded: boolean
  loading: boolean
  error: string | null
}

const EMPTY_DIRECTORY: DirectoryState = {
  entries: [],
  loaded: false,
  loading: false,
  error: null,
}

type FileContentPhase = 'idle' | 'loading' | 'ready' | 'error'

/**
 * The text one open file holds, as the editor sees it.
 *
 * `draft` and `baseline` are both line-feed normalised: a textarea hands line breaks back as `\n`,
 * so a CRLF file would otherwise read as changed the moment it is opened and would be rewritten with
 * the other platform's line endings on the first save. `eol` is what the file itself uses, and the
 * save converts back to it.
 */
export interface FileContentState {
  phase: FileContentPhase
  /** The path this answer belongs to, or null before the first open. */
  path: string | null
  /** Kept while a quiet refresh runs, so the reader does not lose the page. */
  read: WorkspaceFileRead | null
  error: string | null
  /** The editor's text for a text file; null for every other kind. */
  draft: string | null
  /** The text the file held when it was read or last saved, line-feed normalised. */
  baseline: string | null
  /** The line ending the file uses; a save converts the draft back to it. */
  eol: '\n' | '\r\n'
  /** Whether a text file is open in the editor rather than in its highlighted read view. */
  editing: boolean
}

const EMPTY_CONTENT: FileContentState = {
  phase: 'idle',
  path: null,
  read: null,
  error: null,
  draft: null,
  baseline: null,
  eol: '\n',
  editing: false,
}

export type FileSavePhase = 'idle' | 'saving' | 'saved' | 'error'

/** The last save attempt, for the header and the failure line. */
export interface FileSaveState {
  phase: FileSavePhase
  error: string | null
}

const EMPTY_SAVE: FileSaveState = { phase: 'idle', error: null }

type FileSearchPhase = 'idle' | 'loading' | 'ready' | 'error'

export interface FileSearchState {
  phase: FileSearchPhase
  /** The trimmed query this answer belongs to. */
  query: string
  paths: readonly string[]
  truncated: boolean
  error: string | null
}

const EMPTY_SEARCH: FileSearchState = {
  phase: 'idle',
  query: '',
  paths: [],
  truncated: false,
  error: null,
}

export interface UseFilePanelOptions {
  /** The workspace root the tab was opened on, or null when it had none. */
  workspaceRoot: string | null
  /** Whether this panel is the one on screen: a hidden one defers its catch-up refresh. */
  active: boolean
}

/** The desktop's own sentence for a failed read or write, or the caller's when it gave none. */
export function fileErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  if (typeof error === 'string' && error.length > 0) return error
  if (error instanceof Error && error.message.length > 0) return error.message
  return fallback
}

/** `src/components` → `src` → root, outermost first. The path itself is not included. */
function ancestorsOf(path: string): string[] {
  const segments = path.split('/')
  const directories: string[] = []
  for (let index = 1; index < segments.length; index += 1) {
    directories.push(segments.slice(0, index).join('/'))
  }
  return directories
}

function directoryWith(
  current: ReadonlyMap<string, DirectoryState>,
  path: string,
  patch: Partial<DirectoryState>,
): Map<string, DirectoryState> {
  const next = new Map(current)
  next.set(path, { ...(next.get(path) ?? EMPTY_DIRECTORY), ...patch })
  return next
}

function normaliseEntry(entry: WorkspaceEntry): WorkspaceEntry {
  return {
    name: entry.name,
    kind: entry.kind === 'dir' ? 'dir' : 'file',
    size: entry.size,
  }
}

export function useFilePanel({ workspaceRoot, active }: UseFilePanelOptions) {
  const [directories, setDirectories] = useState<ReadonlyMap<string, DirectoryState>>(
    () => new Map(),
  )
  const directoriesRef = useRef<ReadonlyMap<string, DirectoryState>>(directories)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const expandedRef = useRef<ReadonlySet<string>>(expanded)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [query, setQueryState] = useState('')
  const queryRef = useRef(query)
  const [search, setSearchState] = useState<FileSearchState>(EMPTY_SEARCH)
  const [content, setContentState] = useState<FileContentState>(EMPTY_CONTENT)
  const contentRef = useRef<FileContentState>(EMPTY_CONTENT)
  const [save, setSaveState] = useState<FileSaveState>(EMPTY_SAVE)
  const saveRef = useRef<FileSaveState>(EMPTY_SAVE)
  const savingRef = useRef(false)
  const selectedPathRef = useRef<string | null>(null)
  const [searchNonce, setSearchNonce] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  /** Bumped when the root changes; every answer from the previous root is stale. */
  const generationRef = useRef(0)
  const directoryRequestsRef = useRef<Map<string, number>>(new Map())
  const searchRequestRef = useRef(0)
  const readRequestRef = useRef(0)
  const refreshTimerRef = useRef<number | null>(null)
  const refreshInFlightRef = useRef(false)
  const pendingRefreshRef = useRef(false)
  const servedRevisionRef = useRef(0)
  const activeRef = useRef(active)
  useEffect(() => {
    activeRef.current = active
  }, [active])

  const writeDirectories = useCallback((next: Map<string, DirectoryState>) => {
    directoriesRef.current = next
    setDirectories(next)
  }, [])

  const writeExpanded = useCallback((next: Set<string>) => {
    expandedRef.current = next
    setExpanded(next)
  }, [])

  const writeSearch = useCallback((next: FileSearchState) => {
    setSearchState(next)
  }, [])

  const writeContent = useCallback((next: FileContentState) => {
    contentRef.current = next
    setContentState(next)
  }, [])

  const writeSave = useCallback((next: FileSaveState) => {
    saveRef.current = next
    setSaveState(next)
  }, [])

  const setQuery = useCallback(
    (next: string) => {
      queryRef.current = next
      setQueryState(next)
      // Clearing the field clears the answer in the same event, so the effect below never has to
      // write a state it already knows during a render pass of its own.
      if (next.trim() === '') {
        searchRequestRef.current += 1
        writeSearch(EMPTY_SEARCH)
      }
    },
    [writeSearch],
  )

  const loadDirectory = useCallback(
    async (path: string, options?: { force?: boolean; quiet?: boolean }): Promise<boolean> => {
      if (workspaceRoot === null) return false
      const generation = generationRef.current
      const current = directoriesRef.current.get(path) ?? EMPTY_DIRECTORY
      if (options?.force !== true && (current.loading || current.loaded)) {
        return current.loaded
      }

      const token = (directoryRequestsRef.current.get(path) ?? 0) + 1
      directoryRequestsRef.current.set(path, token)
      // A quiet refresh of a directory that already has rows leaves them on screen; the new answer
      // replaces them in one step, so a saved file does not blink the tree.
      writeDirectories(
        directoryWith(directoriesRef.current, path, {
          loading: options?.quiet !== true || !current.loaded,
          error: null,
        }),
      )

      try {
        const entries = await listWorkspaceEntries(workspaceRoot, path)
        if (
          generationRef.current !== generation ||
          directoryRequestsRef.current.get(path) !== token
        ) {
          return false
        }
        writeDirectories(
          directoryWith(directoriesRef.current, path, {
            entries: entries.map(normaliseEntry),
            loaded: true,
            loading: false,
            error: null,
          }),
        )
        return true
      } catch (error: unknown) {
        if (
          generationRef.current !== generation ||
          directoryRequestsRef.current.get(path) !== token
        ) {
          return false
        }
        writeDirectories(
          directoryWith(directoriesRef.current, path, {
            loading: false,
            error: fileErrorMessage(error, 'The directory could not be read.'),
          }),
        )
        return false
      }
    },
    [workspaceRoot, writeDirectories],
  )

  /**
   * Put the named directories on screen: expand them and re-read each, in the order given.
   *
   * The re-read is deliberate — a search answer or a transcript path can name a branch whose cached
   * listing predates it (a file created while the branch was collapsed), and revealing means the
   * rows are there, not that they were there once. Nothing is expanded when the list is empty.
   */
  const expandTo = useCallback(
    (directories: readonly string[]) => {
      if (directories.length === 0) return
      const next = new Set(expandedRef.current)
      for (const directory of directories) next.add(directory)
      writeExpanded(next)
      const generation = generationRef.current
      void (async () => {
        for (const directory of directories) {
          if (generationRef.current !== generation) return
          await loadDirectory(directory, { force: true, quiet: true })
        }
      })()
    },
    [loadDirectory, writeExpanded],
  )

  const readFile = useCallback(
    async (path: string) => {
      if (workspaceRoot === null) return
      const generation = generationRef.current
      const token = ++readRequestRef.current
      selectedPathRef.current = path
      setSelectedPath(path)
      const previous = contentRef.current
      // Re-reading the file already on screen keeps the reader's draft; a different path is a new
      // editor and starts from what the desktop answers.
      const sameFile = previous.path === path
      if (!sameFile) writeSave(EMPTY_SAVE)
      writeContent({
        phase: 'loading',
        path,
        read: sameFile ? previous.read : null,
        error: null,
        draft: sameFile ? previous.draft : null,
        baseline: sameFile ? previous.baseline : null,
        eol: sameFile ? previous.eol : '\n',
        editing: sameFile ? previous.editing : false,
      })

      try {
        const read = await readWorkspaceFile(workspaceRoot, path)
        if (generationRef.current !== generation || readRequestRef.current !== token) return
        if (read.kind === 'directory') {
          // A path a transcript printed can name a folder. It is opened where folders live — the
          // tree expands to it, the row is the selection — and the preview says what it is instead
          // of drawing an empty read. A folder has no draft, so nothing here is editable or saved.
          expandTo([...ancestorsOf(path), path])
          writeContent({
            phase: 'ready',
            path,
            read,
            error: null,
            draft: null,
            baseline: null,
            eol: '\n',
            editing: false,
          })
          return
        }
        const text = read.kind === 'text' ? (read.content ?? '') : null
        // Line feeds are the shape both sides compare in; the file's own ending is only used again
        // on the way out (see the save below).
        const normalised = text === null ? null : text.replaceAll('\r\n', '\n')
        // A refresh must not throw away edits: when the draft differs from its baseline it belongs
        // to the reader, and only the disk snapshot under it moves. With no edits the answer is
        // what the editor should show.
        const keepDraft =
          sameFile &&
          normalised !== null &&
          previous.draft !== null &&
          previous.baseline !== null &&
          previous.draft !== previous.baseline
        writeContent({
          phase: 'ready',
          path,
          read,
          error: null,
          draft: keepDraft ? previous.draft : normalised,
          baseline: keepDraft ? previous.baseline : normalised,
          eol: text !== null && text.includes('\r\n') ? '\r\n' : '\n',
          // A refresh of the file already on screen keeps the reader's mode; every newly opened
          // text file starts in the preview, where it is highlighted. Editing is the pencil's
          // explicit choice — starting in the raw textarea is what made the file panel look
          // unhighlighted no matter what the highlighter did (2026-10-24).
          editing: sameFile && previous.draft !== null && previous.editing,
        })
      } catch (error: unknown) {
        if (generationRef.current !== generation || readRequestRef.current !== token) return
        writeContent({
          phase: 'error',
          path,
          read: sameFile ? previous.read : null,
          error: fileErrorMessage(error, 'The file could not be read.'),
          draft: sameFile ? previous.draft : null,
          baseline: sameFile ? previous.baseline : null,
          eol: sameFile ? previous.eol : '\n',
          editing: sameFile ? previous.editing : false,
        })
      }
    },
    [expandTo, workspaceRoot, writeContent, writeSave],
  )

  /** The editor's own text. A write resets the "saved" note the header shows. */
  const setDraft = useCallback(
    (draft: string) => {
      const current = contentRef.current
      if (current.draft === null || current.draft === draft) return
      writeContent({ ...current, draft })
      if (saveRef.current.phase !== 'idle') writeSave(EMPTY_SAVE)
    },
    [writeContent, writeSave],
  )

  const toggleEditing = useCallback(() => {
    const current = contentRef.current
    if (current.draft === null) return
    writeContent({ ...current, editing: !current.editing })
  }, [writeContent])

  /**
   * Write the draft back to the file it came from.
   *
   * Resolves `true` when the file now holds every character the reader had when the call was made —
   * including "there was nothing to write". Text typed while the write is in flight stays dirty: the
   * baseline moves to the written snapshot, not to whatever the draft has become.
   */
  const saveDraft = useCallback(async (): Promise<boolean> => {
    const current = contentRef.current
    if (workspaceRoot === null || current.path === null) return false
    if (current.draft === null || current.baseline === null) return false
    if (current.draft === current.baseline) return true
    if (savingRef.current) return false
    const path = current.path
    const draft = current.draft
    const content =
      current.eol === '\r\n' ? draft.replaceAll('\n', '\r\n') : draft
    savingRef.current = true
    // A read already on its way would answer with the file as it was before this write.
    readRequestRef.current += 1
    writeSave({ phase: 'saving', error: null })
    try {
      await writeWorkspaceFile(workspaceRoot, path, content)
      const latest = contentRef.current
      if (latest.path === path && latest.read !== null) {
        writeContent({
          ...latest,
          read: {
            ...latest.read,
            content,
            size: new TextEncoder().encode(content).length,
          },
          baseline: draft,
        })
      }
      writeSave({ phase: 'saved', error: null })
      return true
    } catch (error: unknown) {
      if (contentRef.current.path === path) {
        writeSave({
          phase: 'error',
          error: fileErrorMessage(error, 'The file could not be saved.'),
        })
      }
      return false
    } finally {
      savingRef.current = false
    }
  }, [workspaceRoot, writeContent, writeSave])

  const revealFile = useCallback(
    (path: string) => expandTo(ancestorsOf(path)),
    [expandTo],
  )

  const openFile = useCallback(
    (path: string, reveal = false) => {
      const current = contentRef.current
      const dirty =
        current.path !== path &&
        current.draft !== null &&
        current.baseline !== null &&
        current.draft !== current.baseline
      const open = () => {
        if (reveal) revealFile(path)
        void readFile(path)
      }
      if (!dirty) {
        open()
        return
      }
      // Moving to another file must not drop what the reader wrote: save first, and stay on the
      // file whose save failed — the error belongs to the text still on screen.
      void saveDraft().then((saved) => {
        if (saved) open()
      })
    },
    [readFile, revealFile, saveDraft],
  )

  const toggleDirectory = useCallback(
    (path: string) => {
      if (expandedRef.current.has(path)) {
        const next = new Set(expandedRef.current)
        next.delete(path)
        writeExpanded(next)
        return
      }
      const next = new Set(expandedRef.current)
      next.add(path)
      writeExpanded(next)
      // Expanding is also the moment to ask for the directory again: a cache from a collapsed
      // branch is allowed to be old, and the reader has just said they want to see it now.
      const current = directoriesRef.current.get(path)
      if (current?.loading !== true) void loadDirectory(path, { force: true, quiet: true })
    },
    [loadDirectory, writeExpanded],
  )

  /** One refresh of the directories on screen (or every loaded one, when the reader asked). */
  const refreshNow = useCallback(
    async (scope: 'watch' | 'manual') => {
      if (workspaceRoot === null) return
      if (refreshInFlightRef.current) {
        pendingRefreshRef.current = true
        return
      }
      refreshInFlightRef.current = true
      if (scope === 'manual') setRefreshing(true)
      const generation = generationRef.current
      const paths =
        scope === 'manual'
          ? new Set<string>([ROOT, ...directoriesRef.current.keys()])
          : new Set<string>([ROOT, ...expandedRef.current])
      const queue = [...paths]
      try {
        for (let index = 0; index < queue.length; index += REFRESH_CONCURRENCY) {
          if (generationRef.current !== generation) return
          await Promise.all(
            queue
              .slice(index, index + REFRESH_CONCURRENCY)
              .map((path) => loadDirectory(path, { force: true, quiet: true })),
          )
        }
        if (generationRef.current !== generation) return
        const selected = selectedPathRef.current
        if (selected !== null) await readFile(selected)
        if (queryRef.current.trim() !== '') setSearchNonce((current) => current + 1)
      } finally {
        refreshInFlightRef.current = false
        if (generationRef.current === generation) {
          if (scope === 'manual') setRefreshing(false)
          if (pendingRefreshRef.current) {
            pendingRefreshRef.current = false
            if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current)
            refreshTimerRef.current = window.setTimeout(() => {
              refreshTimerRef.current = null
              void refreshNow('watch')
            }, REFRESH_DEBOUNCE_MS)
          }
        }
      }
    },
    [loadDirectory, readFile, workspaceRoot],
  )

  const scheduleRefresh = useCallback(() => {
    if (!activeRef.current) {
      pendingRefreshRef.current = true
      return
    }
    if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current)
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null
      void refreshNow('watch')
    }, REFRESH_DEBOUNCE_MS)
  }, [refreshNow])

  /** Fold one workspace-watch revision into a refresh; repeated reports of one tree cost one read. */
  const noteChange = useCallback(
    (revision: number) => {
      if (revision === servedRevisionRef.current) return
      servedRevisionRef.current = revision
      scheduleRefresh()
    },
    [scheduleRefresh],
  )

  const refresh = useCallback(() => {
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = null
    }
    void refreshNow('manual')
  }, [refreshNow])

  const retrySearch = useCallback(() => {
    const trimmed = queryRef.current.trim()
    if (trimmed !== '') {
      writeSearch({ phase: 'loading', query: trimmed, paths: [], truncated: false, error: null })
    }
    setSearchNonce((current) => current + 1)
  }, [writeSearch])

  const retryContent = useCallback(() => {
    const path = contentRef.current.path
    if (path !== null) void readFile(path)
  }, [readFile])

  // A new root is a new tree: drop every cached directory, selection, search and preview before
  // reading the root again. The generation bump makes every answer that is still in flight stale.
  useEffect(() => {
    generationRef.current += 1
    directoryRequestsRef.current.clear()
    searchRequestRef.current += 1
    readRequestRef.current += 1
    servedRevisionRef.current = workspaceChangeRevision()
    pendingRefreshRef.current = false
    refreshInFlightRef.current = false
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = null
    }
    directoriesRef.current = new Map()
    setDirectories(directoriesRef.current)
    expandedRef.current = new Set()
    setExpanded(expandedRef.current)
    selectedPathRef.current = null
    setSelectedPath(null)
    queryRef.current = ''
    setQueryState('')
    writeSearch(EMPTY_SEARCH)
    writeContent(EMPTY_CONTENT)
    writeSave(EMPTY_SAVE)
    savingRef.current = false
    if (workspaceRoot !== null) void loadDirectory(ROOT)
    return () => {
      generationRef.current += 1
    }
  }, [workspaceRoot, loadDirectory, writeContent, writeSearch, writeSave])

  // The search runs only while the query is non-empty. The timer says a keystroke is not a query
  // yet; the token says an answer that was already on its way is no longer the answer.
  useEffect(() => {
    const trimmed = query.trim()
    if (workspaceRoot === null || trimmed === '') {
      searchRequestRef.current += 1
      return
    }
    const token = ++searchRequestRef.current
    const generation = generationRef.current
    // No loading write here: a different `query` in the search state is already "an answer for
    // another query", which the tree draws as its loading line. A retry writes `loading` itself.
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await searchWorkspacePaths(workspaceRoot, trimmed, SEARCH_RESULT_LIMIT)
          if (token !== searchRequestRef.current || generation !== generationRef.current) return
          writeSearch({
            phase: 'ready',
            query: trimmed,
            paths: result.paths,
            truncated: result.truncated,
            error: null,
          })
        } catch (error: unknown) {
          if (token !== searchRequestRef.current || generation !== generationRef.current) return
          writeSearch({
            phase: 'error',
            query: trimmed,
            paths: [],
            truncated: false,
            error: fileErrorMessage(error, 'The path search failed.'),
          })
        }
      })()
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      if (searchRequestRef.current === token) searchRequestRef.current += 1
    }
  }, [query, searchNonce, workspaceRoot, writeSearch])

  // A change report that arrived while the tab was hidden is served when it is shown again.
  const wasActiveRef = useRef(active)
  useEffect(() => {
    if (active === wasActiveRef.current) return
    wasActiveRef.current = active
    if (!active || !pendingRefreshRef.current) return
    pendingRefreshRef.current = false
    scheduleRefresh()
  }, [active, scheduleRefresh])

  useEffect(
    () => () => {
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current)
    },
    [],
  )

  const rows = useMemo<FileTreeRow[]>(() => {
    const trimmed = query.trim()
    if (trimmed !== '') {
      // While a new query is in its debounce, the previous answer is not this query's answer.
      const paths = search.query === trimmed ? search.paths : []
      return paths.map((path) => {
        const cut = path.lastIndexOf('/')
        return {
          path,
          name: cut < 0 ? path : path.slice(cut + 1),
          kind: 'file',
          depth: 0,
          expanded: false,
          loading: false,
          error: null,
          detail: cut <= 0 ? ROOT : path.slice(0, cut),
        }
      })
    }

    const next: FileTreeRow[] = []
    const append = (directory: string, depth: number) => {
      const state = directories.get(directory)
      for (const entry of state?.entries ?? []) {
        const path = joinRelativePath(directory, entry.name)
        const directoryEntry = entry.kind === 'dir'
        const isExpanded = directoryEntry && expanded.has(path)
        const child = directoryEntry ? directories.get(path) : undefined
        next.push({
          path,
          name: entry.name,
          kind: directoryEntry ? 'dir' : 'file',
          depth,
          expanded: isExpanded,
          loading: child?.loading ?? false,
          error: child?.error ?? null,
        })
        if (isExpanded) append(path, depth + 1)
      }
    }
    append(ROOT, 0)
    return next
  }, [directories, expanded, query, search.paths, search.query])

  const rootDirectory = directories.get(ROOT) ?? EMPTY_DIRECTORY

  return {
    rows,
    selectedPath,
    query,
    setQuery,
    search,
    retrySearch,
    content,
    /** The draft is the reader's text; it is dirty when it differs from what the file holds. */
    dirty:
      content.draft !== null &&
      content.baseline !== null &&
      content.draft !== content.baseline,
    save,
    setDraft,
    toggleEditing,
    saveDraft,
    retryContent,
    openFile,
    toggleDirectory,
    refresh,
    refreshing,
    rootLoaded: rootDirectory.loaded,
    rootLoading: rootDirectory.loading,
    rootError: rootDirectory.error,
    noteChange,
  }
}
