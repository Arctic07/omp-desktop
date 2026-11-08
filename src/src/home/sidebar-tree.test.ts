import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SessionSummary, TurnOutcome } from '../api/session-types.ts'
import { buildSidebarTree, movedList, openSessionsOf } from './sidebar-tree.ts'

/**
 * The conversation rows' marks.
 *
 * The one thing pinned down here is that *work*, rather than the tab, decides the mark: a turn
 * running in a conversation the reader has moved away from keeps its running mark, and its cold
 * file status (which still says `interrupted` until the turn writes its end) cannot wear the amber
 * "stopped" arc over it. That is the state the reader reported on 2026-10-20.
 */

function summary(
  id: string,
  status: SessionSummary['status'],
  updatedAt: number,
  flags: { pinned?: boolean; archived?: boolean; blank?: boolean } = {},
): SessionSummary {
  return {
    id,
    title: id,
    cwd: 'D:/project',
    status,
    updatedAt,
    filePath: `D:/sessions/${id}.jsonl`,
    compressed: false,
    pinned: flags.pinned ?? false,
    archived: flags.archived ?? false,
    blank: flags.blank ?? false,
  }
}

test('a conversation nothing has been sent in has no row', () => {
  const tree = buildSidebarTree([{ id: 1, name: 'workspace' }], {
    sessions: {
      1: {
        status: 'ready',
        error: null,
        items: [summary('written', 'complete', 1_000), summary('blank', 'complete', 2_000, { blank: true })],
      },
    },
    readMarks: {},
    runningSessionIds: new Set(),
    finishedTurns: new Map(),
    timeLabel: () => '3m',
    untitledLabel: 'New conversation',
    sessionOrder: () => [],
    visibleCount: () => 5,
    showArchived: false,
  })

  assert.deepEqual(tree[0]?.children?.map((row) => row.label), ['written'])
})

test('every conversation still working carries the running mark, not only the one on screen', () => {
  const tree = buildSidebarTree([{ id: 1, name: 'workspace' }], {
    sessions: {
      1: {
        status: 'ready',
        error: null,
        items: [summary('other', 'complete', 2_000), summary('live', 'interrupted', 1_000)],
      },
    },
    readMarks: {},
    runningSessionIds: new Set(['live']),
    finishedTurns: new Map(),
    timeLabel: () => '3m',
    untitledLabel: 'New conversation',
    sessionOrder: () => [],
    visibleCount: () => 5,
    showArchived: false,
  })

  const rows = tree[0]?.children ?? []
  assert.equal(rows.length, 2)
  assert.equal(rows[0]?.status, 'unread')
  assert.equal(rows[1]?.status, 'running')
})

test('a second completed turn is unread when the mark predates it', () => {
  const treeAt = (seenAt: number) =>
    buildSidebarTree([{ id: 1, name: 'workspace' }], {
      sessions: {
        1: {
          status: 'ready',
          error: null,
          items: [summary('repeat', 'complete', 2_000)],
        },
      },
      // The same word as an earlier turn: only the time says whether this ending was seen.
      readMarks: { repeat: seenAt },
      runningSessionIds: new Set(),
      finishedTurns: new Map(),
      timeLabel: () => '3m',
      untitledLabel: 'New conversation',
      sessionOrder: () => [],
      visibleCount: () => 5,
      showArchived: false,
    })

  assert.equal(treeAt(1_000)[0]?.children?.[0]?.status, 'unread')
  assert.equal(treeAt(3_000)[0]?.children?.[0]?.status, 'completed')
})

test('a row whose list still says pending draws the ending this process watched', () => {
  const tree = buildSidebarTree([{ id: 1, name: 'workspace' }], {
    sessions: {
      1: {
        status: 'ready',
        error: null,
        // The list was read while the turn was still running: its status predates the ending.
        items: [summary('finishing', 'pending', 1_000)],
      },
    },
    readMarks: {},
    runningSessionIds: new Set(),
    finishedTurns: new Map([['finishing', { outcome: 'completed', at: 2_000, seen: false }]]),
    timeLabel: () => '3m',
    untitledLabel: 'New conversation',
    sessionOrder: () => [],
    visibleCount: () => 5,
    showArchived: false,
  })

  assert.equal(tree[0]?.children?.[0]?.status, 'unread')

  // Reading the row after the ending — an open or a click — records a mark newer than the turn.
  const seen = buildSidebarTree([{ id: 1, name: 'workspace' }], {
    sessions: {
      1: { status: 'ready', error: null, items: [summary('finishing', 'pending', 1_000)] },
    },
    readMarks: { finishing: 3_000 },
    runningSessionIds: new Set(),
    finishedTurns: new Map([['finishing', { outcome: 'completed', at: 2_000, seen: false }]]),
    timeLabel: () => '3m',
    untitledLabel: 'New conversation',
    sessionOrder: () => [],
    visibleCount: () => 5,
    showArchived: false,
  })
  assert.equal(seen[0]?.children?.[0]?.status, 'completed')
})

test('a stop or a failure the reader watched settles instead of staying marked', () => {
  const treeAt = (outcome: TurnOutcome, seenAt: number) =>
    buildSidebarTree([{ id: 1, name: 'workspace' }], {
      sessions: {
        1: {
          status: 'ready',
          error: null,
          // The list still names the turn's starting status when the ending is drawn.
          items: [summary('ending', 'pending', 1_000)],
        },
      },
      readMarks: seenAt === 0 ? {} : { ending: seenAt },
      runningSessionIds: new Set(),
      finishedTurns: new Map([['ending', { outcome, at: 2_000, seen: false }]]),
      timeLabel: () => '3m',
      untitledLabel: 'New conversation',
      sessionOrder: () => [],
      visibleCount: () => 5,
      showArchived: false,
    })

  // The ending happened in front of the reader: the mark written for it is newer than the turn,
  // and switching to another conversation leaves nothing amber behind (2026-10-21, user report).
  assert.equal(treeAt('aborted', 3_000)[0]?.children?.[0]?.status, 'completed')
  assert.equal(treeAt('failed', 3_000)[0]?.children?.[0]?.status, 'completed')

  // An ending the reader was not there for keeps its mark until the row is opened.
  assert.equal(treeAt('aborted', 0)[0]?.children?.[0]?.status, 'cancelled')
  assert.equal(treeAt('failed', 0)[0]?.children?.[0]?.status, 'error')
})

test('a pinned row comes before a newer one, and an archived row only when asked for', () => {
  const items = [
    summary('summit', 'complete', 4_000, { pinned: true, archived: true }),
    summary('newer', 'complete', 3_000),
    summary('pinned', 'complete', 1_000, { pinned: true }),
    summary('older', 'complete', 2_000),
    summary('put-away', 'complete', 5_000, { archived: true }),
  ]
  const labelsAt = (showArchived: boolean, visibleCount: number) =>
    buildSidebarTree([{ id: 1, name: 'workspace' }], {
      sessions: { 1: { status: 'ready', error: null, items } },
      readMarks: {},
      runningSessionIds: new Set(),
      finishedTurns: new Map(),
      timeLabel: () => '3m',
      untitledLabel: 'New conversation',
      sessionOrder: () => [],
      visibleCount: () => visibleCount,
      showArchived,
    })[0]?.children?.map((row) => row.label)

  // Pinned first (by recency among themselves), then the rest; the archived rows are not there at
  // all, which is what "put away" means.
  assert.deepEqual(labelsAt(false, 5), ['pinned', 'newer', 'older'])

  // Asking for them puts them last, whatever their own recency says: they are not competing for
  // the top of a list they were taken out of.
  assert.deepEqual(labelsAt(true, 5), ['pinned', 'newer', 'older', 'put-away', 'summit'])

  // The page is cut after the ordering, so a pin is never what falls off it.
  assert.deepEqual(labelsAt(false, 1), ['pinned'])

  // A page already filled by open conversations does not hide the archived rows the reader just
  // asked for: the two lists are paged on their own.
  assert.deepEqual(labelsAt(true, 2), ['pinned', 'newer', 'put-away', 'summit'])
})

test('an arrangement orders the open rows, and a row it does not name still arrives on top', () => {
  const items = [
    summary('oldest', 'complete', 1_000),
    summary('middle', 'complete', 2_000),
    summary('newest', 'complete', 3_000),
  ]
  const placed = (...ids: string[]) =>
    ids.map((id) => ({ id, at: items.find((row) => row.id === id)?.updatedAt ?? 0 }))
  const labelsFor = (order: ReturnType<typeof placed>) =>
    buildSidebarTree([{ id: 1, name: 'workspace' }], {
      sessions: { 1: { status: 'ready', error: null, items } },
      readMarks: {},
      runningSessionIds: new Set(),
      finishedTurns: new Map(),
      timeLabel: () => '3m',
      untitledLabel: 'New conversation',
      sessionOrder: () => order,
      visibleCount: () => 5,
      showArchived: false,
    })[0]?.children?.map((row) => row.label)

  // A workspace nobody rearranged reads by recency, which is the order it has always had.
  assert.deepEqual(labelsFor([]), ['newest', 'middle', 'oldest'])

  // Once arranged, the list reads by the arrangement, not by when each row was last written.
  assert.deepEqual(labelsFor(placed('oldest', 'newest', 'middle')), ['oldest', 'newest', 'middle'])

  // A conversation started after the arrangement was written is not named by it, so it stands
  // above the placed rows rather than behind a page of rows the reader already arranged.
  assert.deepEqual(labelsFor(placed('middle', 'oldest')), ['newest', 'middle', 'oldest'])
})

test('a pin keeps the top of the list an arrangement would put it below', () => {
  const tree = buildSidebarTree([{ id: 1, name: 'workspace' }], {
    sessions: {
      1: {
        status: 'ready',
        error: null,
        items: [
          summary('pinned', 'complete', 1_000, { pinned: true }),
          summary('plain', 'complete', 2_000),
        ],
      },
    },
    readMarks: {},
    runningSessionIds: new Set(),
    finishedTurns: new Map(),
    timeLabel: () => '3m',
    untitledLabel: 'New conversation',
    sessionOrder: () => [{ id: 'plain', at: 2_000 }, { id: 'pinned', at: 1_000 }],
    visibleCount: () => 5,
    showArchived: false,
  })

  assert.deepEqual(tree[0]?.children?.map((row) => row.label), ['pinned', 'plain'])
})

test('a moved row lands beside its target and leaves the place it had', () => {
  assert.deepEqual(movedList(['a', 'b', 'c'], 'c', 'a', false), ['c', 'a', 'b'])
  assert.deepEqual(movedList(['a', 'b', 'c'], 'a', 'c', true), ['b', 'c', 'a'])
  // The foot-of-tree strip appends; a target the list does not hold is refused rather than guessed.
  assert.deepEqual(movedList(['a', 'b'], 'a', null, true), ['b', 'a'])
  assert.equal(movedList(['a', 'b'], 'a', 'z', true), null)
})

test('a drag kept as an arrangement reads back as the list the reader dropped', () => {
  const items = [
    summary('a', 'complete', 3_000),
    summary('b', 'complete', 2_000),
    summary('c', 'complete', 1_000),
  ]
  const before = openSessionsOf(items, [])
  assert.deepEqual(before.map((row) => row.id), ['a', 'b', 'c'])

  // What the rail does with a drop: move the row in the list it draws, then store that whole list
  // with each row's own time as its baseline. Reading it back draws the list the reader let go of.
  const dropped = movedList(before, before[2], before[0], false) ?? []
  assert.deepEqual(dropped.map((row) => row.id), ['c', 'a', 'b'])
  const entries = dropped.map((row) => ({ id: row.id, at: row.updatedAt }))
  assert.deepEqual(openSessionsOf(items, entries).map((row) => row.id), ['c', 'a', 'b'])

  const again = movedList(dropped, dropped[2], dropped[0], true) ?? []
  const againEntries = again.map((row) => ({ id: row.id, at: row.updatedAt }))
  assert.deepEqual(openSessionsOf(items, againEntries).map((row) => row.id), ['c', 'b', 'a'])
})

test('a conversation written after it was placed returns to the top by recency', () => {
  const arranged = [
    summary('a', 'complete', 1_000),
    summary('b', 'complete', 2_000),
    summary('c', 'complete', 3_000),
  ]
  const labelsFor = (items: SessionSummary[]) =>
    buildSidebarTree([{ id: 1, name: 'workspace' }], {
      sessions: { 1: { status: 'ready', error: null, items } },
      readMarks: {},
      runningSessionIds: new Set(),
      finishedTurns: new Map(),
      timeLabel: () => '3m',
      untitledLabel: 'New conversation',
      // The reader put the list in c, b, a order; each row's own time is its baseline.
      sessionOrder: () => [
        { id: 'c', at: 3_000 },
        { id: 'b', at: 2_000 },
        { id: 'a', at: 1_000 },
      ],
      visibleCount: () => 5,
      showArchived: false,
    })[0]?.children?.map((row) => row.label)

  assert.deepEqual(labelsFor(arranged), ['c', 'b', 'a'])

  // A turn in `a` writes its row, so it is newer than the place it was given: it returns to the
  // recency zone above the rows that still stand where the reader put them.
  const touched = [
    summary('a', 'complete', 4_000),
    summary('b', 'complete', 2_000),
    summary('c', 'complete', 3_000),
  ]
  assert.deepEqual(labelsFor(touched), ['a', 'c', 'b'])
})
