import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  SEARCH_MARK_END,
  SEARCH_MARK_START,
  searchConversations,
  snippetSegments,
} from './conversation-search.ts'
import type { SessionSummary } from '../api/session-types.ts'
import type { WorkspaceSummary } from '../api/types.ts'
import type { WorkspaceSessions } from '../state/session-lists.ts'

/**
 * What the rail's conversation search answers: which rows a query finds, in what order, and which
 * rows never appear at all. The lists themselves belong to the host, so a row is spelled here.
 */

function workspace(id: number, name: string): WorkspaceSummary {
  return { id, rootPath: `C:\\work\\${name}`, name, pinned: false, missing: false, lastOpenedAt: 0, sessionCount: 0 }
}

function session(id: string, title: string, updatedAt: number, archived = false, blank = false): SessionSummary {
  return {
    id,
    title,
    cwd: 'C:\\work',
    status: 'complete',
    updatedAt,
    filePath: `C:\\work\\${id}.jsonl`,
    compressed: false,
    pinned: false,
    archived,
    blank,
  }
}

function lists(entries: Record<number, SessionSummary[]>): Record<number, WorkspaceSessions> {
  const result: Record<number, WorkspaceSessions> = {}
  for (const [id, items] of Object.entries(entries)) {
    result[Number(id)] = { status: 'ready', error: null, items }
  }
  return result
}

const WORKSPACES = [workspace(1, 'omp-desktop'), workspace(2, 'zcode')]

test('a query matches a title regardless of case, across workspaces', () => {
  const found = searchConversations(
    WORKSPACES,
    lists({
      1: [session('a', 'Composer undo stack', 3_000), session('b', 'Sidebar rail', 2_000)],
      2: [session('c', 'Composer tokens', 1_000)],
    }),
    'COMPOSER',
    10,
  )
  assert.deepEqual(
    found.map((row) => row.sessionId),
    ['a', 'c'],
  )
})

test('a query matches the title alone: a workspace name is not shown, so it is not a match', () => {
  const found = searchConversations(
    WORKSPACES,
    lists({
      1: [session('a', 'Composer undo stack', 3_000)],
      2: [session('c', 'Something else', 1_000)],
    }),
    'zcode',
    10,
  )
  assert.deepEqual(found, [])
})

test('archived conversations are never found', () => {
  const found = searchConversations(
    WORKSPACES,
    lists({ 1: [session('a', 'Composer undo stack', 3_000, true)] }),
    'composer',
    10,
  )
  assert.deepEqual(found, [])
})

test('an empty query is the recent conversations, newest first, cut to the limit', () => {
  const found = searchConversations(
    WORKSPACES,
    lists({
      1: [session('old', '', 1_000), session('new', 'Newest', 9_000)],
      2: [session('middle', 'Middle', 5_000)],
    }),
    '   ',
    2,
  )
  assert.deepEqual(
    found.map((row) => row.sessionId),
    ['new', 'middle'],
  )
})

test('a conversation whose workspace list was never read is not invented', () => {
  const found = searchConversations(WORKSPACES, {}, '', 10)
  assert.deepEqual(found, [])
})

test('a conversation nothing has been said in is not a result', () => {
  const found = searchConversations(
    WORKSPACES,
    lists({
      1: [session('a', 'New conversation', 2_000, false, true), session('b', 'Sidebar rail', 1_000)],
    }),
    '',
    10,
  )
  assert.deepEqual(
    found.map((row) => row.sessionId),
    ['b'],
  )
})

/**
 * What a snippet's markers turn into: the runs a result row draws, and which of them is the match.
 *
 * The markers are the desktop's, and a snippet is the only thing that carries them, so the split is
 * the whole of the contract between the two sides.
 */
test('a snippet splits into its matched run and the text around it', () => {
  const marked = `please ${SEARCH_MARK_START}deploy${SEARCH_MARK_END} the staging build`
  assert.deepEqual(snippetSegments(marked), [
    { text: 'please ', match: false },
    { text: 'deploy', match: true },
    { text: ' the staging build', match: false },
  ])
})

test('a snippet with several matches keeps every one of them', () => {
  const marked = `${SEARCH_MARK_START}deploy${SEARCH_MARK_END} … ${SEARCH_MARK_START}deploy${SEARCH_MARK_END}`
  assert.deepEqual(snippetSegments(marked), [
    { text: 'deploy', match: true },
    { text: ' … ', match: false },
    { text: 'deploy', match: true },
  ])
})

test('a snippet the markers did not survive is still drawn as its own text', () => {
  // A cut tail leaves the opening marker with no partner: the row shows what it has rather than
  // swallowing the snippet or throwing.
  assert.deepEqual(snippetSegments(`deploy${SEARCH_MARK_START}ing`), [
    { text: 'deploying', match: false },
  ])
  assert.deepEqual(snippetSegments('no marks at all'), [{ text: 'no marks at all', match: false }])
  assert.deepEqual(snippetSegments(''), [])
})
