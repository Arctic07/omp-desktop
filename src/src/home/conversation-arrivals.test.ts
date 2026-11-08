import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isArrival } from './conversation-arrivals.ts'

test('a conversation drawn on mount is drawn still, not animated in', () => {
  // The pane has committed no row set yet: every row it draws is the conversation the reader asked
  // for, so none of them is an arrival (a switch must not animate a transcript).
  assert.equal(isArrival(null, 'user-1'), false)
  assert.equal(isArrival(null, 'assistant-1'), false)
})

test('a row the pane had not drawn yet is an arrival', () => {
  const drawn = new Set(['user-1'])
  // The reader's own prompt is drawn, and the answer that starts after it has not been.
  assert.equal(isArrival(drawn, 'user-1'), false)
  assert.equal(isArrival(drawn, 'assistant-1'), true)
})

test('a row that was already on screen keeps its place instead of arriving again', () => {
  const drawn = new Set(['user-1', 'assistant-1'])
  // Streamed text grows a row in place; the row itself is not new, so it is not redrawn as arriving.
  assert.equal(isArrival(drawn, 'assistant-1'), false)
  assert.equal(isArrival(new Set(), 'user-1'), true)
})
