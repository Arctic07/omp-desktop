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
 * - a URL scheme read as a Windows drive path: `help://` (`p:` before the separator), `local://`
 *   (`l:`), `agent://` (`t:`) and `https://` (`s:`) each present a shape the drive rule alone
 *   cannot tell from `C:\`, so a `/tools` line arrived as `~ <path>` and a mount notice as
 *   `<path>: …`.
 * - the engine's tool-command mount announcements themselves: one pair per toolset swap, naming
 *   tools the reader never addressed.
 */

test('a URL scheme is not a Windows drive path', () => {
  for (const text of [
    'read help://tools/read',
    '~ help://lsp',
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
  assert.equal(
    isToolMountNotice({ type: 'notice', source: 'toolCommands', message: 'Tool commands: added lsp' }),
    true,
  )
  assert.equal(isToolMountNotice({ type: 'notice', source: 'slash-command', message: 'tools' }), false)
  assert.equal(isToolMountNotice({ type: 'notice', message: 'no source' }), false)
  assert.equal(isToolMountNotice({ type: 'error', source: 'toolCommands' }), false)
})
