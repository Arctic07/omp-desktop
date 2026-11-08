import assert from 'node:assert/strict'
import { test } from 'node:test'

import { stackedRowTops } from './feed-placement.ts'

test('a row that grew pushes the rows under it down, and the first keeps its place', () => {
  // Two rows whose tops are 16 px apart the way a frame that changed the width leaves them: the row
  // above has reflowed to 120 px and the row below has not moved yet.
  const tops = stackedRowTops(
    [
      { top: 100, height: 120 },
      { top: 136, height: 48 },
    ],
    16,
  )
  assert.deepEqual(tops, [null, 236])
})

test('a window already standing on its own boxes is written to nowhere', () => {
  const tops = stackedRowTops(
    [
      { top: 100, height: 120 },
      { top: 236, height: 48 },
      { top: 300, height: 64 },
    ],
    16,
  )
  assert.deepEqual(tops, [null, null, null])
})

test('the stack follows the boxes it is given, rounded to whole pixels', () => {
  // A row that shrank pulls the rest up with it; a fractional box is rounded rather than left where
  // the model's estimate would have had it.
  const tops = stackedRowTops(
    [
      { top: 0, height: 40.4 },
      { top: 200, height: 40 },
      { top: 256.4, height: 40 },
    ],
    8,
  )
  assert.deepEqual(tops, [null, 48, 96])
})

test('an empty window has nothing to place', () => {
  assert.deepEqual(stackedRowTops([], 16), [])
})
