import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  COMPOSER_UNDO_CHARS,
  COMPOSER_UNDO_LIMIT,
  emptyComposerUndo,
  recordComposerEdit,
  redoComposerEdit,
  undoComposerEdit,
  type ComposerUndoState,
  type ComposerUndoStep,
} from './composer-undo.ts'

/**
 * The composer's own history: the states Ctrl+Z puts back, with typing coalesced into runs and the
 * limit holding the list.
 */

function step(draft: string, caret = draft.length): ComposerUndoStep {
  return { draft, caret, attachments: [] }
}

/** The drafts a state would undo through, newest first. */
function history(state: ComposerUndoState): string[] {
  return state.past.map((entry) => entry.draft)
}

test('a typing burst is one step, and a pause starts the next', () => {
  let state = emptyComposerUndo()
  state = recordComposerEdit(state, step(''), 0, true)
  state = recordComposerEdit(state, step('h'), 100, true)
  state = recordComposerEdit(state, step('he'), 200, true)
  assert.deepEqual(history(state), [''], 'the burst keeps the state it started from')

  state = recordComposerEdit(state, step('hello'), 2000, true)
  assert.deepEqual(
    history(state),
    ['', 'hello'],
    'a pause after the burst pushes the state it ended on',
  )
})

test('continuous typing still breaks into a step every couple of seconds', () => {
  let state = emptyComposerUndo()
  // 500ms apart: every gap is a pause-free keystroke, so only the burst's own length can split it.
  for (let index = 0; index < 6; index += 1) {
    state = recordComposerEdit(state, step('x'.repeat(index)), index * 500, true)
  }
  // 0s starts the burst; 2s ends it and starts another, whose keystroke at 2.5s does not push.
  assert.deepEqual(history(state), ['', 'xxxx'])
})

test('undo returns the previous draft and redo puts the newer one back', () => {
  let state = emptyComposerUndo()
  state = recordComposerEdit(state, step('', 0), 0, false)
  const undone = undoComposerEdit(state, step('pasted', 6))
  assert.ok(undone !== null)
  assert.equal(undone.step.draft, '')
  assert.equal(undone.step.caret, 0)

  const redone = redoComposerEdit(undone.state, step('', 0))
  assert.ok(redone !== null)
  assert.equal(redone.step.draft, 'pasted')
  assert.equal(redone.step.caret, 6)
})

test('a new edit clears the redo future', () => {
  let state = emptyComposerUndo()
  state = recordComposerEdit(state, step('one'), 0, false)
  const undone = undoComposerEdit(state, step('two'))
  assert.ok(undone !== null)
  state = recordComposerEdit(undone.state, step('one'), 100, false)
  assert.equal(redoComposerEdit(state, step('other')), null)
})

test('nothing to undo and nothing to redo are answered as null', () => {
  assert.equal(undoComposerEdit(emptyComposerUndo(), step('')), null)
  assert.equal(redoComposerEdit(emptyComposerUndo(), step('')), null)
})

test('the oldest step is dropped at the cap', () => {
  let state = emptyComposerUndo()
  for (let index = 0; index <= COMPOSER_UNDO_LIMIT; index += 1) {
    state = recordComposerEdit(state, step(`step-${index}`), index, false)
  }
  assert.equal(state.past.length, COMPOSER_UNDO_LIMIT)
  assert.equal(state.past[0]?.draft, 'step-1')
  assert.equal(state.past.at(-1)?.draft, `step-${COMPOSER_UNDO_LIMIT}`)
})

test('a huge draft does not keep a long history of copies of itself', () => {
  let state = emptyComposerUndo()
  state = recordComposerEdit(state, step('x'.repeat(COMPOSER_UNDO_CHARS)), 0, false)
  state = recordComposerEdit(state, step('a'), 1, false)
  // The two steps together are past the character cap: only the newest survives.
  assert.deepEqual(history(state), ['a'])
  assert.equal(state.pastChars, 1)
})
