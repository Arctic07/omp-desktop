import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ReviewFile } from '@/api/git'
import { reviewActionPaths, stageActionPaths } from './git-review-paths.ts'

/**
 * Which paths one review action names.
 *
 * The two differ only for a rename, and that difference is what the panel got wrong: `git add`
 * refuses to be told about a path that is not in the worktree, so a stage that named a rename's old
 * path failed the whole action with `fatal: pathspec ... did not match any files` — every other row
 * of the same press left unstaged (2026-10-30).
 */

function file(path: string, oldPath?: string): ReviewFile {
  return {
    path,
    oldPath,
    status: 'renamed',
    additions: 0,
    deletions: 0,
    binary: false,
    tooLarge: false,
    hunks: [],
  }
}

test('a stage names a rename by the path the worktree still has', () => {
  assert.deepEqual(stageActionPaths([file('b.ts', 'a.ts')]), ['b.ts'])
})

test('an unstage and a discard name both halves of a rename', () => {
  assert.deepEqual(reviewActionPaths([file('b.ts', 'a.ts')]), ['b.ts', 'a.ts'])
})

test('plain rows name one path each, and a repeated path is named once', () => {
  const rows = [file('one.ts'), file('two.ts', 'one.ts'), file('two.ts')]
  assert.deepEqual(stageActionPaths(rows), ['one.ts', 'two.ts'])
  assert.deepEqual(reviewActionPaths(rows), ['one.ts', 'two.ts'])
})
