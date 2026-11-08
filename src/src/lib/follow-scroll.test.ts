import assert from 'node:assert/strict'
import { test } from 'node:test'

import { FOLLOW_SETTLED_PX, followAdvance } from './follow-scroll.ts'

/**
 * How the transcript follows a growing answer. The readings that matter are that a wrapped line is
 * cushioned rather than jumped, that a long way off still arrives quickly, and that the follow
 * always terminates instead of crawling asymptotically behind the floor.
 */

test('a line that just wrapped is drawn in over a few frames', () => {
  const step = followAdvance(24, 1000 / 60)
  assert.ok(step > 0 && step < 6, `one frame moved ${step}px of a 24px gap`)
  // Half a line is paid off inside a quarter of a second, so the new line is never left hanging
  // below the fold while the next one is written.
  let gap = 24
  for (let frame = 0; frame < 15; frame += 1) gap -= followAdvance(gap, 1000 / 60)
  assert.ok(gap < 6, `${gap}px still owed after 250 ms`)
  // And the tail is paid off rather than crawling: the glide ends inside a second.
  let frames = 15
  while (gap > FOLLOW_SETTLED_PX && frames < 90) {
    gap -= followAdvance(gap, 1000 / 60)
    frames += 1
  }
  assert.ok(frames <= 60, `${gap}px still owed after ${frames} frames`)
})

test('a jump across a long transcript moves at a capped, even pace', () => {
  const step = followAdvance(4000, 1000 / 60)
  assert.ok(step <= 120, `one frame moved ${step}px`)
  assert.ok(step >= 60, 'a long jump must not crawl')
})

test('growth during a suspension is still taken, one capped step at a time', () => {
  const step = followAdvance(800, 5000)
  assert.ok(step <= 120)
})

test('the follow settles instead of crawling forever', () => {
  assert.equal(followAdvance(FOLLOW_SETTLED_PX, 16), 0)
  assert.equal(followAdvance(0.2, 16), 0)
  assert.ok(followAdvance(1, 16) >= 1)
  // Every step is at least a pixel until it settles, or the tail would never end.
  let gap = 3
  let steps = 0
  while (gap > FOLLOW_SETTLED_PX && steps < 100) {
    gap -= followAdvance(gap, 1000 / 60)
    steps += 1
  }
  assert.ok(steps < 100)
})
