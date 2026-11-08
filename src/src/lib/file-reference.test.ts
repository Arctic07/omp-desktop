import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  filePathInText,
  isAbsoluteFilePath,
  relativePathInsideRoot,
} from './file-reference.ts'

test('absolute paths are read under either platform spelling', () => {
  assert.equal(filePathInText('C:\\project\\静夜思.txt'), 'C:\\project\\静夜思.txt')
  assert.equal(filePathInText('D:/work/notes.md'), 'D:/work/notes.md')
  assert.equal(filePathInText('/home/me/notes.md'), '/home/me/notes.md')
  assert.equal(filePathInText('\\\\server\\share\\a.txt'), '\\\\server\\share\\a.txt')
  assert.equal(isAbsoluteFilePath('../a/b.txt'), false)
})

test('a relative path needs a separator and an extension', () => {
  assert.equal(filePathInText('src/src/App.tsx'), 'src/src/App.tsx')
  assert.equal(filePathInText('docs\\方案.md'), 'docs\\方案.md')
  assert.equal(filePathInText('src/App.tsx:12'), 'src/App.tsx')
  assert.equal(filePathInText('C:\\work\\App.tsx:12:4'), 'C:\\work\\App.tsx')
  assert.equal(filePathInText('src/'), null)
  assert.equal(filePathInText('1/2'), null)
  assert.equal(filePathInText('README'), null)
})

test('inline code that is not a path stays plain', () => {
  assert.equal(filePathInText('console.log'), null)
  assert.equal(filePathInText('pnpm --filter src build'), null)
  assert.equal(filePathInText('https://omp.sh/docs'), null)
  assert.equal(filePathInText('a\nb.txt'), null)
  assert.equal(filePathInText(''), null)
})

/**
 * Where the click routes: a path under the root is the file tab's, and the rest of the same spelling
 * is what the file tree addresses. A path that only shares a prefix (`C:\project-evil`) is outside.
 */
test('a workspace path answers with its spelling inside the root', () => {
  assert.equal(
    relativePathInsideRoot('C:\\project\\omp-desktop', 'C:/project/omp-desktop/src/App.tsx'),
    'src/App.tsx',
  )
  assert.equal(relativePathInsideRoot('/home/me/project/', '/home/me/project/a.txt'), 'a.txt')
  assert.equal(
    relativePathInsideRoot('C:\\project\\omp-desktop', 'C:\\project\\omp-desktop-evil\\a.txt'),
    null,
  )
  assert.equal(relativePathInsideRoot('C:\\project', 'C:\\project'), null)
  assert.equal(relativePathInsideRoot('C:\\project', 'C:\\project\\..\\a.txt'), null)
})
