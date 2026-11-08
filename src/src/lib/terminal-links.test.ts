import assert from 'node:assert/strict'
import { test } from 'node:test'

import { terminalLinkAction, type TerminalLinkEvent } from './terminal-links.ts'

function click(modifiers: Partial<TerminalLinkEvent> = {}): TerminalLinkEvent {
  return { ctrlKey: false, metaKey: false, ...modifiers }
}

test('a modified click opens the address', () => {
  assert.equal(terminalLinkAction(click({ ctrlKey: true })), 'open')
  assert.equal(terminalLinkAction(click({ metaKey: true })), 'open')
})

test('every other click belongs to the grid', () => {
  assert.equal(terminalLinkAction(click()), 'pass')
  const shifted = { ...click(), shiftKey: true, altKey: true }
  assert.equal(terminalLinkAction(shifted), 'pass')
})
