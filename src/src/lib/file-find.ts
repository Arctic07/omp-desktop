/**
 * Finding a string inside one file's text.
 *
 * The find bar over the preview searches the text the viewer already holds — no desktop call, no
 * second read — so the whole job is one case-insensitive scan, plus one more per line that happens
 * to be on screen for the marks. Both live here, pure, so the viewer only draws what they answer.
 *
 * Offsets are code-unit offsets into the text the caller passed, never folded or normalised: the
 * editor mode hands `setSelectionRange` those exact numbers, and the preview compares them against
 * the same string it splits into lines.
 */

/** How many matches one query collects. A single letter in a large file stops counting here. */
export const FILE_FIND_LIMIT = 500

/** How many marks one line draws. A minified file's whole content is one very long line. */
export const FILE_FIND_LINE_LIMIT = 200

export interface FileFindMatch {
  /** Offset of the match's first code unit in the file text. */
  start: number
  /** Offset just past its last code unit. */
  end: number
  /** Zero-based line the match starts on. */
  line: number
  /** Offset of the match from its line's first code unit. */
  column: number
}

export interface FileFindResult {
  matches: FileFindMatch[]
  /** The text holds more matches than the limit; what came back is the first page of them. */
  truncated: boolean
}

export interface FileFindSpan {
  start: number
  end: number
}

/**
 * Every occurrence of `query` in `text`, in reading order, case-insensitively.
 *
 * An escaped literal in a `gi` regular expression rather than a lowered copy of the text: lowering
 * a string can change its length (`İ` lowers to two code units), which would make every offset
 * after such a character point at the wrong place — and these offsets select text and decide which
 * line an arrow scrolls to.
 *
 * Matches do not overlap: `aa` in `aaaa` is two matches, at 0 and 2.
 */
export function findTextMatches(
  text: string,
  query: string,
  limit = FILE_FIND_LIMIT,
): FileFindResult {
  if (query === '') return { matches: [], truncated: false }
  const pattern = literalPattern(query)
  const matches: FileFindMatch[] = []
  // Where the answer stops being known: everything before `scanned` has been counted, and
  // `lineFirst` is the offset the line named by `line` starts at.
  let line = 0
  let lineFirst = 0
  let scanned = 0
  let found = pattern.exec(text)
  while (found !== null) {
    if (matches.length === limit) return { matches, truncated: true }
    const start = found.index
    for (let index = scanned; index < start; index += 1) {
      if (text.charCodeAt(index) === 10) {
        line += 1
        lineFirst = index + 1
      }
    }
    scanned = start
    matches.push({
      start,
      end: start + found[0].length,
      line,
      column: start - lineFirst,
    })
    found = pattern.exec(text)
  }
  return { matches, truncated: false }
}

/** The occurrences of `query` in one line, as offsets from that line's first code unit. */
export function findLineSpans(
  line: string,
  query: string,
  limit = FILE_FIND_LINE_LIMIT,
): FileFindSpan[] {
  if (query === '' || line === '') return []
  const pattern = literalPattern(query)
  const spans: FileFindSpan[] = []
  let found = pattern.exec(line)
  while (found !== null && spans.length < limit) {
    spans.push({ start: found.index, end: found.index + found[0].length })
    found = pattern.exec(line)
  }
  return spans
}

/** The zero-based line `offset` falls on. */
export function lineOfOffset(text: string, offset: number): number {
  return countNewlines(text, 0, Math.max(0, Math.min(offset, text.length)))
}

function countNewlines(text: string, from: number, to: number): number {
  let count = 0
  for (let index = from; index < to; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1
  }
  return count
}

function literalPattern(query: string): RegExp {
  // One pattern per call: `lastIndex` is this scan's own cursor.
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
}
