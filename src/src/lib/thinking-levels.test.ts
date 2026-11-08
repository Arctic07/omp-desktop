import assert from 'node:assert/strict'
import { test } from 'node:test'

import { thinkingLadder } from './thinking-levels.ts'

test('nothing reported yet stands on the full ladder', () => {
  assert.deepEqual(thinkingLadder(undefined), [
    'off',
    'auto',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ])
})

/*
 * The rule this file exists for: an empty report is the model saying it cannot think, so the control
 * offers no stops at all. Padding `off` and `auto` onto it drew a strength slider in front of a
 * non-reasoning model (2026-10-29, user report).
 */
test('a model with no reasoning surface offers no stops', () => {
  assert.deepEqual(thinkingLadder([]), [])
})

test('reported levels are re-laid on the ladder order, with off and auto included', () => {
  assert.deepEqual(thinkingLadder(['auto', 'high', 'low']), ['off', 'auto', 'low', 'high'])
  assert.deepEqual(thinkingLadder(['inherit', 'medium']), ['off', 'auto', 'medium'])
})

test('stops this app does not know keep their reported order after the known ones', () => {
  assert.deepEqual(thinkingLadder(['auto', 'turbo', 'low']), ['off', 'auto', 'low', 'turbo'])
})
