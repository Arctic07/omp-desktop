import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ToolMinimized } from '../api/session-types.ts'
import { formatMinimized, oneLinePreview } from './conversation-format.ts'
import { formatBytes } from '../lib/bytes.ts'

/**
 * The minimizer line a shell row draws.
 *
 * The engine reports the bytes its output minimizer took a command's output from and to, and its own
 * card states them as one line (`git 120.4KB → 3.2KB`). The desktop restates that judgement for its
 * own surface, so the two readings are the same numbers with the same units — a row that said
 * `120KB` where the terminal says `120.4KB` would be a second account of one capture.
 */

test('bytes read in the same units the engine prints', () => {
  assert.equal(formatBytes(0), '0B')
  assert.equal(formatBytes(1023), '1023B')
  // The unit boundary is where two surfaces disagree most easily: 1024 bytes is the first KB.
  assert.equal(formatBytes(1024), '1.0KB')
  assert.equal(formatBytes(123_289), '120.4KB')
  assert.equal(formatBytes(1024 * 1024), '1.0MB')
  assert.equal(formatBytes(3 * 1024 * 1024 * 1024), '3.0GB')
})

test('the line leads with the filter, and states the bytes even without one', () => {
  const git: ToolMinimized = { filter: 'git', inputBytes: 123_289, outputBytes: 3_276 }
  assert.equal(formatMinimized(git), 'git 120.4KB → 3.2KB')
  assert.equal(
    formatMinimized({ filter: '  ', inputBytes: 2048, outputBytes: 1024 }),
    '2.0KB → 1.0KB',
  )
})

test('a recap reads as one line, cut at the engine own recap width', () => {
  // The row that draws it is a single annotation line; the whole summary stays in the engine's
  // history database, so the cut loses nothing that was not kept elsewhere.
  assert.equal(oneLinePreview('  where things\nstand:  the parser\tis fixed  '), 'where things stand: the parser is fixed')
  const long = 'a'.repeat(400)
  const cut = oneLinePreview(long)
  assert.equal(cut.length, 280)
  assert.ok(cut.endsWith('…'))
  // A summary that already fits is not touched.
  assert.equal(oneLinePreview('short', 280), 'short')
})
