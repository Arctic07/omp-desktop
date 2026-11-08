import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  browserEventSession,
  browserTabIdOf,
  browserTabLabel,
  browserTabRefOf,
  nextTerminalNumber,
  terminalTabLabel,
  type TerminalTab,
} from './panel-tabs.ts'

/**
 * The terminal tab's own name.
 *
 * What is pinned down: numbers belong to one conversation's strip. Every conversation reads
 * `PowerShell-1`, `-2`, … on its own, a number comes back when its tab is closed, and a tab that
 * outlived its shell keeps the number it had — so two tabs of one conversation never read alike.
 * Numbering by anything shared between conversations (the pty id, a page-wide counter) is what made
 * a fresh conversation open at `PowerShell-3`.
 */

/** A tab as the rules see it: the number is what the strip allocated, nothing else. */
function tab(id: number, number: number): TerminalTab {
  return {
    id,
    number,
    label: terminalTabLabel('PowerShell', number),
    ownerSessionFile: '',
    cwd: '',
  }
}

test('a conversation numbers its tabs from one', () => {
  assert.equal(nextTerminalNumber([]), 1)
  assert.equal(nextTerminalNumber([tab(1, 1)]), 2)
  assert.equal(nextTerminalNumber([tab(1, 1), tab(2, 2), tab(3, 3)]), 4)
})

test('a closed tab gives its number back', () => {
  assert.equal(nextTerminalNumber([tab(1, 1), tab(3, 3)]), 2, 'the gap is filled first')
  assert.equal(nextTerminalNumber([tab(2, 2), tab(3, 3)]), 1)
})

test('a tab keeps its number while its shell is gone', () => {
  // The tab stays in the strip after the shell exits, so its number is still taken: reusing it
  // would leave two tabs of one conversation reading `PowerShell-2`.
  const exited: TerminalTab = { ...tab(1, 2), exited: true }
  assert.equal(nextTerminalNumber([exited, tab(2, 1)]), 3)
})

test('a tab reads as its name plus its number', () => {
  assert.equal(terminalTabLabel('PowerShell', 1), 'PowerShell-1')
  assert.equal(terminalTabLabel('终端', 2), '终端-2')
  assert.equal(tab(1, 12).label, 'PowerShell-12')
})

test('a browser tab ref round-trips and its label reads the host or file name', () => {
  assert.equal(browserTabRefOf('tab-3'), 'browser:tab-3')
  assert.equal(browserTabIdOf(browserTabRefOf('tab-3')), 'tab-3')
  assert.equal(browserTabIdOf('plugin:x'), null)
  assert.equal(browserTabLabel('https://example.com/a'), 'example.com')
  assert.equal(browserTabLabel('file:///D:/project/dist/index.html'), 'index.html')
  assert.equal(browserTabLabel(''), '浏览器')
})

/**
 * Which conversation one browser shell event may draw into.
 *
 * The strip creates the tab from an event the desktop sent, and the conversation the event names is
 * the only place it can live: a plugin's own built-in-browser page belongs to an installation, and
 * `services::browser` announces nothing about it (`BrowserService::plugin_reveal`) - so an event that
 * names no conversation draws nothing. Reading such a key as a conversation's is what used to
 * materialise the pseudo-conversation tab a `pi.browser.reveal` left behind.
 */

test('a browser shell event draws into the conversation it names', () => {
  assert.equal(browserEventSession({ sessionId: 'session-1' }), 'session-1')
  assert.equal(browserEventSession({ sessionId: ' session-1 ' }), 'session-1')
})

test('a browser shell event that names no conversation draws nothing', () => {
  assert.equal(browserEventSession({ sessionId: '' }), null)
  assert.equal(browserEventSession({ sessionId: '   ' }), null)
  assert.equal(browserEventSession({}), null)
})
