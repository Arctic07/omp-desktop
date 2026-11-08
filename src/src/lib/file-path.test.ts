import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  absolutePathOf,
  fileLeafName,
  fileParentPath,
  fileStemName,
  joinRelativePath,
  normaliseFilePath,
} from './file-path.ts'

test('windows and unix separators read as the same path', () => {
  assert.equal(normaliseFilePath('src\\components\\file.tsx'), 'src/components/file.tsx')
  assert.equal(fileLeafName('src\\components\\file.tsx'), 'file.tsx')
  assert.equal(fileParentPath('src\\components\\file.tsx'), 'src/components')
})

test('a bare leaf has no parent, and the workspace root joins without a slash', () => {
  assert.equal(fileLeafName('README.md'), 'README.md')
  assert.equal(fileParentPath('README.md'), null)
  assert.equal(joinRelativePath('.', 'README.md'), 'README.md')
  assert.equal(joinRelativePath('src', 'main.ts'), 'src/main.ts')
})

test('an absolute path follows the separator its root uses', () => {
  assert.equal(
    absolutePathOf('C:\\project\\omp-desktop', 'src/src/App.tsx'),
    'C:\\project\\omp-desktop\\src\\src\\App.tsx',
  )
  assert.equal(absolutePathOf('/home/me/project/', 'README.md'), '/home/me/project/README.md')
})

/**
 * The one fact a `task` roster row is matched against a child's transcript by: the engine writes
 * each subagent into `<parent>/<childId>.jsonl`, so the child's id is the file's stem — under
 * either separator, and with only the transcript's own suffix dropped.
 */
test('a transcript path answers with the id the engine named the subagent', () => {
  assert.equal(
    fileStemName('C:\\project\\omp-desktop\\sessions\\2026-10-20_parent\\explore-1.jsonl'),
    'explore-1',
  )
  assert.equal(fileStemName('/home/me/sessions/parent/explore-1.jsonl'), 'explore-1')
  // A dotted id keeps everything but the suffix, so it still matches the file it was written in.
  assert.equal(fileStemName('C:\\sessions\\parent\\task.alpha.jsonl'), 'task.alpha')
  // A leaf with no suffix, and one that is nothing but a suffix, are their own stem rather than
  // empty strings — an id is never silently blanked into a match for every child.
  assert.equal(fileStemName('C:\\sessions\\parent\\child'), 'child')
  assert.equal(fileStemName('.jsonl'), '.jsonl')
})
