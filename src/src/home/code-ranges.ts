/**
 * Where code runs in a model's message, and the line facts the message's strippers share.
 *
 * Three readers needed the same answer — the reasoning envelopes (`reasoning-echo.ts`), the model's
 * own tags (`system-notice.ts`), the tool-call fragments they leave behind (`tool-call-markup.ts`)
 * — and two of them had grown their own spelling of it, drifting where it mattered: an unterminated
 * fence, which is a block still being streamed and therefore code to the end, was code to one
 * reader and prose to the other. A message that shows markup inside a fence is showing an example
 * of it, so the three agree here, once.
 */

/** A half-open range of characters. */
export type Span = readonly [start: number, end: number]

/** Whether `at` falls inside one of the ranges. */
export function inSpans(spans: readonly Span[], at: number): boolean {
  return spans.some(([start, end]) => at >= start && at < end)
}

/**
 * Where the line holding `at` ends: the index of its break, or the length of the text.
 *
 * The line is the unit a fragment that never said where it ends can be bounded by: an argument
 * value stops at the write's own line break, and so does the tag that carried it.
 */
export function lineEndAt(text: string, at: number): number {
  const end = text.indexOf('\n', at)
  return end === -1 ? text.length : end
}

/** Whether nothing but blanks of its own line comes before `at`. */
export function startsLine(text: string, at: number): boolean {
  for (let index = at - 1; index >= 0; index -= 1) {
    const char = text[index]
    if (char === '\n') return true
    if (char !== ' ' && char !== '\t') return false
  }
  return true
}

/**
 * The text with every range taken out; ranges may arrive in any order and may not overlap.
 *
 * A cut that starts before the previous one ended is dropped: the run it would cut is already gone.
 */
export function without(text: string, cuts: readonly Span[]): string {
  const ordered = [...cuts].sort((left, right) => left[0] - right[0])
  let kept = ''
  let cursor = 0
  for (const [start, end] of ordered) {
    if (end <= cursor) continue
    if (start > cursor) kept += text.slice(cursor, start)
    cursor = end
  }
  return kept + text.slice(cursor)
}

/**
 * The message as alternating prose and code segments, in text order; the odd segments are code.
 *
 * The shape the two strippers were written against: they rewrite prose and hand code back byte for
 * byte, which is what keeps an example of the markup an example.
 */
export function codeSegments(text: string): string[] {
  const segments: string[] = []
  let cursor = 0
  for (const [start, end] of codeRanges(text)) {
    if (start < cursor) continue
    segments.push(text.slice(cursor, start), text.slice(start, end))
    cursor = end
  }
  segments.push(text.slice(cursor))
  return segments
}

/** Where code runs: the fenced blocks plus the one-line spans between them, in text order. */
export function codeRanges(text: string): readonly Span[] {
  const ranges: Span[] = [...fencedRanges(text)]
  for (const match of text.matchAll(/`[^`\n]*`/g)) {
    const at = match.index ?? 0
    if (!inSpans(ranges, at)) ranges.push([at, at + match[0].length])
  }
  return ranges.sort((left, right) => left[0] - right[0])
}

/**
 * Where the fenced code blocks run.
 *
 * A fence opens on a line that starts with three backticks or tildes and closes on the next line
 * that does — an unterminated one runs to the end of the message, because a fence still being
 * streamed is a block whose tags are code too.
 */
function fencedRanges(text: string): readonly Span[] {
  const ranges: Span[] = []
  let open = -1
  let offset = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      if (open === -1) {
        open = offset
      } else {
        ranges.push([open, offset + line.length])
        open = -1
      }
    }
    offset += line.length + 1
  }
  if (open !== -1) ranges.push([open, text.length])
  return ranges
}
