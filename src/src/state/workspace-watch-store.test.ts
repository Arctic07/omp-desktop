import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  bumpWorkspaceChange,
  reportTouchesRefs,
  subscribeWorkspaceChange,
  subscribeWorkspaceRefChange,
  workspaceChangeRevision,
  workspaceRefRevision,
} from './workspace-watch-store.ts'

const report = (paths: string[], truncated = false) => ({ root: '/repo', paths, truncated })

test('a file save moves the review revision and leaves the branch row alone', () => {
  let reviewReports = 0
  let refReports = 0
  const stopReview = subscribeWorkspaceChange(() => (reviewReports += 1))
  const stopRefs = subscribeWorkspaceRefChange(() => (refReports += 1))
  const reviewBefore = workspaceChangeRevision()
  const refsBefore = workspaceRefRevision()

  // The watch is pointed at the whole working tree, so this is the common report by far.
  const changed = reportTouchesRefs(report(['src/App.tsx', 'README.md']))
  bumpWorkspaceChange(changed)

  assert.equal(changed, false)
  assert.equal(reviewReports, 1, 'the review and the file tab look again')
  assert.equal(refReports, 0, 'a save is not a reason to run four git processes')
  assert.equal(workspaceChangeRevision(), reviewBefore + 1)
  assert.equal(workspaceRefRevision(), refsBefore)

  stopReview()
  stopRefs()
})

test('the files a checkout, a commit or a fetch writes are ref changes', () => {
  // Local branch, detached HEAD, a packed ref and a fetch marker, plus the case-insensitive spelling
  // Windows hands back, and a submodule whose refs live under its own git dir.
  for (const path of [
    '.git/refs/heads/react',
    '.git/refs/remotes/origin/main',
    '.git/HEAD',
    '.git/head',
    '.git/packed-refs',
    '.git/FETCH_HEAD',
    '.git/modules/vendor/refs/heads/main',
    'packages/app/.git/refs/heads/main',
  ]) {
    assert.equal(reportTouchesRefs(report([path])), true, path)
  }
})

test('working-tree paths and git files that are not refs stay out', () => {
  for (const path of [
    'src/App.tsx',
    '.gitignore',
    'sub/.gitignore',
    '.github/workflows/ci.yml',
    '.git/index',
    '.git/index.lock',
    '.git/COMMIT_EDITMSG',
    '.git/logs/HEAD',
    'src/refs/heads/notes.md',
  ]) {
    assert.equal(reportTouchesRefs(report([path])), false, path)
  }
})

test('a truncated report is read as "maybe", and one ref path is enough', () => {
  assert.equal(reportTouchesRefs(report(['a', 'b'], true)), true)
  assert.equal(reportTouchesRefs(report(['src/App.tsx', '.git/refs/heads/main'])), true)
})

test('a listener that throws does not keep the others from hearing the report', () => {
  const heard: string[] = []
  const stopRefs = subscribeWorkspaceRefChange(() => {
    throw new Error('a broken subscriber')
  })
  const stopOther = subscribeWorkspaceRefChange(() => heard.push('second'))

  const originalError = console.error
  console.error = () => {}
  try {
    bumpWorkspaceChange(true)
  } finally {
    console.error = originalError
    stopRefs()
    stopOther()
  }

  assert.deepEqual(heard, ['second'])
})
