/**
 * Which paths one review action names.
 *
 * The two spellings differ only for a rename, and that difference is what the panel got wrong:
 * `git add -- <old> <new>` fails for a rename — the old path is not in the worktree any more, so git
 * answers `fatal: pathspec ... did not match any files` and the whole action is lost, every other
 * row of it included (2026-10-30). `git restore --staged` and `git rm --cached` want both halves, so
 * unstage and discard keep naming them.
 */

import type { ReviewFile } from '@/api/git'

/**
 * The paths an unstage or a discard names: the file's own path, plus its old path when the row is
 * a rename. Restoring the old path is what puts it back in the index.
 */
export function reviewActionPaths(files: readonly ReviewFile[]): string[] {
  const unique = new Set<string>()
  for (const file of files) {
    unique.add(file.path)
    if (file.oldPath !== undefined) unique.add(file.oldPath)
  }
  return [...unique]
}

/** The paths a stage names: the file's own path only. The new path alone stages the same rename. */
export function stageActionPaths(files: readonly ReviewFile[]): string[] {
  const unique = new Set<string>()
  for (const file of files) unique.add(file.path)
  return [...unique]
}
