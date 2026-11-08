/**
 * A unified diff read into `FileDiff`'s rows, and the file it names.
 *
 * Both live beside the component whose type they produce rather than in the transcript's own
 * formatters: the rows are the diff card's shape, and the two callers — a tool row's file changes
 * and a ```diff fence in an answer — are the two places that card is drawn.
 */

import type { FileDiffLine } from './file-diff'

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/
/** File headers and git's own preamble lines carry no content of their own. */
const PREAMBLE = /^(diff |index |--- |\+\+\+ |new file |deleted file |similarity |rename )/
const GIT_PATH = /^diff --git a\/(.+?) b\/(.+)$/
const NEW_PATH = /^\+\+\+ (?:b\/)?(.+)$/

/**
 * Read a unified diff.
 *
 * Line numbers come from the hunk headers, because a diff of one hunk out of a large file starts
 * numbering wherever that hunk does; a diff written without headers — which is how a model writes
 * "these lines change" in a fence — starts at the first line rather than at zero.
 */
export function parseUnifiedDiff(diff: string): FileDiffLine[] {
  const lines: FileDiffLine[] = []
  let oldLine = 1
  let newLine = 1
  let seq = 0
  for (const raw of diff.split('\n')) {
    const hunk = HUNK.exec(raw)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      continue
    }
    if (PREAMBLE.test(raw) || raw.startsWith('\\')) continue
    if (raw.startsWith('+')) {
      lines.push({ id: `d${seq++}`, type: 'added', newLine: newLine++, content: raw.slice(1) })
      continue
    }
    if (raw.startsWith('-')) {
      lines.push({ id: `d${seq++}`, type: 'removed', oldLine: oldLine++, content: raw.slice(1) })
      continue
    }
    if (raw === '') continue
    lines.push({
      id: `d${seq++}`,
      type: 'context',
      oldLine: oldLine++,
      newLine: newLine++,
      content: raw.startsWith(' ') ? raw.slice(1) : raw,
    })
  }
  return lines
}

/**
 * The file a diff names: git's own header when it has one, else the `+++` side of a plain unified
 * diff. `null` when the diff names no file — a fence of bare `-`/`+` lines has no name to show, and
 * the card's header then states only what the fence was tagged.
 */
export function unifiedDiffFile(diff: string): string | null {
  for (const raw of diff.split('\n')) {
    const git = GIT_PATH.exec(raw)
    if (git) return git[2].trim()
    const next = NEW_PATH.exec(raw)
    if (next) {
      const path = next[1].trim()
      return path && path !== '/dev/null' ? path : null
    }
  }
  return null
}
