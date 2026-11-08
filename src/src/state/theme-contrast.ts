/**
 * The contrast a theme's own tokens leave behind.
 *
 * A theme may repaint the whole published palette (spec §3.2), and the host validates each value's
 * *shape* only - it cannot know that a reader will not be able to read `#222` on `#111`. This module
 * answers the one question a shape check cannot: for every surface/ink pair the application actually
 * paints, is the text still legible? It is a **report**, not a gate: the theme still applies (the
 * author's palette is the author's), and the appearance page shows the pairs that fall under the
 * threshold so a reader sees why a wall of low-contrast text is not a rendering bug.
 *
 * Only values this module can parse are judged. A pair whose two tokens are unparsable (a `var()`
 * alias, a `color-mix()` result, a font stack in a colour slot) is skipped rather than guessed at -
 * half a comparison is a worse answer than none.
 */

/** WCAG AA for body text: the ratio below which this module complains. */
export const CONTRAST_MIN_RATIO = 4.5

/** One pair the application paints, as `[surface, ink, what it is]`. */
const PAIRS: readonly (readonly [string, string, string])[] = [
  ['--background', '--foreground', 'content'],
  ['--card', '--card-foreground', 'card'],
  ['--popover', '--popover-foreground', 'popover'],
  ['--primary', '--primary-foreground', 'primary'],
  ['--secondary', '--secondary-foreground', 'secondary'],
  ['--muted', '--muted-foreground', 'muted'],
  ['--accent', '--accent-foreground', 'accent'],
  ['--sidebar', '--sidebar-foreground', 'sidebar'],
  ['--sidebar-accent', '--sidebar-accent-foreground', 'sidebar accent'],
  ['--sidebar-primary', '--sidebar-primary-foreground', 'sidebar primary'],
  ['--omp-pane', '--foreground', 'pane'],
  ['--omp-field', '--foreground', 'composer field'],
  ['--omp-window-frame', '--omp-titlebar-ink', 'window frame'],
  ['--omp-bubble-user', '--omp-bubble-user-ink', 'message bubble'],
]

/** One pair a theme leaves under the threshold. */
export interface ContrastIssue {
  /** Which surface, in the language-free wording this module owns (`copy.ts` names it). */
  pair: string
  /** The measured ratio, rounded to one decimal. */
  ratio: number
}

/**
 * Every painted pair whose contrast, from the theme's own tokens, is under {@link CONTRAST_MIN_RATIO}.
 *
 * Only a pair with **both** tokens declared is judged: a theme that repaints `--background` and
 * leaves the ink to this application is not making a claim about legibility, and the shipped ink is
 * the one the shipped surface was designed for.
 */
export function contrastIssues(tokens: Readonly<Record<string, string>>): ContrastIssue[] {
  const issues: ContrastIssue[] = []
  for (const [surface, ink, pair] of PAIRS) {
    const surfaceColor = parseColor(tokens[surface])
    const inkColor = parseColor(tokens[ink])
    if (surfaceColor === null || inkColor === null) continue
    const ratio = contrastRatio(surfaceColor, inkColor)
    if (ratio < CONTRAST_MIN_RATIO) {
      issues.push({ pair, ratio: Math.round(ratio * 10) / 10 })
    }
  }
  return issues
}

interface Rgb {
  r: number
  g: number
  b: number
}

/** One token value as sRGB (0–1 per channel), or null when this module cannot read it. */
export function parseColor(value: string | undefined): Rgb | null {
  if (value === undefined) return null
  const text = value.trim().toLowerCase()
  if (text === '') return null
  if (text === 'black') return { r: 0, g: 0, b: 0 }
  if (text === 'white') return { r: 1, g: 1, b: 1 }
  if (text.startsWith('#')) return parseHex(text)
  const call = /^([a-z]+)\((.*)\)$/.exec(text)
  if (call === null) return null
  const [, head, body] = call
  if (head === 'rgb' || head === 'rgba') return parseRgb(body ?? '')
  if (head === 'hsl' || head === 'hsla') return parseHsl(body ?? '')
  if (head === 'oklch') return parseOklch(body ?? '')
  return null
}

function parseHex(text: string): Rgb | null {
  const hex = text.slice(1)
  const expand = (part: string): number => parseInt(part.length === 1 ? part + part : part, 16) / 255
  if (hex.length === 3 || hex.length === 4) {
    return { r: expand(hex[0] ?? ''), g: expand(hex[1] ?? ''), b: expand(hex[2] ?? '') }
  }
  if (hex.length === 6 || hex.length === 8) {
    return {
      r: expand(hex.slice(0, 2)),
      g: expand(hex.slice(2, 4)),
      b: expand(hex.slice(4, 6)),
    }
  }
  return null
}

/** One numeric channel: `128`, `50%`, `0.5`. Null when it is neither. */
function channel(part: string, scale: number): number | null {
  const text = part.trim()
  if (text.endsWith('%')) {
    const value = Number.parseFloat(text.slice(0, -1))
    return Number.isFinite(value) ? (value / 100) * scale : null
  }
  const value = Number.parseFloat(text)
  return Number.isFinite(value) ? value : null
}

function parseRgb(body: string): Rgb | null {
  const parts = body.replaceAll('/', ' ').split(/[\s,]+/).filter((part) => part !== '')
  if (parts.length < 3) return null
  const values = parts.slice(0, 3).map((part) => channel(part, 255))
  if (values.some((value) => value === null)) return null
  const [r, g, b] = values as number[]
  return { r: (r ?? 0) / 255, g: (g ?? 0) / 255, b: (b ?? 0) / 255 }
}

function parseHsl(body: string): Rgb | null {
  const parts = body.replaceAll('/', ' ').split(/[\s,]+/).filter((part) => part !== '')
  if (parts.length < 3) return null
  const hue = Number.parseFloat((parts[0] ?? '').replace('deg', ''))
  const saturation = channel(parts[1] ?? '', 1)
  const lightness = channel(parts[2] ?? '', 1)
  if (!Number.isFinite(hue) || saturation === null || lightness === null) return null
  return hslToRgb(hue, saturation, lightness)
}

/** `oklch(L C H)` (L 0–1 or %, C 0–0.4, H degrees), through Oklab to linear sRGB. */
function parseOklch(body: string): Rgb | null {
  const parts = body.replaceAll('/', ' ').split(/[\s,]+/).filter((part) => part !== '')
  if (parts.length < 3) return null
  const lightness = channel(parts[0] ?? '', 1)
  const chroma = Number.parseFloat(parts[1] ?? '')
  const hue = Number.parseFloat((parts[2] ?? '').replace('deg', ''))
  if (lightness === null || !Number.isFinite(chroma) || !Number.isFinite(hue)) return null
  const radians = (hue * Math.PI) / 180
  const a = chroma * Math.cos(radians)
  const b = chroma * Math.sin(radians)
  return linearToSrgb(oklabToLinear(lightness, a, b))
}

function hslToRgb(hue: number, saturation: number, lightness: number): Rgb {
  const h = ((hue % 360) + 360) % 360
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = lightness - c / 2
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x]
  return { r: r + m, g: g + m, b: b + m }
}

/** Oklab (Ottosson) to linear sRGB, before gamma. */
function oklabToLinear(l: number, a: number, b: number): Rgb {
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b
  const s_ = l - 0.0894841775 * a - 1.291485548 * b
  const l3 = l_ * l_ * l_
  const m3 = m_ * m_ * m_
  const s3 = s_ * s_ * s_
  return {
    r: 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    g: -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    b: -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  }
}

function linearToSrgb(linear: Rgb): Rgb {
  const encode = (value: number): number => {
    const clamped = Math.min(1, Math.max(0, value))
    return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055
  }
  return { r: encode(linear.r), g: encode(linear.g), b: encode(linear.b) }
}

/** WCAG 2.x relative luminance of one sRGB colour. */
function luminance(color: Rgb): number {
  const linear = (value: number): number =>
    value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
}

/** WCAG 2.x contrast ratio: 1 (same colour) to 21 (black on white). */
export function contrastRatio(left: Rgb, right: Rgb): number {
  const first = luminance(left)
  const second = luminance(right)
  const lighter = Math.max(first, second)
  const darker = Math.min(first, second)
  return (lighter + 0.05) / (darker + 0.05)
}
