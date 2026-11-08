/**
 * The write half of a native user skill: the one place this process writes
 * `<agentDir>/skills/<name>/SKILL.md`.
 *
 * A built-in recipe follows the build that shipped it, and never takes a reader's edit with it.
 * Every file written here ends with a marker naming the `sha256` of the body it was seeded from, and
 * a start decides by comparing what is on disk:
 *
 * - **No file** - a fresh data root: write the body and its marker.
 * - **Marked, and the file still matches its own marker** - nobody has touched this copy: write the
 *   new body (and its marker) when it differs from what is there. This is what makes a capability
 *   change reach a machine that already ran the previous build, instead of waiting for the reader to
 *   delete the file.
 * - **Marked, and the file no longer matches its marker** - the reader edited the recipe, which this
 *   contract invites: leave every byte of it alone. Deleting the file stays the reset.
 * - **No marker** - a copy from a build that predates marking, or a skill the reader wrote under this
 *   name themselves. Nothing in the file tells those apart, so the built-in wins - that is the
 *   directive - and the bytes that were there are kept beside it as `<name>.SKILL.md.superseded`,
 *   with a line in the log naming the path. Nothing is lost either way.
 *
 * The file lands through a temporary name and a rename, so a reader that reads it while the host
 * starts sees either nothing or the whole body - never half of one.
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { logLine } from './log.ts'

/** One skill to write: the directory name (which is also the frontmatter `name`) and its body. */
export interface NativeSkill {
  readonly name: string
  readonly body: string
}

/** The marker every seeded file ends with. One line, and it is not part of the recipe. */
const MARKER = 'omp-desktop-seed'

/** One recipe as this build writes it: the body, then the marker naming the digest of those bytes. */
function seeded(body: string): string {
  const text = body.endsWith('\n') ? body : `${body}\n`
  const stamp = createHash('sha256').update(text, 'utf8').digest('hex')
  return `${text}<!-- ${MARKER}:${stamp} -->\n`
}

/** What a marked file holds: the recipe without its marker, and the digest the marker names. */
function splitMarker(text: string): { body: string; marker: string } | null {
  const opened = `<!-- ${MARKER}:`
  const at = text.lastIndexOf(opened)
  if (at < 0) return null
  const closed = text.indexOf(' -->', at)
  if (closed < 0 || text.slice(closed + ' -->'.length).trim() !== '') return null
  const marker = text.slice(at + opened.length, closed)
  if (!/^[0-9a-f]{64}$/.test(marker)) return null
  return { body: text.slice(0, at), marker }
}

/** One write: a temporary name and a rename, so a reader never sees half a body. */
function writeFresh(file: string, text: string): void {
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, text, 'utf8')
  fs.renameSync(temporary, file)
}

/**
 * Writes one recipe at `<agentDir>/skills/<name>/SKILL.md` by the rule in this module's header: the
 * built-in tracks the build, and a copy the reader edited is left alone.
 */
export function seedNativeSkill(agentDir: string, skill: NativeSkill): void {
  const directory = path.join(agentDir, 'skills', skill.name)
  const file = path.join(directory, 'SKILL.md')
  try {
    const next = seeded(skill.body)
    fs.mkdirSync(directory, { recursive: true })
    if (!fs.existsSync(file)) {
      writeFresh(file, next)
      return
    }
    const current = fs.readFileSync(file, 'utf8')
    if (current === next) return
    const marked = splitMarker(current)
    if (marked === null) {
      const kept = `${file}.superseded`
      fs.renameSync(file, kept)
      writeFresh(file, next)
      logLine(
        `the ${skill.name} skill was replaced with this build's; the copy that was there is kept at ${kept}`,
      )
      return
    }
    const untouched =
      createHash('sha256').update(marked.body, 'utf8').digest('hex') === marked.marker
    if (!untouched) {
      logLine(`the ${skill.name} skill was edited by hand; this build left it alone`)
      return
    }
    writeFresh(file, next)
    logLine(`the ${skill.name} skill was updated to this build's`)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logLine(`the ${skill.name} skill could not be written: ${reason}`)
  }
}
