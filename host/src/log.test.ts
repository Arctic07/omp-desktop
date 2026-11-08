import assert from 'node:assert/strict'
import { test } from 'node:test'

import { sanitizeConfigMessage, sanitizeMessage } from './log.ts'
import { isToolMountNotice } from './session-view.ts'

/**
 * What the redactor may not swallow.
 *
 * The one thing it must never do is rewrite ordinary text the reader needs to read. Two regressions
 * are pinned here, and both were visible on screen before this file existed:
 *
 * - `xd://` (and every other scheme) read as a Windows drive path, so a mount notice arrived as
 *   `x<path>: unmounted ast_edit, debug, lsp` and the `/tools` list drew `~ x<path>` for each of
 *   its three mounted devices.
 * - the engine's `xd://` mount announcements themselves: one pair per toolset swap, naming devices
 *   the reader never addressed.
 */

test('a URL scheme is not a Windows drive path', () => {
  for (const text of [
    'xd://: unmounted ast_edit, debug, lsp',
    '~ xd://lsp',
    'read local://PLAN.md',
    'agent://all broadcast',
    'proc://bg_1 status',
    'see https://omp.sh/docs/sdk',
  ]) {
    assert.equal(sanitizeMessage(text), text, text)
  }
})

test('a drive path is still redacted, wherever it opens a word', () => {
  for (const [text, expected] of [
    ['open C:\\Users\\a\\.ssh\\id_rsa', 'open <path>'],
    ['cwd=C:\\project\\omp', 'cwd=<path>'],
    ['Plan autosaved to D:\\project\\omp-desktop\\PLAN.md.', 'Plan autosaved to <path>.'],
    ['C:/Users/x', '<path>'],
  ] as const) {
    assert.equal(sanitizeMessage(text), expected, text)
  }
  // The discovery warnings keep the file they name; credentials still go.
  assert.equal(sanitizeConfigMessage('config C:\\Users\\a\\.omp\\config.yml'), 'config C:\\Users\\a\\.omp\\config.yml')
})

test('only the mount announcement is dropped, and only by its source', () => {
  assert.equal(isToolMountNotice({ type: 'notice', source: 'xdev', message: 'xd://: mounted lsp' }), true)
  assert.equal(isToolMountNotice({ type: 'notice', source: 'slash-command', message: 'tools' }), false)
  assert.equal(isToolMountNotice({ type: 'notice', message: 'no source' }), false)
  assert.equal(isToolMountNotice({ type: 'error', source: 'xdev' }), false)
})
