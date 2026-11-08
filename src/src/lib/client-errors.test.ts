import assert from 'node:assert/strict'
import { test } from 'node:test'

import { clientErrorLine, createClientErrorReporter } from './client-errors.ts'

/**
 * The page's own failure reporting: what reaches `app.log`, and how much of it.
 *
 * What is pinned down here is the two bounds a broken page must not cross - one message written
 * once, and a finite number of distinct messages per run - plus the shape of a line, which has to
 * stay a single record. Whether the line reaches the host is `logs_write`'s own contract
 * (`src-tauri/src/services/diagnostics.rs`); the reporter is checked through a writer this test
 * supplies, because that is the seam the page and the host meet at.
 */

function collect(): { lines: string[]; write: (message: string) => void } {
  const lines: string[] = []
  return { lines, write: (message) => lines.push(message) }
}

test('a line names what failed and reads as one record', () => {
  const failure = new TypeError('cannot read properties of undefined')
  failure.stack = `TypeError: cannot read properties of undefined\n    at Row (row.tsx:12:5)\n    at App (app.tsx:3:1)`

  const line = clientErrorLine('a surface failed to render', failure, 'at Boundary')

  assert.match(line, /^a surface failed to render: TypeError: cannot read properties of undefined/)
  assert.match(line, /at Row \(row\.tsx:12:5\)/)
  assert.match(line, /detail: at Boundary$/)
  assert.equal(line.includes('\n'), false, 'one record, never two lines')
})

test('a non-Error reason is still described, and a long one is cut', () => {
  assert.match(clientErrorLine('unhandled rejection', 'plain text'), /plain text/)
  assert.match(clientErrorLine('unhandled rejection', { code: 'E_FAIL' }), /"code":"E_FAIL"/)

  const long = clientErrorLine('uncaught error', new Error('x'.repeat(5_000)))
  assert.ok(long.length <= 1_600, `a line is bounded, got ${long.length}`)
  assert.ok(long.endsWith('…'), 'a cut line says it was cut')
})

test('the same failure is written once, and different ones are written apart', () => {
  const { lines, write } = collect()
  const report = createClientErrorReporter(write)

  report('uncaught error', new Error('the same invariant'))
  // A second copy with a different stack is the same failure: the key is the description, not the
  // frames, because a failure inside a render loop repeats with one frame per attempt.
  const repeat = new Error('the same invariant')
  repeat.stack = 'Error: the same invariant\n    at somewhere else (x.ts:1:1)'
  report('uncaught error', repeat)
  report('uncaught error', new Error('a different invariant'))

  assert.equal(lines.length, 2)
  assert.match(lines[0] ?? '', /the same invariant/)
  assert.match(lines[1] ?? '', /a different invariant/)
  assert.ok(
    lines.every((line) => line.startsWith('uncaught error: ')),
    'the host adds the `page:` tag, so the message travels as written',
  )
})

test('a page that keeps failing in new ways stops at the budget, once', () => {
  const { lines, write } = collect()
  const report = createClientErrorReporter(write)

  for (let index = 0; index < 60; index += 1) {
    report('uncaught error', new Error(`failure ${index}`))
  }

  assert.equal(lines.length, 41, 'forty distinct lines and the one that closes the budget')
  assert.match(lines[40] ?? '', /later ones are dropped until restart/)
  assert.equal(
    lines.filter((line) => line.includes('later ones are dropped')).length,
    1,
    'the closing line is written once',
  )
})

test('a writer that throws does not turn one failure into two', () => {
  const report = createClientErrorReporter(() => {
    throw new Error('the log path is gone')
  })

  assert.doesNotThrow(() => report('uncaught error', new Error('first')))
})
