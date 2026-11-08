import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MAX_ATTACHMENT_PREVIEWS, previewOf, withPreview } from './attachment-preview.ts'

/**
 * What the preview cache answers, and what it lets go of.
 *
 * The cache is what keeps a hover from being a read: the chip asks once, and every later pass over
 * the same chip draws what is already there. Its ceiling is the other half — a preview is a file's
 * own bytes, so a cache that only ever grew would hold every image the reader ever pointed at.
 */

test('a path that was never read has no answer, and a failed read has one', () => {
  const empty = new Map<string, string | null>()
  assert.equal(previewOf(empty, 'C:\\work\\a.png'), undefined)

  // A failure is kept as the answer it is: the chip shows no picture, and the file is not asked for
  // again every time the pointer crosses it.
  const failed = withPreview(empty, 'C:\\work\\a.png', null)
  assert.equal(previewOf(failed, 'C:\\work\\a.png'), null)
  assert.equal(previewOf(empty, 'C:\\work\\a.png'), undefined)

  const read = withPreview(failed, 'C:\\work\\b.png', 'data:image/png;base64,AAAA')
  assert.equal(previewOf(read, 'C:\\work\\b.png'), 'data:image/png;base64,AAAA')
})

test('the cache holds a bounded number of previews, oldest read first out', () => {
  let cache: ReadonlyMap<string, string | null> = new Map()
  for (let index = 0; index < MAX_ATTACHMENT_PREVIEWS; index += 1) {
    cache = withPreview(cache, `C:\\work\\${index}.png`, `data:image/png;base64,${index}`)
  }
  assert.equal(cache.size, MAX_ATTACHMENT_PREVIEWS)

  cache = withPreview(cache, 'C:\\work\\last.png', 'data:image/png;base64,last')

  assert.equal(cache.size, MAX_ATTACHMENT_PREVIEWS)
  assert.equal(previewOf(cache, 'C:\\work\\last.png'), 'data:image/png;base64,last')
  // The one read longest ago is the one that left; every later one is still there.
  assert.equal(previewOf(cache, 'C:\\work\\0.png'), undefined)
  assert.equal(previewOf(cache, `C:\\work\\${MAX_ATTACHMENT_PREVIEWS - 1}.png`), 'data:image/png;base64,11')
})

test('re-reading a path keeps one entry rather than filling the cache with copies', () => {
  let cache: ReadonlyMap<string, string | null> = new Map()
  for (let index = 0; index < MAX_ATTACHMENT_PREVIEWS; index += 1) {
    cache = withPreview(cache, `C:\\work\\${index}.png`, `data:image/png;base64,${index}`)
  }

  cache = withPreview(cache, 'C:\\work\\0.png', 'data:image/png;base64,again')

  assert.equal(cache.size, MAX_ATTACHMENT_PREVIEWS)
  assert.equal(previewOf(cache, 'C:\\work\\0.png'), 'data:image/png;base64,again')
})
