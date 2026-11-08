/**
 * The workspace watch's revisions, as one window-wide fact — two of them, because two answers cost
 * different things.
 *
 * The watch is a process-wide singleton (`src-tauri/src/services/workspace_watch.rs`), so its
 * reports have one audience: whichever surface is pointed at its root. Today that is the git review
 * (`git-review.tsx`), the file tab (`file-panel.tsx`) and the changes area's branch row
 * (`home/BranchPicker.tsx`); `RightSidebar` (`right-sidebar.tsx`) bumps them when a report arrives.
 *
 * `revision` moves on every report: a file was written, and the review and the file tab have to
 * look again. `refsRevision` moves only when git's own refs could have moved, because that is the
 * only thing the branch row shows and reading it costs a git process per question
 * (`services/git.rs::get_workspace_branches` runs four). A working-tree save therefore re-renders
 * the review and leaves the branch row alone (2026-10-22, review: it used to re-read git on every
 * save).
 *
 * The counters live here rather than in the surfaces: a store write — unlike a module variable — is
 * what re-renders the components subscribed to it, and no surface owns another.
 */

import type { WorkspaceChanged } from "@/api/git";

const listeners = new Set<() => void>();
const refListeners = new Set<() => void>();
let revision = 0;
let refsRevision = 0;

/**
 * Calls every listener. One throwing must not keep the others from hearing the report: a report is
 * the only thing that refreshes these surfaces, and a single bad subscriber would otherwise freeze
 * every other one for the rest of the session.
 */
function notify(set: Set<() => void>): void {
  for (const listener of set) {
    try {
      listener();
    } catch (error) {
      console.error("a workspace change listener failed", error);
    }
  }
}

/** Every coalesced report: something under the watched root changed. */
export function subscribeWorkspaceChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function workspaceChangeRevision(): number {
  return revision;
}

/** Only the reports that could have moved `HEAD`, a ref, or an up-stream ahead/behind count. */
export function subscribeWorkspaceRefChange(listener: () => void): () => void {
  refListeners.add(listener);
  return () => {
    refListeners.delete(listener);
  };
}

export function workspaceRefRevision(): number {
  return refsRevision;
}

/** One coalesced report arrived: everyone reading the revisions re-renders and decides for itself. */
export function bumpWorkspaceChange(refsChanged: boolean): void {
  revision += 1;
  notify(listeners);
  if (!refsChanged) return;
  refsRevision += 1;
  notify(refListeners);
}

/** The files whose own content is a ref: a branch, the checkout, a fetch. */
const REF_FILES: Record<string, true> = {
  ".git/head": true,
  ".git/packed-refs": true,
  ".git/fetch_head": true,
};

/**
 * Whether one report could have moved what the branch row shows.
 *
 * `refs/**` covers a checkout, a commit and a fetch (local and remote refs), and the three files
 * above cover what git writes outside it. The nested form (`sub/.git/refs/…`, `.git/modules/<name>/
 * refs/…`) is a submodule's own repository. A truncated report names only a prefix of what changed,
 * so it is read as "maybe": one extra read is cheaper than a stale branch name.
 *
 * The watch only sees `.git` when it is inside the watched workspace root — a workspace opened on a
 * repository *subdirectory*, a `git worktree` (`.git` is a file), or `--separate-git-dir` puts refs
 * outside it, and then no report can move this revision (`src/AGENTS.md`). This function says what a
 * path means, not what the watch is able to see.
 */
export function reportTouchesRefs(report: WorkspaceChanged): boolean {
  if (report.truncated === true) return true;
  const paths = Array.isArray(report.paths) ? report.paths : [];
  for (const path of paths) {
    if (typeof path !== "string") continue;
    const normalized = path.replaceAll("\\", "/").toLowerCase();
    if (Object.hasOwn(REF_FILES, normalized)) return true;
    if (normalized.includes(".git/") && normalized.includes("/refs/")) return true;
  }
  return false;
}
