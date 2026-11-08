import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  deliverDroppedPaths,
  setDesktopDropOverlay,
  setDesktopDropTarget,
} from './desktop-drop.ts'

/**
 * Where an OS drop is allowed to land.
 *
 * An OS drag cannot be staged from the page — the host owns the channel, and the page never sees a
 * DOM event for it — so the seam that decides "inside the composer accepts, anywhere else refuses"
 * is the only part of the drop path a test can hold. That seam is what keeps a file released over
 * the sidebar from being attached to a prompt the reader was not pointing at.
 */

const BOX = { left: 300, top: 100, right: 1100, bottom: 400 }

function target(): { accepted: string[][]; clear: () => void } {
  const accepted: string[][] = []
  setDesktopDropTarget({
    contains: (point) =>
      point.x >= BOX.left && point.x <= BOX.right && point.y >= BOX.top && point.y <= BOX.bottom,
    // The point goes with the paths: it is where inside the box the reader let go, which is the spot
    // the chips are written at.
    accept: (paths, point) => {
      accepted.push([...paths, `at ${point.x},${point.y}`])
    },
  })
  return { accepted, clear: () => setDesktopDropTarget(null) }
}

test('a release inside the composer is taken, with the paths it carried and where it landed', () => {
  const { accepted, clear } = target()
  try {
    assert.equal(deliverDroppedPaths(['C:\\work\\a.png'], { x: 500, y: 200 }), true)
    assert.deepEqual(accepted, [['C:\\work\\a.png', 'at 500,200']])
  } finally {
    clear()
  }
})

test('a release outside the composer is refused rather than attached', () => {
  const { accepted, clear } = target()
  try {
    // Over the conversation, to the left of the field, and below it: each is a place the reader is
    // pointing at something that is not the composer.
    assert.equal(deliverDroppedPaths(['C:\\work\\a.png'], { x: 150, y: 200 }), false)
    assert.equal(deliverDroppedPaths(['C:\\work\\a.png'], { x: 500, y: 20 }), false)
    assert.equal(deliverDroppedPaths(['C:\\work\\a.png'], { x: 500, y: 900 }), false)
    assert.deepEqual(accepted, [])
  } finally {
    clear()
  }
})

test('a drop with nothing in it, and a drop with no target, are both no-ops', () => {
  const { accepted, clear } = target()
  try {
    assert.equal(deliverDroppedPaths([], { x: 500, y: 200 }), false)
    clear()
    assert.equal(deliverDroppedPaths(['C:\\work\\a.png'], { x: 500, y: 200 }), false)
    assert.deepEqual(accepted, [])
  } finally {
    clear()
  }
})

test('a target that has gone stops accepting, so a field nobody can see takes nothing', () => {
  const { accepted, clear } = target()
  try {
    assert.equal(deliverDroppedPaths(['C:\\work\\a.png'], { x: 500, y: 200 }), true)
    clear()
    assert.equal(deliverDroppedPaths(['C:\\work\\b.png'], { x: 500, y: 200 }), false)
    assert.equal(accepted.length, 1)
  } finally {
    clear()
  }
})

/**
 * A dialog is stacked over the field, and both are registered while it asks.
 *
 * The pointer decides which one a release belongs to, so a file dropped on the dialog's answer box
 * becomes that answer's file instead of the draft's — and the field still takes everything below it.
 */

const DIALOG = { left: 400, top: 20, right: 1000, bottom: 90 }

function overlay(): { accepted: string[][]; clear: () => void } {
  const accepted: string[][] = []
  setDesktopDropOverlay({
    contains: (point) =>
      point.x >= DIALOG.left &&
      point.x <= DIALOG.right &&
      point.y >= DIALOG.top &&
      point.y <= DIALOG.bottom,
    accept: (paths) => {
      accepted.push([...paths])
    },
  })
  return { accepted, clear: () => setDesktopDropOverlay(null) }
}

test('a dialog drawn above the field takes the drop inside its box, and the field takes the rest', () => {
  const field = target()
  const dialog = overlay()
  try {
    assert.equal(deliverDroppedPaths(['C:\\work\\a.png'], { x: 600, y: 50 }), true)
    assert.deepEqual(dialog.accepted, [['C:\\work\\a.png']])
    assert.deepEqual(field.accepted, [])
    assert.equal(deliverDroppedPaths(['C:\\work\\b.png'], { x: 600, y: 200 }), true)
    assert.deepEqual(field.accepted, [['C:\\work\\b.png', 'at 600,200']])
    assert.deepEqual(dialog.accepted, [['C:\\work\\a.png']])
  } finally {
    dialog.clear()
    field.clear()
  }
})

test('a dialog that is gone leaves its own box to the field below it', () => {
  const field = target()
  const dialog = overlay()
  try {
    dialog.clear()
    // Where the dialog's box was is now nothing the field's own box covers.
    assert.equal(deliverDroppedPaths(['C:\\work\\a.png'], { x: 600, y: 50 }), false)
  } finally {
    dialog.clear()
    field.clear()
  }
})
