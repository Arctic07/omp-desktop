import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  OPEN_IN_APPS,
  OPEN_IN_APP_COPY,
  defaultOpenInAppFor,
  orderedOpenInApps,
} from './open-in-app-copy.ts'

/**
 * The menu's two rules: the desktop's ids, in this page's order, and a default that survives an
 * app being uninstalled.
 *
 * The catalogue is the desktop's answer (`open_in_app_apps`), and it can hold ids this page has no
 * name for — those stay off the menu rather than appearing as raw tokens. The remembered choice is
 * localStorage's, which outlives an uninstall: it only counts while that id is still installed.
 */

test('installed ids come back in menu order, not catalogue order', () => {
  const installed = ['gitbash', 'windowsterminal', 'explorer', 'cursor', 'vscode']
  assert.deepEqual(orderedOpenInApps(installed), [
    'vscode',
    'cursor',
    'explorer',
    'windowsterminal',
    'gitbash',
  ])
})

test('ids this page cannot name, and repeats, never reach the menu', () => {
  assert.deepEqual(orderedOpenInApps(['future-editor', 'vscode', 'vscode']), ['vscode'])
  assert.deepEqual(orderedOpenInApps([]), [])
})

test('every offered id is named in both languages', () => {
  for (const id of OPEN_IN_APPS) {
    assert.ok(OPEN_IN_APP_COPY.en.names[id], `en names ${id}`)
    assert.ok(OPEN_IN_APP_COPY.zh.names[id], `zh names ${id}`)
  }
})

test('a remembered app is the default while it is installed', () => {
  const installed = ['explorer', 'cursor', 'vscode']
  assert.equal(defaultOpenInAppFor(installed, 'cursor'), 'cursor')
})

test('an uninstalled or unknown remembered app falls back to the first installed', () => {
  const installed = ['explorer', 'cursor']
  assert.equal(defaultOpenInAppFor(installed, 'vscode'), 'cursor')
  assert.equal(defaultOpenInAppFor(installed, 'future-editor'), 'cursor')
  assert.equal(defaultOpenInAppFor([], 'cursor'), null)
})
