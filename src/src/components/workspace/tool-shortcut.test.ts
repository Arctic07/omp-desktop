import assert from 'node:assert/strict'
import { test } from 'node:test'

import { TOOL_MENU_ENTRIES } from './tool-menu-entries.ts'
import { toolShortcutTarget } from './tool-shortcut.ts'

/** A keydown as the resolver reads it: the modifier pair every tool chord uses. */
function chord(key: string, overrides: Partial<Parameters<typeof toolShortcutTarget>[0]> = {}) {
  return toolShortcutTarget({
    key,
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: true,
    ...overrides,
  })
}

/**
 * The chords the menu prints and the chords the window listener answers are one set.
 *
 * Each entry's advertised letter is pressed here; a label that names a key nothing answers, or a
 * key that opens a tab no label mentions, fails.
 */
test('every advertised chord opens the tool its label names', () => {
  for (const entry of TOOL_MENU_ENTRIES) {
    if (entry.action === null) continue
    const letter = entry.shortcut.find((token) => token.length === 1)
    assert.ok(letter, `${entry.id} advertises no letter`)
    assert.equal(chord(letter), entry.action, `${entry.id} is advertised as ${entry.shortcut.join('+')}`)
  }
})

test('the terminal answers Ctrl Shift Z', () => {
  assert.equal(chord('z'), 'terminal')
  assert.equal(chord('Z'), 'terminal')
})

test('Cmd Shift Z is the same chord on a Mac', () => {
  assert.equal(chord('z', { ctrlKey: false, metaKey: true }), 'terminal')
})

test('the retired Ctrl+` chord opens nothing', () => {
  assert.equal(chord('`', { shiftKey: false }), null)
  assert.equal(chord('`'), null)
})

test('a chord the menu does not advertise is not a shortcut', () => {
  assert.equal(chord('z', { shiftKey: false }), null)
  assert.equal(chord('z', { altKey: true }), null)
  assert.equal(chord('x'), null)
})
