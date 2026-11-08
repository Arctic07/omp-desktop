import assert from 'node:assert/strict'
import { test } from 'node:test'

import { stalePanelOwners } from './panel-prune.ts'

/**
 * When the tool column may release a conversation's tabs.
 *
 * The case pinned here is the one the reader hit (2026-10-24): a conversation the engine has just
 * opened has a record but no row in the rail's list yet, because the list is a read of what is on
 * disk and is not re-read on an open. Judging by the list alone closed the terminal the reader had
 * just opened in that conversation.
 */

test('a conversation this process holds keeps its tabs before the list catches up', () => {
  const held = { 'session-new': { id: 'session-new' } }
  assert.deepEqual(stalePanelOwners(['session-new'], new Set(['session-old']), held), [])
})

test('a conversation the list carries keeps its tabs after its record was let go', () => {
  assert.deepEqual(
    stalePanelOwners(['session-old'], new Set(['session-old']), {}),
    [],
  )
})

test('a conversation neither listed nor held is released', () => {
  assert.deepEqual(
    stalePanelOwners(['session-gone', 'session-old'], new Set(['session-old']), {}),
    ['session-gone'],
  )
})
