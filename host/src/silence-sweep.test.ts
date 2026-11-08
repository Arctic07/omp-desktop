import assert from 'node:assert/strict'
import { test } from 'node:test'

import { startSilenceSweep } from './silence-sweep.ts'

/**
 * The silence sweep's release.
 *
 * The case pinned here is the one a host teardown leaves behind: an interval whose owner has already
 * disposed the thing it walks. What is asserted is the behaviour - ticks happen while it is armed,
 * and the disposer is the only thing that stops them.
 *
 * Real timers, deliberately and briefly: the subject is a real interval against the process clock
 * (the fake-timer APIs `node:test` offers are not implemented by `bun test`, the runner this package
 * uses), and the whole case is a fifth of a second.
 */

const TICK_MS = 10
/** Long enough for several ticks at `TICK_MS` on a loaded machine. */
const WINDOW_MS = 60

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

test('the sweep ticks while armed and stops when its disposer is called', async () => {
  let ticks = 0
  const stop = startSilenceSweep(() => {
    ticks += 1
  }, TICK_MS)

  await sleep(WINDOW_MS)
  const whileArmed = ticks
  assert.ok(whileArmed > 0, 'the sweep ran')

  stop()
  await sleep(WINDOW_MS)
  assert.equal(ticks, whileArmed, 'nothing fired after the disposer')
})

test('disposing twice is not a second teardown', async () => {
  let ticks = 0
  const stop = startSilenceSweep(() => {
    ticks += 1
  }, TICK_MS)
  stop()
  stop()
  await sleep(WINDOW_MS)
  assert.equal(ticks, 0, 'the timer stayed stopped')
})
