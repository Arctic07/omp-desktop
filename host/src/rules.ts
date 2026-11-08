/**
 * `rules_read` / `rules_write`: the engine's user-scope sticky rules file, `<agentDir>/RULES.md`.
 *
 * That file is the engine's own: `@oh-my-pi/pi-coding-agent`'s discovery reads
 * `<agentDir>/RULES.md` as a top-level sticky rule (`src/discovery/builtin.ts:404-440`, "User
 * scope: <agentDir>/RULES.md"), forces `alwaysApply` on it and carries its whole body on every
 * request. The project-scope counterparts (a workspace's `.omp/RULES.md` and `AGENTS.md`) are
 * deliberately not addressed here: a page that wrote one workspace's rules while presenting itself
 * as the global ones would write for the wrong scope, and a workspace's own files stay the way a
 * project is supposed to carry them.
 *
 * The write lands in this module because the engine exposes no API for it: discovery only ever
 * *reads* that path, and `src/capability/fs.ts` exports readers plus cache control, never a writer.
 * What is written is the user's bytes verbatim, so the engine's rules format is not re-implemented
 * here. The engine re-discovers rules from disk on every session-scoped rebuild
 * (`src/sdk.ts:3688-3712`, which also clears its fs cache at those boundaries), so dropping the
 * capability cache after a write is what makes the new body reach the next turn instead of the next
 * restart.
 *
 * An absent *or empty* file is no rule at all - the engine's own `loadStickyRulesFile` answers
 * `null` for both - which is why an empty body is a legal write rather than a hidden delete, and
 * why "the file is not there" is a state the page renders instead of a failure.
 *
 * Both frames answer one view (`{path, exists, content, bytes, updatedAtMs}`), and the write
 * answers with the state *on disk after the rename* rather than an echo of its request: what the
 * page shows next is the file the engine will actually read.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { RULES_CONTENT_MAX_BYTES } from './constants.ts'
import type { HostPaths } from './env.ts'
import { ERROR_CODES, HostError, invalidInput } from './protocol/errors.ts'
import type { SdkBundle } from './sdk.ts'

/** The rules file's name, in the spelling the engine's user-scope discovery looks for. */
const RULES_FILE_NAME = 'RULES.md'

/**
 * The refusal for a body over the ceiling, naming what a truncation would hide.
 *
 * It carries the path, the measured size and the ceiling so the page can state all three without
 * measuring anything itself - and it sends the user to an external editor, because refusing to edit
 * a file through this page is not refusing to let the file exist.
 */
function rulesTooLarge(target: string, bytes: number): HostError {
  return new HostError(
    ERROR_CODES.rules_too_large,
    `RULES.md at ${target} holds ${String(bytes)} bytes, over the ${String(RULES_CONTENT_MAX_BYTES)}-byte limit this page edits. Shorten it in an external editor; this host will not truncate it.`,
  )
}

/**
 * The file as it is on disk right now, or the refusal that says it is too large to carry.
 *
 * `bytes` is the UTF-8 size of the content that was read, not the string's length: a rule set's
 * cost is the bytes the engine carries into a request, and the ceiling is a byte ceiling for the
 * same reason.
 *
 * The size is checked on the directory entry before the read, so an oversize file is refused
 * without being loaded into this process, and measured again on what was read, so a file that grew
 * between the two is still refused rather than answered short. There is no truncating path: a body
 * cut at an arbitrary byte reads like a rule set that says less than the user wrote, and the page
 * would save that shortened version back over the real one.
 */
function rulesView(target: string): Record<string, unknown> {
  let stats: fs.Stats | null = null
  try {
    stats = fs.statSync(target)
  } catch (error) {
    // `ENOENT` is the normal first-run state. Any other reason - permissions, a path that cannot be
    // walked - is a real failure and travels as one, so the page never reports a file it could not
    // look at as "you have no rules" and offers to create over something that is already there.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (stats === null || !stats.isFile()) {
    // A directory or a device sitting at that name is not a rules file either; the write below is
    // refused by the platform when it tries to replace one, which is where that answer belongs.
    return { path: target, exists: false, content: '', bytes: 0, updatedAtMs: null }
  }
  if (stats.size > RULES_CONTENT_MAX_BYTES) throw rulesTooLarge(target, stats.size)
  const content = fs.readFileSync(target, 'utf8')
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > RULES_CONTENT_MAX_BYTES) throw rulesTooLarge(target, bytes)
  return {
    path: target,
    exists: true,
    content,
    bytes,
    // A platform that reports no modification time is answered as `null`, not as an epoch date the
    // page would render as the file having been saved in 1970.
    updatedAtMs: Number.isFinite(stats.mtimeMs) ? Math.round(stats.mtimeMs) : null,
  }
}

/**
 * Replace the file whole, through a sibling temporary file and one rename.
 *
 * The engine reads this file on every request and a rule set is only worth anything while it is
 * whole, so a reader that arrives mid-write must see the old body or the new one and never a
 * half-written one. The temporary file is created in the same directory because a rename is atomic
 * only within one volume - on Windows because Node's `rename` is the platform's replace-existing
 * move. That same rename creates the file when it was not there yet, so a first write and a
 * replacement are one operation rather than two paths to keep in step.
 */
function replaceFile(target: string, content: string): void {
  const staging = `${target}.writing-${String(process.pid)}`
  try {
    fs.writeFileSync(staging, content, { encoding: 'utf8' })
    fs.renameSync(staging, target)
  } catch (error) {
    // The staging file is this function's own litter: a failed write must not leave a second
    // near-copy of the user's rules beside the real one, where the engine's rule discovery could
    // pick it up and the page would show a file the user did not write.
    try {
      fs.rmSync(staging, { force: true })
    } catch {
      // Best effort by construction: the original failure is the answer the caller needs, and a
      // second failure while cleaning up would only replace it with a less useful one.
    }
    throw error
  }
}

/**
 * `rules_read`: the user-scope rules file, in full.
 *
 * The engine bundle and the frame are part of the shape this pair shares with every other
 * capability command, and a read consults neither - it answers with the bytes on disk (which is
 * what the engine will read) and has no cache of its own to drop.
 */
export async function readRules(
  paths: HostPaths,
  sdk: SdkBundle,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return rulesView(path.join(paths.agentDir, RULES_FILE_NAME))
}

/**
 * `rules_write`: replace the user-scope rules file whole, then answer with what landed.
 *
 * The body is refused before anything is written when it is not a string or over the ceiling, so a
 * rejection leaves the file the engine reads untouched. After the rename the capability cache is
 * dropped, because that cache is what the engine's own discovery reads this file through: without
 * it, the write would be on disk but the running engine would keep serving the body it cached when
 * the session's scope was last built.
 */
export async function writeRules(
  paths: HostPaths,
  sdk: SdkBundle,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const target = path.join(paths.agentDir, RULES_FILE_NAME)
  const content = frame.content
  if (typeof content !== 'string') throw invalidInput('content must be a string.')
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > RULES_CONTENT_MAX_BYTES) throw rulesTooLarge(target, bytes)
  replaceFile(target, content)
  sdk.resetCapabilities()
  return rulesView(target)
}
