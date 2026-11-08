import assert from 'node:assert/strict'
import test from 'node:test'

import { workspaceRailBody } from './workspace-rail-state.ts'

test('an unanswered first read is a wait, not an empty workspace list', () => {
  assert.equal(workspaceRailBody({ status: 'idle', error: null, items: [] }), 'loading')
  assert.equal(workspaceRailBody({ status: 'loading', error: null, items: [] }), 'loading')
})

test('only a ready, empty list draws the empty state', () => {
  assert.equal(workspaceRailBody({ status: 'ready', error: null, items: [] }), 'empty')
  assert.equal(workspaceRailBody({ status: 'ready', error: null, items: [1] }), 'list')
})

test('a failed read is an error, and a reload keeps the rows it already has', () => {
  assert.equal(
    workspaceRailBody({ status: 'error', error: { code: 'store_unavailable' }, items: [] }),
    'error',
  )
  assert.equal(
    workspaceRailBody({ status: 'error', error: { code: 'store_unavailable' }, items: [1] }),
    'error',
  )
  assert.equal(
    workspaceRailBody({ status: 'loading', error: null, items: [1] }),
    'list',
  )
})
