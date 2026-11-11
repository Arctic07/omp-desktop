import assert from 'node:assert/strict'
import { test } from 'node:test'

import { sanitizeSvg } from './ui-form-svg.ts'

/**
 * The inline `<svg>` allowlist.
 *
 * The engine's form parser serializes an `<svg>` subtree whole and never descends into it, so the
 * `script`/`style` stripping it applies everywhere else does not run inside a drawing. These are the
 * behaviours that survive into the frame without this pass, and each one is a case below.
 */

/** A diagram survives with its geometry and paint. */
test('a plain drawing is kept', () => {
  const kept = sanitizeSvg('<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#0af"/></svg>')
  assert.match(kept, /<circle[^>]*r="4"/)
  assert.match(kept, /#0af/)
})

/** Scripts, styles and foreign HTML are dropped with their subtree. */
test('script, style and foreignObject are removed', () => {
  const kept = sanitizeSvg(
    '<svg><script>alert(1)</script><style>*{display:none}</style>' +
      '<foreignObject><img src="x" onerror="alert(1)"/></foreignObject>' +
      '<circle r="4"/></svg>',
  )
  assert.doesNotMatch(kept, /<script/i)
  assert.doesNotMatch(kept, /<style/i)
  assert.doesNotMatch(kept, /foreignobject/i)
  assert.doesNotMatch(kept, /onerror/i)
  assert.match(kept, /<circle/)
})

/** Every event handler is dropped, whatever it is spelled. */
test('event handlers are removed', () => {
  const kept = sanitizeSvg('<svg onload="alert(1)"><circle r="4" onclick="alert(1)"/></svg>')
  assert.doesNotMatch(kept, /onload/i)
  assert.doesNotMatch(kept, /onclick/i)
  assert.match(kept, /<circle/)
})

/** A `url()` that points anywhere but this document is a load, and is dropped. */
test('remote references are removed', () => {
  const kept = sanitizeSvg(
    '<svg><rect fill="url(https://evil.test/x.svg#a)"/><rect fill="url(#local)"/></svg>',
  )
  assert.doesNotMatch(kept, /evil\.test/)
  assert.match(kept, /url\(#local\)/)
})

/** A scheme in a paint value is a script or a fetch, never a colour. */
test('a scheme in a value is removed', () => {
  const kept = sanitizeSvg('<svg><rect fill="javascript:alert(1)"/><rect fill="red"/></svg>')
  assert.doesNotMatch(kept, /javascript:/i)
  assert.match(kept, /red/)
})

/** Elements that fetch or reference another document are dropped. */
test('fetching and referencing elements are removed', () => {
  const kept = sanitizeSvg(
    '<svg><image href="https://evil.test/a.png"/><use href="https://evil.test/b.svg#x"/>' +
      '<animate attributeName="fill" to="javascript:alert(1)"/><rect r="4"/></svg>',
  )
  assert.doesNotMatch(kept, /evil\.test/)
  assert.doesNotMatch(kept, /animate/i)
  assert.match(kept, /<rect/)
})

/** Markup that is not a drawing at all yields nothing, so the card can fall back to alt text. */
test('non-svg input yields nothing', () => {
  assert.equal(sanitizeSvg('<div>not a drawing</div>'), '')
  assert.equal(sanitizeSvg(''), '')
})
