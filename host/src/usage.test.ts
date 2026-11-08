import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import type { HostPaths } from './env.ts'
import type { SdkBundle } from './sdk.ts'
import { summary } from './usage.ts'
import { forgetUsageIndex, USAGE_INDEX_VERSION } from './usage-index.ts'

/**
 * The usage page's own read: an index over the session store that a page load costs a stat per file.
 *
 * These tests pin the behavior the page depends on - one pass parses a file and every later pass
 * reads it only when it changed - and the numbers it publishes: lifetime totals over everything, a
 * window over whole local days, and a cut that is reported rather than silently shrinking a total.
 */

const DAY_MS = 86_400_000

/** One usage entry, as the engine writes a settled assistant turn. */
function message(provider: string, model: string, atMs: number, input: number, output: number): string {
  return `${JSON.stringify({
    type: 'message',
    timestamp: new Date(atMs).toISOString(),
    message: { role: 'assistant', provider, model, usage: { input, output, cacheRead: 0, cacheWrite: 0 } },
  })}\n`
}

/** A call the engine kept out of the transcript, which carries its own usage. */
function modelUsage(provider: string, model: string, atMs: number, input: number): string {
  return `${JSON.stringify({
    type: 'model_usage',
    timestamp: new Date(atMs).toISOString(),
    provider,
    model,
    usage: { input },
  })}\n`
}

/** A store with one directory and an index file beside it, plus the visits a fake engine records. */
interface Store {
  readonly root: string
  readonly paths: HostPaths
  readonly visits: Map<string, number>
  readonly sdk: SdkBundle
  write(name: string, body: string): string
}

function store(): Store {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-usage-'))
  const sessionDir = path.join(root, 'sessions')
  fs.mkdirSync(sessionDir)
  const visits = new Map<string, number>()
  const sdk = {
    visitSessionEntries: async (
      file: string,
      visit: (entry: unknown) => void | boolean,
      options?: { onMalformedRecord?: () => void },
    ) => {
      visits.set(file, (visits.get(file) ?? 0) + 1)
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (line.length === 0) continue
        let entry: unknown
        try {
          entry = JSON.parse(line)
        } catch {
          options?.onMalformedRecord?.()
          continue
        }
        visit(entry)
      }
    },
  } as unknown as SdkBundle
  const store: Store = {
    root,
    paths: {
      sessionDir,
      usageIndexFile: path.join(root, 'usage-index.json'),
    } as unknown as HostPaths,
    visits,
    sdk,
    write(name, body) {
      const file = path.join(sessionDir, name)
      fs.appendFileSync(file, body, 'utf8')
      return file
    },
  }
  forgetUsageIndex()
  return store
}

/** The published payload, as the frontend reads it. */
interface Payload {
  rangeDays: number | null
  scanned: { files: number; sessions: number; skipped: number; elapsedMs: number; truncated: boolean }
  totals: { input: number; output: number; calls: number; cacheRead: number; costUsd: number }
  byModel: { provider: string | null; model: string | null; input: number; calls: number }[]
  byDay: { day: string; input: number; calls: number }[]
  bySession: { fileName: string; input: number; calls: number }[]
}

async function read(store: Store, rangeDays: number | null = null): Promise<Payload> {
  const payload = await summary(store.paths, store.sdk, rangeDays === null ? {} : { rangeDays })
  return payload as unknown as Payload
}

test('a second read parses nothing and answers the same numbers', async () => {
  const fixture = store()
  fixture.write('a.jsonl', message('p', 'm1', Date.now() - DAY_MS, 100, 10))
  fixture.write('b.jsonl', modelUsage('p', 'm2', Date.now() - DAY_MS, 7))

  const first = await read(fixture)
  assert.equal(first.totals.input, 107)
  assert.equal(first.totals.output, 10)
  assert.equal(first.totals.calls, 2)
  assert.equal(first.scanned.sessions, 2)
  assert.equal(fixture.visits.size, 2)

  const second = await read(fixture)
  assert.deepEqual(second.totals, first.totals)
  assert.deepEqual(second.byModel, first.byModel)
  assert.deepEqual(second.bySession, first.bySession)
  // Every file was already current: the store was stat'ed, not read.
  for (const count of fixture.visits.values()) assert.equal(count, 1)
})

test('an appended turn re-reads only the file it landed in', async () => {
  const fixture = store()
  const first = fixture.write('a.jsonl', message('p', 'm1', Date.now() - DAY_MS, 100, 10))
  fixture.write('b.jsonl', message('p', 'm1', Date.now() - DAY_MS, 5, 1))
  const before = await read(fixture)

  fs.appendFileSync(first, message('p', 'm1', Date.now(), 20, 2), 'utf8')
  const after = await read(fixture)

  assert.equal(after.totals.input, before.totals.input + 20)
  assert.equal(after.totals.output, before.totals.output + 2)
  assert.equal(fixture.visits.get(first), 2)
  const other = path.join(fixture.paths.sessionDir, 'b.jsonl')
  assert.equal(fixture.visits.get(other), 1)
})

test('a deleted session stops counting and a corrupt index is rebuilt from the store', async () => {
  const fixture = store()
  const gone = fixture.write('a.jsonl', message('p', 'm1', Date.now() - DAY_MS, 100, 10))
  fixture.write('b.jsonl', message('p', 'm1', Date.now() - DAY_MS, 5, 1))
  assert.equal((await read(fixture)).totals.input, 105)

  fs.rmSync(gone)
  const afterDelete = await read(fixture)
  assert.equal(afterDelete.totals.input, 5)
  assert.equal(afterDelete.bySession.length, 1)

  fs.writeFileSync(fixture.paths.usageIndexFile, '{"version":1,"files":', 'utf8')
  forgetUsageIndex()
  const rebuilt = await read(fixture)
  assert.equal(rebuilt.totals.input, 5)
  assert.equal(JSON.parse(fs.readFileSync(fixture.paths.usageIndexFile, 'utf8')).version, USAGE_INDEX_VERSION)
})

test('a window counts whole local days and the lifetime answer counts everything', async () => {
  const fixture = store()
  fixture.write(
    'a.jsonl',
    message('p', 'old', Date.now() - 40 * DAY_MS, 100, 0) +
      message('p', 'recent', Date.now() - DAY_MS, 7, 3),
  )

  const lifetime = await read(fixture)
  assert.equal(lifetime.totals.input, 107)
  assert.equal(lifetime.totals.calls, 2)
  assert.equal(lifetime.byDay.length, 2)

  const window = await read(fixture, 7)
  assert.equal(window.totals.input, 7)
  assert.equal(window.totals.calls, 1)
  assert.equal(window.byDay.length, 1)
  assert.equal(window.byDay[0]?.input, 7)
})

test('an entry with no usable timestamp is skipped instead of landing on today', async () => {
  const fixture = store()
  fixture.write(
    'a.jsonl',
    message('p', 'm1', Date.now() - DAY_MS, 10, 1) +
      `${JSON.stringify({ type: 'message', timestamp: 'not-a-date', message: { provider: 'p', model: 'm1', usage: { input: 999 } } })}\n` +
      'not json at all\n',
  )

  const payload = await read(fixture)
  assert.equal(payload.totals.input, 10)
  assert.equal(payload.totals.calls, 1)
  assert.equal(payload.scanned.skipped, 2)
})

test('the lifetime and the window reads issued together share one pass', async () => {
  const fixture = store()
  const file = fixture.write('a.jsonl', message('p', 'm1', Date.now() - DAY_MS, 10, 1))

  const [lifetime, window] = await Promise.all([read(fixture), read(fixture, 7)])
  assert.equal(lifetime.totals.input, 10)
  assert.equal(window.totals.input, 10)
  assert.equal(fixture.visits.get(file), 1)
})

test('a session file that cannot be read is reported as skipped, not counted as empty', async () => {
  const fixture = store()
  fixture.write('a.jsonl', message('p', 'm1', Date.now() - DAY_MS, 10, 1))
  const broken = fixture.write('b.jsonl', message('p', 'm1', Date.now() - DAY_MS, 10, 1))
  const failing = {
    visitSessionEntries: async (file: string, visit: (entry: unknown) => void | boolean) => {
      if (file === broken) throw new Error('read failed')
      fixture.sdk.visitSessionEntries(file, visit)
    },
  } as unknown as SdkBundle

  const payload = (await summary(fixture.paths, failing, {})) as unknown as Payload
  assert.equal(payload.totals.input, 10)
  assert.equal(payload.scanned.sessions, 1)
  assert.equal(payload.scanned.skipped, 1)
})
