import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import { reclaimCaches, reclaimWindow } from './reclaim.ts'

/**
 * What the engine reclaim touches and what it refuses to.
 *
 * Every case builds its own tree: the module deletes directories, so a shared fixture would let one
 * test's removal decide another's answer.
 */

/** A config root with the engine's layout under it, and a home beside it. */
function layout(tag: string): { root: string; home: string; configRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `omp-reclaim-${tag}-`))
  const home = path.join(root, 'home')
  const configRoot = path.join(home, 'omp-desktop')
  fs.mkdirSync(configRoot, { recursive: true })
  return { root, home, configRoot }
}

/** A file of `bytes` bytes at `target`, stamped `ageMs` in the past, parents and all. */
function file(target: string, bytes: number, ageMs: number): string {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, 'x'.repeat(bytes))
  const stamp = new Date(Date.now() - ageMs)
  fs.utimesSync(target, stamp, stamp)
  return target
}

const DAY = 24 * 60 * 60 * 1000

/** The explicit clear's options: the settings page sends no window, so `reclaimWindow` answers a day. */
function manual(now: number): { engineVersion: string; recentMs: number; now: number } {
  return { engineVersion: '18.12.6', recentMs: reclaimWindow(undefined), now }
}

test('a native build written to today is left alone', () => {
  const { root, home, configRoot } = layout('in-use')
  const build = path.join(home, '.omp', 'natives', '18.11.0')
  // A minute ago: this is the build a running engine is still writing to.
  file(path.join(build, 'pi_natives.node'), 42, 60 * 1000)

  const outcome = reclaimCaches(
    { configRoot, home },
    manual(Date.now()),
  )

  assert.equal(outcome.removed.length, 0)
  assert.equal(outcome.freedBytes, 0)
  assert.equal(outcome.skipped.length, 1)
  assert.equal(outcome.skipped[0]?.reason, 'in-use')
  assert.equal(outcome.skipped[0]?.bytes, 42)
  assert.equal(fs.existsSync(build), true, 'the live build is untouched')
  fs.rmSync(root, { recursive: true, force: true })
})

test('the native addon of the running engine stays and the older one goes', () => {
  const { root, home, configRoot } = layout('natives')
  const current = path.join(home, '.omp', 'natives', '18.12.6')
  const stale = path.join(home, '.omp', 'natives', '18.6.1')
  file(path.join(current, 'pi_natives.node'), 500, 10 * DAY)
  file(path.join(stale, 'pi_natives.node'), 700, 20 * DAY)

  const outcome = reclaimCaches(
    { configRoot, home },
    manual(Date.now()),
  )

  assert.equal(outcome.removed.length, 1)
  assert.equal(outcome.removed[0]?.path, stale)
  assert.equal(outcome.freedBytes, 700)
  assert.equal(fs.existsSync(current), true, 'the running engine keeps its addon')
  assert.equal(
    outcome.skipped.find((entry) => entry.path === current)?.reason,
    'current-version',
  )
  fs.rmSync(root, { recursive: true, force: true })
})

test('a target outside the engine tree is refused rather than followed', () => {
  const { root, home, configRoot } = layout('outside')
  // An entry that is a link to somewhere else: this application never makes one, so the reclaim
  // refuses it instead of deleting what it points at.
  const elsewhere = path.join(root, 'elsewhere')
  file(path.join(elsewhere, 'important.txt'), 10, 30 * DAY)
  const natives = path.join(home, '.omp', 'natives')
  fs.mkdirSync(natives, { recursive: true })
  fs.symlinkSync(elsewhere, path.join(natives, 'linked'), 'junction')

  const outcome = reclaimCaches(
    { configRoot, home },
    manual(Date.now()),
  )

  assert.equal(outcome.removed.length, 0)
  assert.equal(outcome.skipped.length, 1)
  assert.equal(outcome.skipped[0]?.reason, 'outside-root')
  assert.equal(fs.existsSync(path.join(elsewhere, 'important.txt')), true)
  fs.rmSync(root, { recursive: true, force: true })
})

test('an engine with nothing cached answers nothing rather than failing', () => {
  const { root, home, configRoot } = layout('empty')
  const outcome = reclaimCaches(
    { configRoot, home },
    manual(Date.now()),
  )
  assert.deepEqual(outcome, { freedBytes: 0, removed: [], skipped: [] })
  fs.rmSync(root, { recursive: true, force: true })
})

test('the automatic pass keeps what the explicit clear removes', () => {
  const { root, home, configRoot } = layout('window')
  // Written two days ago: a leftover for the clear's one-day window, in use for the automatic pass's
  // week - nobody is watching that pass, so it is the conservative one.
  const build = path.join(home, '.omp', 'natives', '18.11.0')
  file(path.join(build, 'pi_natives.node'), 128, 2 * DAY)

  const automatic = reclaimCaches(
    { configRoot, home },
    { engineVersion: '18.12.6', recentMs: reclaimWindow(7 * DAY), now: Date.now() },
  )
  assert.deepEqual(
    automatic.skipped.map((entry) => entry.reason),
    ['in-use'],
    'the automatic pass leaves a two-day-old build alone',
  )
  assert.equal(fs.existsSync(build), true)

  const clear = reclaimCaches({ configRoot, home }, manual(Date.now()))
  assert.equal(clear.freedBytes, 128)
  assert.equal(fs.existsSync(build), false, 'the explicit clear takes it')
  fs.rmSync(root, { recursive: true, force: true })
})

test('a frame with no window, and one with a nonsense window, both answer a day', () => {
  const day = 24 * 60 * 60 * 1000
  assert.equal(reclaimWindow(undefined), day)
  assert.equal(reclaimWindow(0), day)
  assert.equal(reclaimWindow(-1), day)
  assert.equal(reclaimWindow(Number.NaN), day)
  assert.equal(reclaimWindow('604800000'), day)
  assert.equal(reclaimWindow(7 * day), 7 * day)
})
