/**
 * The workspace review's commands: read the changed tree, stage, unstage, discard, commit, sync,
 * and the engine's own commit-message draft.
 *
 * The desktop owns git (`src-tauri/src/services/git/**`): every function here is one command call,
 * typed against the `#[serde(rename)]` names in `src-tauri/src/models.rs`. The watch command and
 * the event it emits (`omp:workspace-changed`, `services/workspace_watch.rs`) are how the review
 * learns a file moved without the reader pressing refresh.
 */

import { call, subscribe } from '@/api/client'
import { COMMANDS, WORKSPACE_CHANGED_EVENT } from '@/api/types'
import type { UnlistenFn } from '@tauri-apps/api/event'

/* ------------------------------------------------------------- DTO (models.rs) */

/** One line of a patch hunk; `type` is the `#[serde(rename)]` of `line_type`. */
export interface ReviewLine {
  type: 'add' | 'del' | 'context' | string
  text: string
}

export interface ReviewHunk {
  header: string
  lines: ReviewLine[]
}

export type ReviewFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'

export interface ReviewFile {
  path: string
  oldPath?: string
  status: ReviewFileStatus
  additions: number
  deletions: number
  binary: boolean
  tooLarge: boolean
  hunks: ReviewHunk[]
}

/** How far the branch and its upstream have drifted, as git records it locally. */
export interface WorkspaceBranch {
  upstream: string
  ahead: number
  behind: number
}

/** One local branch, as the sidebar's branch picker lists it. */
export interface RepositoryBranch {
  name: string
  /** The branch's last commit time, in Unix seconds. */
  updatedAt: number
  subject: string
  author: string
  current: boolean
}

/** The sidebar's branch picker: the repository, where HEAD is, and its local branches. */
export interface WorkspaceBranches {
  repoName: string
  /** The checked-out branch; absent on a detached HEAD. */
  current?: string
  /** The short commit HEAD points at when it is detached. */
  detachedAt?: string
  /** How far the checked-out branch and its upstream have drifted. */
  sync?: WorkspaceBranch
  branches: RepositoryBranch[]
}

export interface WorkspaceReview {
  repo: boolean
  clean: boolean
  stagedFiles: ReviewFile[]
  unstagedFiles: ReviewFile[]
  truncated: boolean
  /**
   * The repository root every `path` above is named against — `git status` prints its paths that
   * way whatever directory it ran in — or absent when the workspace is not inside a working tree.
   * A row's absolute path is built from this root, not from the workspace: a workspace that is a
   * subdirectory of its repository would otherwise name a file that does not exist.
   */
  repositoryRoot?: string
  /**
   * The commit HEAD points at, as the whole object name, or absent when the repository has no
   * commit yet.
   *
   * The review panel compares it between reads: a HEAD that moved is a commit (or a checkout)
   * since the message box's text was written, and that text is dropped rather than left beside a
   * tree that no longer means it.
   */
  head?: string
  branch?: WorkspaceBranch
  error?: string
}

/** What one stage / unstage / discard answers: the two sides whole, for the touched paths. */
export interface WorkspaceReviewDelta {
  stagedFiles: ReviewFile[]
  unstagedFiles: ReviewFile[]
}

/* ------------------------------------------------------------- commands */

export function getWorkspaceReview(root: string): Promise<WorkspaceReview> {
  return call<WorkspaceReview>(COMMANDS.gitGetWorkspaceReview, { root })
}

/** The repository's local branches, or `null` when the workspace is not inside one. */
export function getWorkspaceBranches(root: string): Promise<WorkspaceBranches | null> {
  return call<WorkspaceBranches | null>(COMMANDS.gitGetWorkspaceBranches, { root })
}

/** Switches the workspace to one of its local branches (git's own checkout semantics). */
export function checkoutWorkspaceBranch(root: string, branch: string): Promise<void> {
  return call<void>(COMMANDS.gitCheckoutWorkspaceBranch, { root, branch })
}

export function stageWorkspaceFiles(root: string, paths: string[]): Promise<WorkspaceReviewDelta> {
  return call<WorkspaceReviewDelta>(COMMANDS.gitStageWorkspaceFiles, { root, paths })
}

export function unstageWorkspaceFiles(
  root: string,
  paths: string[],
): Promise<WorkspaceReviewDelta> {
  return call<WorkspaceReviewDelta>(COMMANDS.gitUnstageWorkspaceFiles, { root, paths })
}

export function discardWorkspaceFiles(
  root: string,
  paths: string[],
  staged: boolean,
): Promise<WorkspaceReviewDelta> {
  return call<WorkspaceReviewDelta>(COMMANDS.gitDiscardWorkspaceFiles, { root, paths, staged })
}

export function commitWorkspace(root: string, message: string): Promise<void> {
  return call<void>(COMMANDS.gitCommitWorkspace, { root, message })
}

export function syncWorkspace(root: string): Promise<void> {
  return call<void>(COMMANDS.gitSyncWorkspace, { root })
}

/** The engine's own commit pipeline drafts a message from the staged tree (`host/src/commit-message.ts`). */
export function draftCommitMessage(root: string): Promise<string> {
  return call<string>(COMMANDS.draftCommitMessage, { root })
}

/** Points the workspace watch at `root`, or stops it with `null` (`commands/workspace.rs`). */
export function setWorkspaceWatch(root: string | null): Promise<void> {
  return call<void>(COMMANDS.workspaceWatchSet, { root: root ?? undefined })
}

/* ------------------------------------------------------------- event */

/** What the coalesced watch report carries; only `root` decides whether it is ours. */
export interface WorkspaceChanged {
  root: string
  paths: string[]
  truncated: boolean
}

/** Subscribe to the desktop's coalesced workspace-changed report. */
export function subscribeWorkspaceChanged(
  handler: (report: WorkspaceChanged) => void,
): Promise<UnlistenFn> {
  return subscribe<WorkspaceChanged>(WORKSPACE_CHANGED_EVENT, handler)
}
