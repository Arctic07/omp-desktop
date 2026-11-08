import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  blockingOverlayCovers,
  pushBlockingOverlay,
  pushBlockingOverlayElement,
  type OverlayRect,
} from './overlay-depth.ts'

/**
 * What "above the document" means for the native browser guest.
 *
 * The guest always paints above HTML, so the only way to show a surface over it is to hide it. The
 * store decides which surfaces are actually over the hole: a dialog covers every rectangle, a
 * popover covers only the rectangle it intersects. Hiding for a menu above the title bar or a card
 * above the composer is what blacked the browser out whenever one opened.
 */

const HOLE: OverlayRect = { left: 900, top: 300, right: 1400, bottom: 800 }

/** A panel the store can measure, standing in for a portalled popover. */
function surface(rect: OverlayRect): Element {
  return {
    getBoundingClientRect: () => ({
      ...rect,
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
      toJSON() {},
    }),
  } as unknown as Element
}

test('a full-window surface covers every rectangle', () => {
  const release = pushBlockingOverlay()
  assert.equal(blockingOverlayCovers(HOLE), true)
  release()
  assert.equal(blockingOverlayCovers(HOLE), false)
})

test('a surface outside the hole leaves the guest visible', () => {
  const release = pushBlockingOverlayElement(surface({ left: 40, top: 30, right: 260, bottom: 240 }))
  assert.equal(blockingOverlayCovers(HOLE), false)
  release()
})

test('a surface over the hole hides the guest until it closes', () => {
  const release = pushBlockingOverlayElement(surface({ left: 800, top: 250, right: 1000, bottom: 400 }))
  assert.equal(blockingOverlayCovers(HOLE), true)
  release()
  assert.equal(blockingOverlayCovers(HOLE), false)
})

test('the rectangle is read live, not captured when the surface registered', () => {
  let rect: OverlayRect = { left: 0, top: 0, right: 100, bottom: 100 }
  const release = pushBlockingOverlayElement({
    getBoundingClientRect: () => rect,
  } as unknown as Element)
  assert.equal(blockingOverlayCovers(HOLE), false)
  rect = { left: 900, top: 300, right: 1000, bottom: 400 }
  assert.equal(blockingOverlayCovers(HOLE), true)
  release()
})

test('an unmeasured surface covers nothing', () => {
  const release = pushBlockingOverlayElement(surface({ left: 0, top: 0, right: 0, bottom: 0 }))
  assert.equal(blockingOverlayCovers(HOLE), false)
  release()
})

test('releasing twice does not leave a phantom surface', () => {
  const release = pushBlockingOverlayElement(surface(HOLE))
  release()
  release()
  assert.equal(blockingOverlayCovers(HOLE), false)
})
