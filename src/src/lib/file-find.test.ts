import assert from 'node:assert/strict'
import { test } from 'node:test'

import { findLineSpans, findTextMatches, lineOfOffset } from './file-find.ts'

test('matches are found in order with the line and column they start at', () => {
  const text = 'alpha\nbeta alpha\nALPHA'
  const { matches, truncated } = findTextMatches(text, 'alpha')
  assert.equal(truncated, false)
  assert.deepEqual(
    matches.map((match) => [match.line, match.column, match.start, match.end]),
    [
      [0, 0, 0, 5],
      [1, 5, 11, 16],
      [2, 0, 17, 22],
    ],
  )
})

test('matches do not overlap', () => {
  const { matches } = findTextMatches('aaaa', 'aa')
  assert.deepEqual(
    matches.map((match) => match.start),
    [0, 2],
  )
})

test('an empty query matches nothing', () => {
  assert.deepEqual(findTextMatches('anything', ''), { matches: [], truncated: false })
  assert.deepEqual(findLineSpans('anything', ''), [])
})

test('regex metacharacters in the query are literal text', () => {
  const { matches } = findTextMatches('a.b axb a.b', 'a.b')
  assert.deepEqual(
    matches.map((match) => match.start),
    [0, 8],
  )
  assert.deepEqual(findLineSpans('f(x) = f[x]', 'f('), [{ start: 0, end: 2 }])
})

test('a query past the limit reports that more matches exist', () => {
  const text = 'x '.repeat(10)
  const page = findTextMatches(text, 'x', 3)
  assert.equal(page.matches.length, 3)
  assert.equal(page.truncated, true)
  const all = findTextMatches(text, 'x', 10)
  assert.equal(all.matches.length, 10)
  assert.equal(all.truncated, false)
})

/** The offsets are `setSelectionRange` arguments, so a line's start has to be counted exactly. */
test('line and column follow the text, not a lowered copy of it', () => {
  const text = 'İstanbul\nÖffnen'
  const { matches } = findTextMatches(text, 'öffnen')
  assert.equal(matches.length, 1)
  assert.equal(matches[0].line, 1)
  assert.equal(matches[0].column, 0)
  assert.equal(matches[0].start, text.indexOf('Öffnen'))
})

test('a line reports every span the query covers in it', () => {
  assert.deepEqual(findLineSpans('one two one', 'one'), [
    { start: 0, end: 3 },
    { start: 8, end: 11 },
  ])
})

test('an offset answers with the line it falls on', () => {
  const text = 'first\nsecond\nthird'
  assert.equal(lineOfOffset(text, 0), 0)
  assert.equal(lineOfOffset(text, 5), 0)
  assert.equal(lineOfOffset(text, 6), 1)
  assert.equal(lineOfOffset(text, text.length), 2)
})
