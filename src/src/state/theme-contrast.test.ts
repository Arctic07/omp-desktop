import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CONTRAST_MIN_RATIO, contrastIssues, contrastRatio, parseColor } from './theme-contrast.ts'

/**
 * What the contrast report says, and what it refuses to guess.
 *
 * The report exists because the host validates only the *shape* of a token value: a theme may set
 * `#111` text on a `#0b0b0b` surface and nothing in the manifest check will notice. What is pinned
 * here is the arithmetic (WCAG ratios, the colour syntaxes this build can read, including the
 * `oklch()` its own palette is written in) and the refusal to judge a pair it cannot parse.
 */

const near = (left: number, right: number, tolerance = 0.02): boolean =>
  Math.abs(left - right) <= tolerance

test('the parser reads the syntaxes a token value may use', () => {
  assert.deepEqual(parseColor('#000'), { r: 0, g: 0, b: 0 })
  assert.deepEqual(parseColor('white'), { r: 1, g: 1, b: 1 })
  const short = parseColor('#fff')
  assert.ok(short !== null && near(short.r, 1) && near(short.g, 1) && near(short.b, 1))
  const rgb = parseColor('rgb(255 0 0 / 50%)')
  assert.ok(rgb !== null && near(rgb.r, 1) && near(rgb.g, 0) && near(rgb.b, 0), 'alpha is ignored')
  const hsl = parseColor('hsl(0, 100%, 50%)')
  assert.ok(hsl !== null && near(hsl.r, 1) && near(hsl.g, 0) && near(hsl.b, 0))

  // Oklch is how this application's own palette is written; a theme copying a value from it must be
  // read, not skipped.
  const oklchWhite = parseColor('oklch(1 0 0)')
  assert.ok(oklchWhite !== null && near(oklchWhite.r, 1) && near(oklchWhite.g, 1))
  const red = parseColor('oklch(0.627955 0.257683 29.2339)')
  assert.ok(red !== null && near(red.r, 1, 0.01) && near(red.g, 0, 0.01) && near(red.b, 0, 0.01))

  for (const unknown of ['var(--ink)', 'color-mix(in oklch, red, blue)', 'rgb(1,2)', '#12', '12px']) {
    assert.equal(parseColor(unknown), null, unknown)
  }
})

test('the ratio is the WCAG one', () => {
  const black = parseColor('#000')
  const white = parseColor('#fff')
  assert.ok(black !== null && white !== null)
  assert.ok(near(contrastRatio(black, white), 21, 0.01))
  assert.ok(near(contrastRatio(white, white), 1, 0.001), 'a colour against itself is 1')
})

test('a pair under the threshold is named, and a readable one is not', () => {
  const readable = contrastIssues({ '--background': '#0b1210', '--foreground': '#dcefe4' })
  assert.deepEqual(readable, [])

  const unreadable = contrastIssues({ '--background': '#101010', '--foreground': '#1a1a1a' })
  assert.equal(unreadable.length, 1)
  assert.equal(unreadable[0].pair, 'content')
  assert.ok(unreadable[0].ratio < CONTRAST_MIN_RATIO)

  // The sidebar is a separate pair: a theme may be readable in the content column and not in the rail.
  const rail = contrastIssues({ '--sidebar': '#0a1612', '--sidebar-foreground': '#123023' })
  assert.deepEqual(rail.map((issue) => issue.pair), ['sidebar'])
})

test('only a pair with both halves declared is judged', () => {
  // A theme that repaints the surface and leaves the ink to this application makes no claim here.
  assert.deepEqual(contrastIssues({ '--background': '#000' }), [])
  assert.deepEqual(contrastIssues({ '--foreground': '#000' }), [])
  // A pair this build cannot parse is skipped rather than guessed at.
  assert.deepEqual(contrastIssues({ '--background': 'var(--pane)', '--foreground': '#111' }), [])
  // A theme that repaints nothing is not a theme with a problem.
  assert.deepEqual(contrastIssues({}), [])
})
