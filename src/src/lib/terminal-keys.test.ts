import assert from 'node:assert/strict'
import { test } from 'node:test'

import { terminalKeyAction, type TerminalKeyEvent } from './terminal-keys.ts'

function chord(key: string, modifiers: Partial<TerminalKeyEvent> = {}): TerminalKeyEvent {
  return { type: 'keydown', key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers }
}

test('ctrl+c with a selection copies and never reaches the pty', () => {
  assert.equal(terminalKeyAction(chord('c', { ctrlKey: true }), true), 'copy')
  assert.equal(terminalKeyAction(chord('C', { ctrlKey: true }), true), 'copy')
})

test('ctrl+c with nothing selected is the shell interrupt', () => {
  assert.equal(terminalKeyAction(chord('c', { ctrlKey: true }), false), 'pass')
})

test('the dedicated copy chords copy, and do nothing without a selection', () => {
  for (const event of [
    chord('c', { ctrlKey: true, shiftKey: true }),
    chord('Insert', { ctrlKey: true }),
    chord('c', { metaKey: true }),
  ]) {
    assert.equal(terminalKeyAction(event, true), 'copy')
    assert.equal(terminalKeyAction(event, false), 'swallow')
  }
})

test('other chords and non-keydown events are xterm’s', () => {
  assert.equal(terminalKeyAction(chord('v', { ctrlKey: true }), true), 'pass')
  assert.equal(terminalKeyAction(chord('c', { ctrlKey: true, altKey: true }), true), 'pass')
  assert.equal(terminalKeyAction(chord('c', { ctrlKey: true, metaKey: true }), true), 'pass')
  assert.equal(terminalKeyAction({ ...chord('c', { ctrlKey: true }), type: 'keyup' }, true), 'pass')
  assert.equal(terminalKeyAction({ ...chord('c', { ctrlKey: true }), type: 'keypress' }, true), 'pass')
})
