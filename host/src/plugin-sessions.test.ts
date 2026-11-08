import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import type { HostPaths } from './env.ts'
import { ERROR_CODES, HostError } from './protocol/errors.ts'
import {
  sessionGet,
  sessionList,
  sessionMessages,
  usageTurns,
  type PluginSessionsPort,
} from './plugin-sessions.ts'
import type { SdkBundle } from './sdk.ts'
import { sessionIdFor } from './store.ts'

/**
 * The P1 read surfaces (`session.*`, `usage.turns`) over a store this test wrote.
 *
 * What is pinned here is the projection, not the engine: which rows a page carries, that a body is
 * absent unless the caller named a budget, that a cursor is this host's own scheme, and that the
 * usage rows are the model calls the engine recorded rather than a second accounting.
 */

/** One conversation with a header, two messages and one usage-bearing assistant turn. */
function fixture(): { root: string; paths: HostPaths } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-plugin-sessions-'))
  const sessionDir = path.join(root, 'sessions')
  fs.mkdirSync(sessionDir)
  const file = path.join(sessionDir, '2026-10-28T01-00-00-000Z_01a20000-0000-7000-8000-000000000001.jsonl')
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: 'x', cwd: 'D:/project/one', title: 'First' }),
    // The entry's own `timestamp` is what the usage scan reads; the message's is what the transcript
    // shows. A real file carries both, so the fixture does too.
    JSON.stringify({
      type: 'message',
      id: 'e1',
      timestamp: '2026-10-28T01:00:00.000Z',
      message: { role: 'user', content: 'hello there', timestamp: 1_000 },
    }),
    JSON.stringify({
      type: 'message',
      id: 'e2',
      timestamp: '2026-10-28T01:00:05.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        provider: 'anthropic',
        model: 'claude',
        timestamp: 2_000,
        usage: { input: 10, output: 4, costUsd: 0.01 },
      },
    }),
    JSON.stringify({
      type: 'message',
      id: 'e3',
      timestamp: '2026-10-28T01:00:09.000Z',
      message: { role: 'user', content: 'third', timestamp: 3_000 },
    }),
    JSON.stringify({
      type: 'message',
      id: 'e4',
      timestamp: '2026-10-28T01:00:12.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'again' }],
        provider: 'anthropic',
        model: 'claude',
        timestamp: 4_000,
        usage: { input: 5, output: 6, costUsd: 0.002 },
      },
    }),
  ]
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
  const second = path.join(sessionDir, '2026-10-27T01-00-00-000Z_01a20000-0000-7000-8000-000000000002.jsonl')
  fs.writeFileSync(
    second,
    [
      JSON.stringify({ type: 'session', version: 3, id: 'y', cwd: 'D:/project/two', title: 'Second' }),
      // A third call, in the other workspace, so the project filter and the cross-file order are both
      // observable in one answer.
      JSON.stringify({
        type: 'message',
        id: 'f1',
        timestamp: '2026-10-28T01:00:20.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'elsewhere' }],
          provider: 'openai',
          model: 'gpt',
          timestamp: 5_000,
          usage: { input: 1, output: 1, costUsd: 0.003 },
        },
      }),
    ].join('\n') + '\n',
    'utf8',
  )
  return { root, paths: { sessionDir } as unknown as HostPaths }
}

/** The pieces of the SDK bundle these reads touch: the entry stream, and nothing else. */
function port(paths: HostPaths): PluginSessionsPort {
  return {
    paths,
    sdk: {
      visitSessionEntries: async (file: string, visit: (entry: unknown) => void) => {
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          if (line === '') continue
          visit(JSON.parse(line))
        }
      },
      loadSessionMessagesReadOnly: async () => [],
    } as unknown as SdkBundle,
  }
}

test('the list is newest first and carries the turn count', () => {
  const { paths, root } = fixture()
  const page = sessionList(port(paths), {})
  const rows = page.sessions as Record<string, unknown>[]
  assert.equal(rows.length, 2)
  // The store's own order is by modification time, newest first: the fixture writes 'Second' last,
  // so it carries the newer stamp.
  assert.deepEqual(rows.map(row => row.title), ['Second', 'First'])
  const first = rows.find(row => row.title === 'First') as Record<string, unknown>
  assert.equal(first.projectId, 'D:/project/one')
  assert.equal(first.turnCount, 4, 'every message entry is counted')
  assert.equal(
    (rows.find(row => row.title === 'Second') as Record<string, unknown>).turnCount,
    1,
  )
  assert.equal(page.nextCursor, null)
  fs.rmSync(root, { recursive: true, force: true })
})

test('a page honours the limit it was given and answers a cursor for the rest', () => {
  const { paths, root } = fixture()
  const first = sessionList(port(paths), { limit: 1 })
  assert.equal((first.sessions as unknown[]).length, 1)
  assert.equal(typeof first.nextCursor, 'string')
  const second = sessionList(port(paths), { limit: 1, cursor: first.nextCursor })
  assert.notDeepEqual(
    (second.sessions as Record<string, unknown>[])[0].sessionId,
    (first.sessions as Record<string, unknown>[])[0].sessionId,
    'the second page is the conversation the first one did not carry',
  )
  assert.equal(second.nextCursor, null)
  fs.rmSync(root, { recursive: true, force: true })
})


test('a project filter matches the workspace the conversation was written in', () => {
  const { paths, root } = fixture()
  const page = sessionList(port(paths), { projectId: 'D:/project/two' })
  assert.deepEqual(
    (page.sessions as Record<string, unknown>[]).map(row => row.title),
    ['Second'],
  )
  fs.rmSync(root, { recursive: true, force: true })
})


test('one conversation is answered by id, and an unknown id is a not_found', () => {
  const { paths, root } = fixture()
  const ids = sessionList(port(paths), {}).sessions as Record<string, unknown>[]
  const target = ids.find(row => row.title === 'First') as Record<string, unknown>
  const page = sessionGet(port(paths), { sessionId: target.sessionId })
  assert.equal((page.session as Record<string, unknown>).title, 'First')
  assert.throws(
    () => sessionGet(port(paths), { sessionId: 's0000000000000000' }),
    (error: unknown) => error instanceof HostError && error.code === ERROR_CODES.session_not_found,
  )
  fs.rmSync(root, { recursive: true, force: true })
})


test('messages carry an entry id and the time, and no body unless a budget was named', async () => {
  const { paths, root } = fixture()
  const id = sessionIdFor(
    path.join(paths.sessionDir, '2026-10-28T01-00-00-000Z_01a20000-0000-7000-8000-000000000001.jsonl'),
  )
  const store = port(paths)
  const bare = await sessionMessages(store, { sessionId: id })
  assert.deepEqual(bare.messages, [
    { id: 'e1', role: 'user', at: 1_000 },
    { id: 'e2', role: 'assistant', at: 2_000 },
    { id: 'e3', role: 'user', at: 3_000 },
    { id: 'e4', role: 'assistant', at: 4_000 },
  ])
  assert.equal(bare.total, 4)

  const withBody = await sessionMessages(store, { sessionId: id, contentLimit: 4 })
  assert.equal((withBody.messages as Record<string, unknown>[])[0].text, 'hell', 'the body is cut to its budget')
  assert.equal((withBody.messages as Record<string, unknown>[])[1].text, 'hi', 'a short body is untouched')
  fs.rmSync(root, { recursive: true, force: true })
})

test('a descending page walks the transcript from its end and hands back a cursor', async () => {
  const { paths, root } = fixture()
  const id = sessionIdFor(
    path.join(paths.sessionDir, '2026-10-28T01-00-00-000Z_01a20000-0000-7000-8000-000000000001.jsonl'),
  )
  const store = port(paths)
  const newest = await sessionMessages(store, { sessionId: id, limit: 2, order: 'desc' })
  assert.deepEqual(
    (newest.messages as Record<string, unknown>[]).map(row => row.id),
    ['e4', 'e3'],
    'the newest messages come first',
  )
  const earlier = await sessionMessages(store, {
    sessionId: id,
    limit: 2,
    order: 'desc',
    cursor: newest.nextCursor ?? undefined,
  })
  assert.deepEqual(
    (earlier.messages as Record<string, unknown>[]).map(row => row.id),
    ['e2', 'e1'],
  )
  assert.equal(earlier.nextCursor, null)
  fs.rmSync(root, { recursive: true, force: true })
})

test('a cursor from another transcript size is refused rather than shifted', async () => {
  const { paths, root } = fixture()
  const id = sessionIdFor(
    path.join(paths.sessionDir, '2026-10-28T01-00-00-000Z_01a20000-0000-7000-8000-000000000001.jsonl'),
  )
  await assert.rejects(
    sessionMessages(port(paths), { sessionId: id, cursor: 'c1@99' }),
    (error: unknown) => error instanceof HostError && error.code === ERROR_CODES.stale_cursor,
  )
  fs.rmSync(root, { recursive: true, force: true })
})

test('the usage rows are the model calls the engine recorded, inside the window', async () => {
  const { paths, root } = fixture()
  const page = await usageTurns(port(paths), { limit: 50 })
  const rows = page.turns as Record<string, unknown>[]
  assert.equal(page.total, 3, 'three calls, in two conversations')
  assert.deepEqual(
    rows.map(row => row.at),
    [
      Date.parse('2026-10-28T01:00:05.000Z'),
      Date.parse('2026-10-28T01:00:12.000Z'),
      Date.parse('2026-10-28T01:00:20.000Z'),
    ],
    'oldest call first, across files; the stamp is the entry\'s, as the usage page reads it',
  )
  assert.equal(rows[0].provider, 'anthropic')
  assert.equal(rows[0].model, 'claude')
  assert.equal(rows[0].input, 10)
  assert.equal(rows[0].output, 4)
  const outside = await usageTurns(port(paths), {
    fromMs: Date.parse('2027-01-01T00:00:00.000Z'),
  })
  assert.equal((outside.turns as unknown[]).length, 0, 'a window that starts after the call excludes it')
  fs.rmSync(root, { recursive: true, force: true })
})


test('a request this host cannot read is refused rather than guessed at', async () => {
  const { paths, root } = fixture()
  assert.throws(() => sessionList(port(paths), { limit: 0 }))
  assert.throws(() => sessionList(port(paths), { cursor: 'not-a-cursor' }), (error: unknown) =>
    error instanceof HostError && error.code === ERROR_CODES.stale_cursor)
  await assert.rejects(sessionMessages(port(paths), { sessionId: '' }))
  fs.rmSync(root, { recursive: true, force: true })
})

test('a cursor from another list size is refused rather than shifting the page', () => {
  const { paths, root } = fixture()
  const store = port(paths)
  const first = sessionList(store, { limit: 1 })
  assert.equal(first.total, 2)
  // The same cursor stamped against a list of one row: the store changed under the walk.
  assert.throws(
    () => sessionList(store, { limit: 1, cursor: `c1@1` }),
    (error: unknown) => error instanceof HostError && error.code === ERROR_CODES.stale_cursor,
  )
  assert.doesNotThrow(() => sessionList(store, { limit: 1, cursor: first.nextCursor as string }))
  fs.rmSync(root, { recursive: true, force: true })
})

test('a usage page reports the total of the whole window, not of the page', async () => {
  const { paths, root } = fixture()
  const store = port(paths)
  const first = await usageTurns(store, { limit: 1 })
  assert.equal(first.total, 3, 'the page is one row, the answer is still three calls')
  assert.equal((first.turns as unknown[]).length, 1)
  assert.equal(typeof first.nextCursor, 'string')
  const second = await usageTurns(store, { limit: 1, cursor: first.nextCursor as string })
  assert.equal(
    (second.turns as Record<string, unknown>[])[0].at,
    Date.parse('2026-10-28T01:00:12.000Z'),
    'the second page is the second call',
  )
  const third = await usageTurns(store, { limit: 1, cursor: second.nextCursor as string })
  assert.equal((third.turns as Record<string, unknown>[]).length, 1)
  assert.equal(third.nextCursor, null)
  fs.rmSync(root, { recursive: true, force: true })
})

test('the usage project filter runs before the page is cut', async () => {
  const { paths, root } = fixture()
  const store = port(paths)
  const one = await usageTurns(store, { projectId: 'D:/project/one', limit: 1 })
  assert.equal(one.total, 2, 'only the calls of that workspace are counted')
  const second = await usageTurns(store, {
    projectId: 'D:/project/one',
    limit: 1,
    cursor: one.nextCursor as string,
  })
  assert.equal(
    (second.turns as Record<string, unknown>[])[0]?.provider,
    'anthropic',
    'the second page is still inside the filtered stream',
  )
  assert.equal(second.nextCursor, null)
  const none = await usageTurns(store, { projectId: 'D:/project/absent' })
  assert.equal(none.total, 0)
  fs.rmSync(root, { recursive: true, force: true })
})

test('an ascending transcript page continues where the last one stopped', async () => {
  const { paths, root } = fixture()
  const id = sessionIdFor(
    path.join(paths.sessionDir, '2026-10-28T01-00-00-000Z_01a20000-0000-7000-8000-000000000001.jsonl'),
  )
  const store = port(paths)
  const first = await sessionMessages(store, { sessionId: id, limit: 2 })
  assert.deepEqual(
    (first.messages as Record<string, unknown>[]).map(row => row.id),
    ['e1', 'e2'],
  )
  assert.equal(first.total, 4)
  const second = await sessionMessages(store, {
    sessionId: id,
    limit: 2,
    cursor: first.nextCursor as string,
  })
  assert.deepEqual(
    (second.messages as Record<string, unknown>[]).map(row => row.id),
    ['e3', 'e4'],
  )
  assert.equal(second.nextCursor, null)
  fs.rmSync(root, { recursive: true, force: true })
})
