/**
 * Inline `<svg>` markup reduced to what a drawing needs.
 *
 * The engine's form parser serializes an `<svg>` subtree whole - `html-form/parse.ts` takes
 * `node.outerHTML` and never descends into it - so the `SKIPPED` table that drops `<script>` and
 * `<style>` everywhere else does not run inside a drawing. Everything an SVG can do *beyond* drawing
 * therefore survives into the frame: `<script>`, `<style>` (a document-wide stylesheet under this
 * app's CSP, which allows inline styles), `<foreignObject>` (arbitrary HTML, including a cross-origin
 * `<iframe>`), `on*` handlers, and `href`/`url()` values that reach the network.
 *
 * This runs in the host, at the point the document is projected onto the wire: it is the boundary
 * where the agent's bytes enter, it is testable without a browser, and the window then receives a
 * string this process composed rather than one it has to re-verify.
 *
 * The rule is an **allowlist** of elements and attributes, not a denylist of dangerous spellings: a
 * denylist needs updating for every new way a browser can be made to run something, while the engine's
 * parser is free to hand over any spelling it likes.
 */

import { type Element, parseHTML } from '@oh-my-pi/pi-utils/dom'

/**
 * Elements a diagram is drawn with. Anything else - `script`, `style`, `foreignObject`, `iframe`,
 * `image` (which fetches), `use` (which can reference another document), `animate*` (which can drive
 * an attribute to `javascript:`) - is dropped with its subtree.
 */
const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  'svg',
  'g',
  'defs',
  'title',
  'desc',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'marker',
  'lineargradient',
  'radialgradient',
  'stop',
  'clippath',
  'mask',
  'pattern',
  'symbol',
])

/**
 * Attributes a drawing is drawn with: geometry, paint, typography and the few structural hints.
 *
 * `id`/`class` stay because a gradient or marker is referenced by one; `style` does not, because it
 * carries `url()` and can be driven to any value, and neither does any `on*` handler or `href`.
 */
const ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'id',
  'class',
  'viewbox',
  'width',
  'height',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'd',
  'points',
  'transform',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'opacity',
  'offset',
  'stop-color',
  'stop-opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'marker-start',
  'marker-mid',
  'marker-end',
  'gradientunits',
  'gradienttransform',
  'patternunits',
  'clippathunits',
  'maskunits',
  'preserveaspectratio',
  'role',
  'aria-label',
  'xmlns',
])

/**
 * An attribute *value* that only names paint: a colour, `none`, `currentColor`, or a reference to an
 * element in the same document. A scheme (`javascript:`, `data:`, `http(s):`) is a script or a fetch;
 * a `url(` whose target is not a local `#id` is a load.
 */
function isSafeValue(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length === 0) return true
  if (/^(?:javascript|data|vbscript|file|https?):/i.test(trimmed)) return false
  if (/url\s*\(/i.test(trimmed)) {
    return /^url\(\s*['"]?#[A-Za-z_][\w:.-]*['"]?\s*\)$/i.test(trimmed)
  }
  // CSS escapes that reach outside a value, and any markup smuggled through an attribute.
  return !/(?:expression\s*\(|@import|[<>\\])/i.test(trimmed)
}

/**
 * The drawing with every element and attribute outside the allowlists removed, or an empty string
 * when nothing drawable survives (the caller then falls back to the alt text).
 *
 * Parsed with the engine's own DOM (`@oh-my-pi/pi-utils/dom`), not a hand-written tag scanner: a
 * scanner is exactly the class of code that misses a spelling.
 */
export function sanitizeSvg(markup: string): string {
  if (!/<svg[\s>]/i.test(markup)) return ''
  const root = parseHTML(markup).document.documentElement
  if (root === null || root.localName !== 'svg') return ''
  prune(root)
  return root.outerHTML
}

function prune(element: Element): void {
  for (const child of [...element.children]) {
    if (!ALLOWED_ELEMENTS.has(child.localName)) {
      child.remove()
      continue
    }
    prune(child)
  }
  for (const attribute of [...element.attributes]) {
    const name = attribute.name
    // `on*` is absent from the allowlist, but the check is explicit so the reason survives a reader
    // adding an attribute to the set above.
    if (name.startsWith('on') || !ALLOWED_ATTRIBUTES.has(name.toLowerCase()) || !isSafeValue(attribute.value)) {
      element.removeAttribute(name)
    }
  }
}
