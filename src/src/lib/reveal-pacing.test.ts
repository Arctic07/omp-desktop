import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  RATE_CEILING,
  RATE_FLOOR,
  paceReveal,
  type RevealPacing,
} from './reveal-pacing.ts'

/**
 * What a streaming answer looks like frame by frame. These are the readings that decide whether the
 * text reads as writing or as blocks: how many characters one commit may add, how fast a burst is
 * caught up, and that no frame between two arrivals stands still.
 */

const FRAME_MS = 1000 / 60

/** Run the pacer over an arrival script, returning the characters each frame added. */
function run(targetAt: (frame: number) => number, frames: number): number[] {
  let pacing: RevealPacing = { shown: 0, carry: 0 }
  const steps: number[] = []
  for (let frame = 0; frame < frames; frame += 1) {
    const next = paceReveal(targetAt(frame), pacing, FRAME_MS)
    steps.push(next.shown - pacing.shown)
    pacing = next
  }
  return steps
}

test('a stream arriving at reading speed is drawn a character or two per frame', () => {
  // 120 characters a second (a fast model, CJK): two per frame, no bunched commits.
  const steps = run((frame) => Math.floor((frame * 120) / 60), 300)
  assert.ok(Math.max(...steps) <= 2, `one frame added ${Math.max(...steps)} characters`)
  // Once the answer is under way, the text never stands still for longer than a frame or two. The
  // opening frames are allowed to wait: the first characters are drawn at the floor rate, which is
  // slower than this stream arrives.
  const lagging = steps.slice(30)
  let standstill = 0
  let longest = 0
  for (const step of lagging) {
    standstill = step === 0 ? standstill + 1 : 0
    if (standstill > longest) longest = standstill
  }
  assert.ok(longest <= 2, `${longest} frames stood still in a row`)
})

test('a slow model is still drawn without bunching', () => {
  const steps = run((frame) => Math.floor((frame * 40) / 60), 300)
  assert.ok(Math.max(...steps) <= 2, `one frame added ${Math.max(...steps)} characters`)
})

test('a sentence delivered in one frame is spread out, not committed whole', () => {
  const burst = 200
  const steps = run((frame) => (frame < 5 ? 0 : burst), 200)
  assert.equal(steps[4], 0)
  assert.ok((steps[5] ?? 0) <= 6, `the burst's first frame added ${steps[5]} characters`)
  // Nine tenths of it is on screen within a second and a half, so the answer does not trail the
  // model by a paragraph.
  const drawnIn1_5s = steps.slice(0, 90).reduce((sum, step) => sum + step, 0)
  assert.ok(drawnIn1_5s >= burst * 0.9, `only ${drawnIn1_5s} of ${burst} drawn in 1.5s`)
  assert.equal(steps.reduce((sum, step) => sum + step, 0), burst)
})

test('the pace scales with the backlog instead of running at one fixed speed', () => {
  const quiet = paceReveal(400, { shown: 396, carry: 0 }, FRAME_MS)
  const flooding = paceReveal(4000, { shown: 0, carry: 0 }, FRAME_MS)
  assert.ok(quiet.shown - 396 < 3)
  assert.ok(flooding.shown > 10, 'a large backlog must be caught up faster than the floor')
  assert.ok(flooding.shown <= Math.ceil(RATE_CEILING * (FRAME_MS / 1000)) + 1)
})

test('the floor rate carries its remainder instead of dropping it', () => {
  // With a small backlog the floor rate applies: one 60 Hz frame is owed 0.75 characters, so the
  // second frame must draw one and the third another.
  let pacing: RevealPacing = { shown: 0, carry: 0 }
  const drawn: number[] = []
  for (let frame = 0; frame < 3; frame += 1) {
    const next = paceReveal(10, pacing, FRAME_MS)
    drawn.push(next.shown - pacing.shown)
    pacing = next
  }
  assert.deepEqual(drawn, [0, 1, 1])
  assert.ok(RATE_FLOOR * (FRAME_MS / 1000) < 1)
})

test('caught up costs nothing and leaves no carry behind', () => {
  assert.deepEqual(paceReveal(40, { shown: 40, carry: 0.9 }, FRAME_MS), { shown: 40, carry: 0 })
})

test('a step cut short by the end of the text does not spend its remainder on the next word', () => {
  const paced = paceReveal(10, { shown: 9, carry: 0.4 }, 500)
  assert.equal(paced.shown, 10)
  assert.equal(paced.carry, 0)
})
