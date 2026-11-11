import assert from 'node:assert/strict'
import { test } from 'node:test'

import { markerOffsets } from './selection-words.ts'

/**
 * The offset arithmetic behind a transcript selection copy.
 *
 * The rendered read is a DOM question, but the answer it needs — where each chip's marker sits in
 * the words after the markers are removed — is pure, and it is where the field and the transcript
 * must agree. The cases below are the shapes a message can put around a chip: one space, none,
 * multiple collapsed spaces, a newline at the start of a block, preserved `pre` whitespace, and
 * two chips standing together.
 */
test('a marker sits after the whitespace that preceded it, bounded by the next visible character', () => {
  // Normal flow: both spaces collapse to one, and the field's prose offset is after the first.
  assert.deepEqual(markerOffsets(['看这张 ', ' 和 ', '，谢谢'], '看这张 和 ，谢谢'), [4, 6])
  // No space before the chip: the field's offset is 3, not the next visible character's 4.
  assert.deepEqual(markerOffsets(['看这张', ' 和'], '看这张 和'), [3])
  // Preserved whitespace: the chip stays immediately after `a`, before the newline and indent.
  assert.deepEqual(markerOffsets(['a', '\n  b'], 'a\n  b'), [1])
  // Collapsed multiple spaces bound the offset to the one space that survives.
  assert.deepEqual(markerOffsets(['a  ', '  b'], 'a b'), [2])
  // A chip at the end sits after the words, even though the copy trims trailing whitespace.
  assert.deepEqual(markerOffsets(['end ', ''], 'end'), [3])
  // A chip at the start of a block sits after the block break.
  assert.deepEqual(markerOffsets(['first\n\n', 'after'], 'first\n\nafter'), [7])
  // Two adjacent chips share the same place, in their own order.
  assert.deepEqual(markerOffsets(['a ', '', ' b'], 'a b'), [2, 2])
  // An astral character is two UTF-16 units in the words and in the offset.
  assert.deepEqual(markerOffsets(['😀', '看'], '😀看'), [2])
})
