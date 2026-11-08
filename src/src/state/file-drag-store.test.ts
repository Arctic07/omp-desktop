import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  beginFileDrag,
  cancelFileDrag,
  fileDragStore,
  finishFileDrag,
  moveFileDrag,
  setFileDragOverlay,
  setFileDragTarget,
} from './file-drag-store.ts'

const PAYLOAD = { path: 'C:\\project\\omp-desktop\\README.md', name: 'README.md' }

function acceptOnly(inside: (x: number) => boolean) {
  const accepted: { path: string; x: number }[] = []
  setFileDragTarget({
    contains: (point) => inside(point.x),
    accept: (payload, point) => accepted.push({ path: payload.path, x: point.x }),
  })
  return accepted
}

test('a release inside the target is taken with the path and the release point', () => {
  const accepted = acceptOnly((x) => x >= 100)
  beginFileDrag(PAYLOAD, { x: 10, y: 20 })
  moveFileDrag({ x: 120, y: 30 })
  assert.equal(fileDragStore.get().over, true)
  assert.equal(finishFileDrag({ x: 130, y: 30 }), true)
  assert.deepEqual(accepted, [{ path: PAYLOAD.path, x: 130 }])
  assert.equal(fileDragStore.get().drag, null)
  setFileDragTarget(null)
})

test('a release outside the target is refused and ends the drag', () => {
  const accepted = acceptOnly(() => false)
  beginFileDrag(PAYLOAD, { x: 10, y: 20 })
  moveFileDrag({ x: 20, y: 20 })
  assert.equal(fileDragStore.get().over, false)
  assert.equal(finishFileDrag({ x: 30, y: 20 }), false)
  assert.deepEqual(accepted, [])
  assert.equal(fileDragStore.get().drag, null)
  setFileDragTarget(null)
})

test('cancelling ends the drag without delivering anything', () => {
  let accepted = 0
  setFileDragTarget({
    contains: () => true,
    accept: () => {
      accepted += 1
    },
  })
  beginFileDrag(PAYLOAD, { x: 1, y: 2 })
  cancelFileDrag()
  assert.equal(accepted, 0)
  assert.equal(fileDragStore.get().drag, null)
  setFileDragTarget(null)
})

test('a dialog drawn above the field takes a drag from the file tree inside its own box', () => {
  const accepted = acceptOnly(() => false)
  const inDialog: string[] = []
  setFileDragOverlay({
    contains: (point) => point.x >= 500,
    accept: (payload) => inDialog.push(payload.path),
  })
  try {
    beginFileDrag(PAYLOAD, { x: 400, y: 20 })
    moveFileDrag({ x: 600, y: 20 })
    // The field's own target refuses this box; the dialog above it takes it, and the field's own
    // drop face stays dark while the pointer is over the dialog.
    assert.equal(fileDragStore.get().overlayOver, true)
    assert.equal(fileDragStore.get().over, false)
    assert.equal(finishFileDrag({ x: 600, y: 20 }), true)
    assert.deepEqual(inDialog, [PAYLOAD.path])
    assert.deepEqual(accepted, [])
  } finally {
    setFileDragOverlay(null)
    setFileDragTarget(null)
  }
})
