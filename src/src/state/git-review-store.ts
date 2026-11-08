/**
 * The git review panel's state: what the changed tree looks like, and what the actions on it do.
 *
 * The desktop owns git (`src-tauri/src/services/git/**`); this hook owns the panel's reading of it —
 * the request and action tokens that keep a stale answer off the screen, the deltas that update the
 * rows in place after a stage / unstage / discard, the quiet live refresh the workspace watch
 * triggers, and the two-step discard arming. It renders nothing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  commitWorkspace,
  discardWorkspaceFiles,
  draftCommitMessage,
  getWorkspaceReview,
  stageWorkspaceFiles,
  syncWorkspace,
  unstageWorkspaceFiles,
  type ReviewFile,
  type WorkspaceReview,
  type WorkspaceReviewDelta,
} from '@/api/git'
import { reviewActionPaths, stageActionPaths } from '@/state/git-review-paths'

/** How long a discard button stays armed before it gives up on the second press. */
const DISCARD_ARM_LIFETIME_MS = 4000

export type ReviewSection = 'staged' | 'unstaged'

/**
 * The key one discard button arms and reports under.
 *
 * `target` is what the button names: a file's own path, or `all` for a whole side. Both spellings
 * come from here so a button can only ever arm the action it performs — a section button that
 * armed under one file's key would take turns arming with that row's button instead of running.
 */
export function discardKeyOf(section: ReviewSection, target: string): string {
  return `discard:${section}:${target}`
}

/**
 * What the panel is showing, as one exclusive fact.
 *
 * `loading` is the first read of a workspace: nothing is held yet, so the wait's own line is all
 * the panel says. `content` covers both a settled list and a refresh over one — the rows stay and
 * a line above them says a read is running.
 */
export type ReviewPhase = 'no-workspace' | 'loading' | 'error' | 'content' | 'empty'

function sortedFiles(files: ReviewFile[]): ReviewFile[] {
  return [...files].sort((left, right) => left.path.localeCompare(right.path))
}

/** Where a workspace's expanded rows and its drafted message live, so switching roots restores them. */
interface ReviewMemory {
  expandedFiles: string[]
  commitMessage: string
}

const EMPTY_MEMORY: ReviewMemory = { expandedFiles: [], commitMessage: '' }

/** One entry per workspace root this panel instance has read. Released with the panel (unmount). */
const rootMemories = new Map<string, ReviewMemory>()

export interface UseGitReviewOptions {
  /** Whether this panel is on screen: a hidden one does not re-read for a change nobody sees. */
  active: boolean
  /** The workspace root the panel shows, or null while there is none. */
  workspaceRoot: string | null
}

export function useGitReview(options: UseGitReviewOptions) {
  return useGitReviewState(options)
}

function useGitReviewState({ active, workspaceRoot }: UseGitReviewOptions) {
  const [review, setReview] = useState<WorkspaceReview | null>(null)
  /** The workspace whose result `review` holds; a read of any other root starts from nothing. */
  const loadedRootRef = useRef<string | null>(null)
  /**
   * The commit HEAD pointed at when this panel last read its tree (`undefined` before the first
   * read, `null` on a repository with no commit). A read that answers a different one is a commit
   * — or a checkout — since the message box's text was written, so the text is dropped: it
   * described staged changes that the tree no longer holds, whichever panel or actor committed
   * them (2026-10-31).
   */
  const headRef = useRef<string | null | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [requestError, setRequestError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [commitLoading, setCommitLoading] = useState(false)
  const [syncLoading, setSyncLoading] = useState(false)
  const [draftLoading, setDraftLoading] = useState(false)
  /** The stage / unstage / discard / discard-all action in flight, named by its key. */
  const [activeAction, setActiveAction] = useState<string | null>(null)
  /** The rows this workspace has expanded, keyed `section:path` — nothing that moves with status. */
  const [expandedFiles, setExpandedFiles] = useState<ReadonlySet<string>>(new Set())
  /** Which discard button is armed: the next press on it performs what it names. */
  const [armedDiscard, setArmedDiscard] = useState<string | null>(null)
  /**
   * The file whose diff view is on screen. The row expansion is the inline preview; this is the
   * full view, one at a time.
   */
  const [selectedFile, setSelectedFile] = useState<ReviewFile | null>(null)
  /** Which of the two sections is drawn open; both default open. */
  const [openSections, setOpenSections] = useState<Record<ReviewSection, boolean>>({
    staged: true,
    unstaged: true,
  })

  const requestTokenRef = useRef(0)
  const actionTokenRef = useRef(0)
  /**
   * Bumped by every action's own delta. A read that started before the newest of them is answering
   * a tree that has since moved, so its answer is dropped rather than written over the rows the
   * action just wrote.
   */
  const deltaRevisionRef = useRef(0)
  /** A change the watch reported while git was busy; served on the action's falling edge. */
  const pendingRefreshRef = useRef(false)
  /** Which change revision has already been served, so one report costs one read. */
  const servedRevisionRef = useRef(0)
  const armTimerRef = useRef<number | undefined>(undefined)

  const root = workspaceRoot

  const apiErrorText = useCallback((error: unknown, fallback: string): string => {
    if (typeof error === 'object' && error !== null && 'message' in error) {
      const message = (error as { message?: unknown }).message
      if (typeof message === 'string' && message.length > 0) return message
    }
    if (typeof error === 'string' && error.length > 0) return error
    if (error instanceof Error && error.message.length > 0) return error.message
    return fallback
  }, [])

  const dropExpandedNotPresent = useCallback((current: WorkspaceReview) => {
    const present = new Set<string>()
    for (const file of current.stagedFiles) present.add(`staged:${file.path}`)
    for (const file of current.unstagedFiles) present.add(`unstaged:${file.path}`)
    setExpandedFiles((previous) => {
      const next = new Set([...previous].filter((key) => present.has(key)))
      return next.size === previous.size ? previous : next
    })
  }, [])

  const refresh = useCallback(
    async (quiet: boolean) => {
      const token = ++requestTokenRef.current
      setRequestError(null)

      if (root === null) {
        setReview(null)
        loadedRootRef.current = null
        setLoading(false)
        return
      }

      if (loadedRootRef.current !== root) {
        setReview(null)
        setExpandedFiles(new Set(rootMemories.get(root)?.expandedFiles ?? []))
        setCommitMessage(rootMemories.get(root)?.commitMessage ?? '')
        headRef.current = undefined
      }

      // The read answers for the tree as it was when it started: an action taken while it runs has
      // already written newer rows, so an answer from before that action is not written.
      const revision = deltaRevisionRef.current
      const quietRead = quiet && loadedRootRef.current === root
      if (!quietRead) setLoading(true)

      try {
        const result = await getWorkspaceReview(root)
        if (token !== requestTokenRef.current) return
        if (deltaRevisionRef.current === revision) {
          const head = result.head ?? null
          if (headRef.current !== undefined && headRef.current !== head) {
            // Something committed (or checked out) the tree this box's text was written against —
            // this panel's own commit, another conversation's panel, an agent or a terminal — and
            // the text is a description of changes the tree no longer holds.
            setCommitMessage('')
          }
          headRef.current = head
          setReview(result)
          loadedRootRef.current = root
          dropExpandedNotPresent(result)
        }
        if (!quietRead) setLoading(false)
      } catch (error: unknown) {
        if (token !== requestTokenRef.current) return
        // The error row above the kept rows reports the failure; discarding the rows here would
        // answer a failed read with a blank panel.
        setRequestError(apiErrorText(error, 'Unable to read git status'))
        if (!quietRead) setLoading(false)
      }
    },
    [apiErrorText, dropExpandedNotPresent, root],
  )

  /** The first read happens when the panel is shown with a root to read; a new root re-reads. */
  const initialRootRef = useRef<string | null>(null)
  useEffect(() => {
    if (!active) return
    if (root === initialRootRef.current) return
    initialRootRef.current = root
    void refresh(false)
  }, [active, refresh, root])

  /**
   * The catch-up when the panel becomes visible again.
   *
   * A hidden pane keeps its rows rather than re-reading for a reader who cannot see them; the
   * change it missed is still served, because the watch's report marks the read pending and the
   * `active` transition is the moment the pending read runs. The call is deferred one frame so the
   * transition itself renders first.
   */
  const wasActiveRef = useRef(active)
  useEffect(() => {
    if (active === wasActiveRef.current) return
    wasActiveRef.current = active
    if (!active) return
    const frame = requestAnimationFrame(() => void refresh(true))
    return () => cancelAnimationFrame(frame)
  }, [active, refresh])

  /** Remember where the reader was, under the root it belongs to. */
  useEffect(() => {
    if (root === null) return
    const memory = rootMemories.get(root) ?? { ...EMPTY_MEMORY, expandedFiles: [] }
    memory.commitMessage = commitMessage
    memory.expandedFiles = [...expandedFiles]
    rootMemories.set(root, memory)
  }, [commitMessage, expandedFiles, root])

  useEffect(
    () => () => {
      rootMemories.clear()
      if (armTimerRef.current !== undefined) window.clearTimeout(armTimerRef.current)
    },
    [],
  )

  /** Opens one file's diff view. The section travels with the row; the view itself needs only the file. */
  const openFile = useCallback((_section: ReviewSection, file: ReviewFile) => {
    setSelectedFile(file)
  }, [])

  const closeFile = useCallback(() => {
    setSelectedFile(null)
  }, [])

  const isSectionExpanded = useCallback(
    (section: ReviewSection) => openSections[section],
    [openSections],
  )

  const toggleSection = useCallback((section: ReviewSection) => {
    setOpenSections((previous) => ({ ...previous, [section]: !previous[section] }))
  }, [])

  const isFileExpanded = useCallback(
    (section: ReviewSection, file: ReviewFile) => expandedFiles.has(`${section}:${file.path}`),
    [expandedFiles],
  )

  const toggleFile = useCallback((section: ReviewSection, file: ReviewFile) => {
    const key = `${section}:${file.path}`
    setExpandedFiles((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  /** Applies one action's delta to the rows on screen, in place. */
  const applyDelta = useCallback(
    (paths: readonly string[], delta: WorkspaceReviewDelta) => {
      deltaRevisionRef.current += 1
      setReview((current) => {
        if (current === null) return current
        const requested = new Set(paths)
        const keeps = (file: ReviewFile) =>
          !requested.has(file.path) && (file.oldPath === undefined || !requested.has(file.oldPath))
        const stagedFiles = sortedFiles([
          ...current.stagedFiles.filter(keeps),
          ...delta.stagedFiles,
        ])
        const unstagedFiles = sortedFiles([
          ...current.unstagedFiles.filter(keeps),
          ...delta.unstagedFiles,
        ])
        return {
          ...current,
          stagedFiles,
          unstagedFiles,
          clean: current.truncated
            ? false
            : stagedFiles.length === 0 && unstagedFiles.length === 0,
        }
      })
      setRequestError(null)
    },
    [],
  )

  /** One git action that returns a delta, shared by stage, unstage and discard. */
  const runDeltaAction = useCallback(
    async (key: string, paths: readonly string[], run: () => Promise<WorkspaceReviewDelta>) => {
      if (root === null) return
      const token = ++actionTokenRef.current
      setActiveAction(key)
      setActionError(null)
      try {
        const delta = await run()
        if (token !== actionTokenRef.current) return
        applyDelta(paths, delta)
      } catch (error: unknown) {
        if (token !== actionTokenRef.current) return
        setActionError(apiErrorText(error, 'The git operation failed'))
        // The delta never came, so the rows are the ones this action was refused against. A row
        // whose file is gone - an untracked path something removed between the read and the click -
        // is exactly the state a re-read corrects, and without it the same dead row offers the same
        // failure until the panel is reopened.
        void refresh(true)
      } finally {
        if (token === actionTokenRef.current) setActiveAction(null)
      }
    },
    [apiErrorText, applyDelta, refresh, root],
  )

  const stageFile = useCallback(
    (file: ReviewFile) => {
      const paths = stageActionPaths([file])
      void runDeltaAction(`stage:${file.path}`, paths, () =>
        stageWorkspaceFiles(root ?? '', paths),
      )
    },
    [root, runDeltaAction],
  )

  const unstageFile = useCallback(
    (file: ReviewFile) => {
      const paths = reviewActionPaths([file])
      void runDeltaAction(`unstage:${file.path}`, paths, () =>
        unstageWorkspaceFiles(root ?? '', paths),
      )
    },
    [root, runDeltaAction],
  )

  const stageAll = useCallback(
    (files: readonly ReviewFile[]) => {
      const paths = stageActionPaths(files)
      if (paths.length === 0) return
      void runDeltaAction('stage:all', paths, () => stageWorkspaceFiles(root ?? '', paths))
    },
    [root, runDeltaAction],
  )

  const unstageAll = useCallback(
    (files: readonly ReviewFile[]) => {
      const paths = reviewActionPaths(files)
      if (paths.length === 0) return
      void runDeltaAction('unstage:all', paths, () => unstageWorkspaceFiles(root ?? '', paths))
    },
    [root, runDeltaAction],
  )

  const disarmDiscard = useCallback(() => {
    if (armTimerRef.current !== undefined) {
      window.clearTimeout(armTimerRef.current)
      armTimerRef.current = undefined
    }
    setArmedDiscard(null)
  }, [])

  const armDiscard = useCallback(
    (key: string) => {
      if (armTimerRef.current !== undefined) window.clearTimeout(armTimerRef.current)
      setArmedDiscard(key)
      armTimerRef.current = window.setTimeout(() => {
        armTimerRef.current = undefined
        setArmedDiscard(null)
      }, DISCARD_ARM_LIFETIME_MS)
    },
    [],
  )

  const isDiscardArmed = useCallback((key: string) => armedDiscard === key, [armedDiscard])

  /** One press arms, the next runs: the button that already names its target is the confirmation. */
  const requestDiscard = useCallback(
    (key: string, run: () => void) => {
      if (armedDiscard !== key) {
        if (activeAction !== null || commitLoading || syncLoading) return
        armDiscard(key)
        return
      }
      disarmDiscard()
      run()
    },
    [activeAction, armDiscard, armedDiscard, commitLoading, disarmDiscard, syncLoading],
  )

  /** One discard, named by the side it is on and the target its button names. */
  const discard = useCallback(
    (section: ReviewSection, target: string, paths: string[]) => {
      const key = discardKeyOf(section, target)
      requestDiscard(key, () => {
        void runDeltaAction(key, paths, () =>
          discardWorkspaceFiles(root ?? '', paths, section === 'staged'),
        )
      })
    },
    [requestDiscard, root, runDeltaAction],
  )

  /** Discards the files a row names: its own path, or the whole side when a caller passes more. */
  const discardFiles = useCallback(
    (section: ReviewSection, files: readonly ReviewFile[]) => {
      const paths = reviewActionPaths(files)
      if (root === null || paths.length === 0) return
      const target = files.length === 1 ? (files[0]?.path ?? 'all') : 'all'
      discard(section, target, paths)
    },
    [discard, root],
  )

  /**
   * Discards every file on one side — the section header's own button.
   *
   * The target is the side's `all`, never a file's path, so a side that happens to hold one file
   * still arms and runs through this button rather than through the row's.
   */
  const discardSection = useCallback(
    (section: ReviewSection, files: readonly ReviewFile[]) => {
      const paths = reviewActionPaths(files)
      if (root === null || paths.length === 0) return
      discard(section, 'all', paths)
    },
    [discard, root],
  )

  const gitBusy =
    activeAction !== null || commitLoading || syncLoading || draftLoading

  const commit = useCallback(async () => {
    if (root === null) return
    const message = commitMessage.trim()
    if (message.length === 0) return
    const token = ++actionTokenRef.current
    setCommitLoading(true)
    setActionError(null)
    try {
      await commitWorkspace(root, message)
    } catch (error: unknown) {
      if (token !== actionTokenRef.current) return
      setActionError(apiErrorText(error, 'Unable to commit workspace changes'))
      setCommitLoading(false)
      return
    }
    if (token !== actionTokenRef.current) return
    await refresh(false)
    if (token !== actionTokenRef.current) return
    setCommitMessage('')
    setCommitLoading(false)
  }, [apiErrorText, commitMessage, refresh, root])

  const draft = useCallback(async () => {
    if (root === null || gitBusy) return
    const headAtStart = headRef.current
    setDraftLoading(true)
    setActionError(null)
    try {
      const message = await draftCommitMessage(root)
      // A commit that landed while the model was drafting consumed the staged tree this answer
      // describes, so the answer would repopulate a box the commit had just cleared.
      if (headRef.current === headAtStart) setCommitMessage(message)
    } catch (error: unknown) {
      setActionError(apiErrorText(error, 'Unable to draft a commit message'))
    } finally {
      setDraftLoading(false)
    }
  }, [apiErrorText, gitBusy, root])

  const sync = useCallback(async () => {
    if (root === null || gitBusy) return
    const token = ++actionTokenRef.current
    setSyncLoading(true)
    setActionError(null)
    try {
      await syncWorkspace(root)
    } catch (error: unknown) {
      if (token !== actionTokenRef.current) return
      setActionError(apiErrorText(error, 'Unable to sync workspace changes'))
      setSyncLoading(false)
      return
    }
    if (token !== actionTokenRef.current) return
    await refresh(false)
    if (token !== actionTokenRef.current) return
    setSyncLoading(false)
  }, [apiErrorText, gitBusy, refresh, root])

  const phase = useMemo<ReviewPhase>(() => {
    if (root === null) return 'no-workspace'
    if (review !== null) return 'content'
    if (loading) return 'loading'
    if (requestError !== null) return 'error'
    return 'empty'
  }, [loading, requestError, review, root])

  const stagedCount = review?.stagedFiles.length ?? 0
  const changedCount = stagedCount + (review?.unstagedFiles.length ?? 0)
  const branch = review?.branch
  const syncCount = branch === undefined ? 0 : branch.ahead + branch.behind

  /**
   * The one action under the message box: commit while the tree holds changes, sync once it is
   * clean. The tree picks the verb, so the template never has to decide which of the two to offer.
   */
  const primaryKind: 'commit' | 'sync' = changedCount > 0 ? 'commit' : 'sync'
  const canCommit = stagedCount > 0 && commitMessage.trim().length > 0 && !gitBusy
  const canSync = branch !== undefined && !gitBusy
  const primaryBusy = primaryKind === 'commit' ? commitLoading : syncLoading
  const primaryDisabled = primaryKind === 'commit' ? !canCommit : !canSync

  /**
   * Serves a workspace-changed report the watch delivered.
   *
   * A hidden panel ignores the report — the watch is pointed at whichever tab is on screen, so the
   * revision may name another conversation's tree, and a panel nobody can see has no rows to keep
   * current. The `active` transition is where a hidden panel catches up (`refresh(true)`), so the
   * change is not lost.
   *
   * A change that arrived while git was busy waits for the action's falling edge — a read started
   * mid-action would answer the tree as it was before it and be dropped for it — so the panel hands
   * `changeRevision` in and this decides between serving now and marking it pending. One revision
   * number costs one read: repeated reports of the same tree are collapsed.
   */
  const noteChange = useCallback(
    (revision: number) => {
      if (!active) return
      if (revision === servedRevisionRef.current) return
      servedRevisionRef.current = revision
      if (loadedRootRef.current === null) return
      if (activeAction !== null || commitLoading || syncLoading) {
        pendingRefreshRef.current = true
        return
      }
      void refresh(true)
    },
    [active, activeAction, commitLoading, refresh, syncLoading],
  )

  /** Serves the change that arrived while git was busy, once the action's delta has landed. */
  useEffect(() => {
    if (activeAction !== null || commitLoading || syncLoading) return
    if (!pendingRefreshRef.current) return
    pendingRefreshRef.current = false
    if (loadedRootRef.current === null) return
    void refresh(true)
  }, [activeAction, commitLoading, refresh, syncLoading])

  return {
    review,
    phase,
    loading,
    requestError,
    actionError,
    changedCount,
    stagedCount,
    branch,
    syncCount,
    truncated: review?.truncated ?? false,
    commitMessage,
    setCommitMessage,
    commitLoading,
    syncLoading,
    draftLoading,
    gitBusy,
    primaryKind,
    primaryBusy,
    primaryDisabled,
    refresh,
    commit,
    draft,
    sync,
    isFileExpanded,
    toggleFile,
    openFile,
    closeFile,
    selectedFile,
    isSectionExpanded,
    toggleSection,
    stageFile,
    unstageFile,
    stageAll,
    unstageAll,
    discardFiles,
    discardSection,
    activeAction,
    isDiscardArmed,
    noteChange,
  }
}

export type GitReviewState = ReturnType<typeof useGitReview>
