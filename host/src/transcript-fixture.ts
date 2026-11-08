/**
 * Transcript fixtures for the host's own tests: a session file on disk, and the lines one is made of.
 *
 * The engine's transcript is NDJSON — a fixed title slot, a session header, then entries — and the
 * tests that write one are reading two different questions off the same file, so the shape lives
 * here once instead of being retyped per spec (`rules.md#a-spec-that-passes-only-when-run-alone`).
 *
 * Test-only: nothing in `host/src` imports it outside a `*.test.ts`.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** A file holding `lines`, one per line, and the directory a test removes afterwards. */
export function transcriptFixture(
  tag: string,
  lines: readonly string[],
): { file: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `omp-transcript-${tag}-`))
  const file = path.join(root, 'session.jsonl')
  fs.writeFileSync(file, lines.map((line) => `${line}\n`).join(''))
  return { file, root }
}

/** The engine's fixed title slot, the session header behind it, and one message entry. */
export const TITLE_SLOT = JSON.stringify({ type: 'title', title: '' })
export const HEADER = JSON.stringify({ type: 'session', id: 'session-1', cwd: 'D:/project' })
export const MESSAGE = JSON.stringify({
  type: 'message',
  id: 'e1',
  message: { role: 'user', content: 'hi' },
})
