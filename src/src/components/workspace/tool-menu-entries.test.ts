import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { PluginPages, PluginPageRef } from '@/state/plugin-pages.ts'
import { TOOL_MENU_ENTRIES, servedToolEntries, toolEntryLocked } from './tool-menu-entries.ts'

const SERVED = { terminal: true, browser: true }

/** One contributed page, with the fields the menu reads. */
function page(key: string, title: string, extra: Partial<PluginPageRef> = {}): PluginPageRef {
  return {
    key,
    kind: 'view',
    pluginKey: 'demo\u0000user',
    pluginId: 'demo',
    scope: 'user',
    pluginName: 'Demo',
    pageId: key,
    title,
    icon: null,
    url: `http://omp-plugin.demo/${key}`,
    order: 10,
    width: null,
    height: null,
    resizable: false,
    builtin: false,
    ...extra,
  }
}

function pages(overrides: Partial<PluginPages> = {}): PluginPages {
  return { sidebar: [], views: [], settings: [], panels: [], workTabs: [], ...overrides }
}

/**
 * What a menu offers, and what it greys out.
 *
 * A tool whose plugin is not served is left out in either state. The two tools that read a
 * conversation's transcript are *listed but locked* in a conversation nothing has been sent in: the
 * reader unlocks them by sending a message, and a row that vanished would never say why.
 */
test('every served tool is listed, in the strip order', () => {
  assert.deepEqual(
    servedToolEntries(SERVED).map((entry) => entry.action),
    ['git', 'terminal', 'browser', 'file'],
  )
})

test('the git review and the file viewer are locked before the first message', () => {
  const locked = servedToolEntries(SERVED)
    .filter((entry) => toolEntryLocked(entry.action, true))
    .map((entry) => entry.action)
  assert.deepEqual(locked, ['git', 'file'])
})

test('a conversation with a message locks nothing', () => {
  assert.deepEqual(
    servedToolEntries(SERVED).filter((entry) => toolEntryLocked(entry.action, false)),
    [],
  )
})

test('every built-in tool has its own advertised shortcut', () => {
  const chords = TOOL_MENU_ENTRIES.map((entry) => entry.shortcut.join('+'))
  assert.equal(new Set(chords).size, chords.length, 'one keystroke cannot open two tools')
  assert.deepEqual(
    TOOL_MENU_ENTRIES.find((entry) => entry.action === 'browser')?.shortcut,
    ['Ctrl', 'Shift', 'B'],
  )
  assert.deepEqual(
    TOOL_MENU_ENTRIES.find((entry) => entry.action === 'terminal')?.shortcut,
    ['Ctrl', 'Shift', 'Z'],
  )
})

test('a tool whose plugin is not served is left out rather than locked', () => {
  assert.deepEqual(
    servedToolEntries({ terminal: false, browser: false }).map((entry) => entry.action),
    ['git', 'file'],
  )
})

test('the pages a plugin contributes are rows of the same menu', () => {
  const entries = servedToolEntries(SERVED, pages({
    sidebar: [page('console', '演示控制台')],
    views: [page('log', '演示日志')],
  }))
  assert.deepEqual(
    entries.map((entry) => entry.label),
    ['改动', '终端', '浏览器', '文件', '演示控制台', '演示日志'],
  )
  const contributed = entries.filter((entry) => entry.action === null)
  assert.deepEqual(contributed.map((entry) => entry.pageKey), ['console', 'log'])
  assert.equal(contributed[0].id, 'plugin:console', 'the row id is the page key, not the label')
  // A page writes nothing into the conversation, so it is never greyed for being unwritten.
  assert.deepEqual(contributed.filter((entry) => toolEntryLocked(entry.action, true)), [])
})

test('a page appears once even when two lists carry it', () => {
  const entries = servedToolEntries(SERVED, pages({
    sidebar: [page('log', '演示日志')],
    views: [page('log', '演示日志')],
  }))
  assert.deepEqual(entries.filter((entry) => entry.action === null).map((entry) => entry.pageKey), ['log'])
})
