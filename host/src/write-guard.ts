/**
 * The cross-conversation write guard.
 *
 * One host process serves every conversation, and every conversation shares the workspace on
 * disk. The engine already refuses a stale `edit` (its hashline tag is a content hash compared
 * against the live file), but `write` has no such check: it replaces the file with whatever the
 * model sent, even when another conversation changed that file after this one last read it. Two
 * conversations working the same repository therefore lose one of the two edits silently.
 *
 * This module closes that gap without a second model, without a prompt, and without a frame on
 * the wire. It registers one inline extension per conversation (`createAgentSession`'s
 * `extensions` option) whose `tool_call` handler runs at argument-preparation time - before
 * concurrency scheduling, before `tool_execution_start`, and before the approval gate
 * (`session/agent-session.ts` `#beforeToolCall`) - and refuses a whole-file write in three
 * situations:
 *
 * 1. the file's bytes are not the ones this session last saw **whole** - whichever writer changed
 *    them: another conversation, a shell command, an editor, a subagent, a checkout. The comparison
 *    is a content fingerprint (`sha256`, or size + mtime above `HASH_MAX_BYTES`), so a file edited
 *    outside the tools is no longer a blind spot, and a same-content rewrite is not a false lock;
 * 2. another conversation's write is between its call and its result right now (the bytes have not
 *    moved yet, so without this two overlapping writes would both pass);
 * 3. the file exists and this session has never read it at all (`unread`), or has only read a
 *    window of it since it last saw the whole file (`unseen`) - overwriting every line from memory
 *    would drop the lines it never saw. Creating a file (nothing on disk) is always fine, and a
 *    targeted `edit`/`apply_patch` is exempt from the byte check: the engine checks those against
 *    the file's own content.
 *
 * The model sees a normal tool error naming the file and what clears it (a whole-file read, then
 * re-apply), then re-applies its change; both edits survive and the user does nothing.
 *
 * What it cannot cover: a change landing between the check and the write itself (a local write is
 * still two syscalls, and the guard does not hold a filesystem lock), a file above
 * `HASH_MAX_BYTES` whose size and mtime both stay the same, two hard links to one file (two keys),
 * and a read done through another tool (`bash cat`, `eval`): only the engine's `read` establishes a
 * view, so a session that read a file that way is treated as never having read it. Those are
 * deliberate best-effort limits - this is defence against silent overwrites, not a lock file.
 *
 * It is exercised at both levels: `host/src/write-guard.test.ts` decides the table's rules against
 * fake and real files (a change made outside the tools, an existing file never read, a same-content
 * rewrite, a dead in-flight call released at turn end), and the opt-in `write-guard` smoke scenario
 * runs two real engine sessions against one file through a mock provider
 * (`scripts/mock-provider.ts`), including an out-of-band writer and a blocked whole-file write that
 * must leave the other conversation's bytes on disk.
 *
 * A read names a window in the same string (`src/app.ts:10-20`, `:raw`, `:img`, `:1h5m42s`); the
 * guard keys the **file** (`readTarget`), never the selector. Without that, re-reading any part of a
 * file left the conversation stale and the block's own advice - "read the file again" - could not
 * clear it (2026-10-23). The key is the file's canonical path, so a workspace reached through a
 * junction or a symlink is the same file as its target.
 *
 * State is per host process, bounded, and owned by this module (rule §8.1):
 *
 * | container | bound | released |
 * | --- | --- | --- |
 * | `#versions` (path -> last write) | `MAX_TRACKED_PATHS`, oldest first | insertion-order eviction; entries are small and a session's teardown does not delete them (they are what keeps other sessions' views stale) |
 * | `#known` (session -> path -> last seen version + whole view fingerprint) | `MAX_KNOWN_PATHS` per session | the session's own teardown (`forget`) |
 * | `#pending` (call -> paths until its result) | `MAX_PENDING_CALLS` | the call's `tool_result`, or insertion-order eviction |
 * | `#inflight` (path -> the conversation writing it) | at most one key per pending call's paths | the call's `tool_result`/failure (`takePending`), its `turn_end` (`guardTurnEnd`), an evicted pending call, or the session's teardown (`forget`) |
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type {
  ExtensionFactory,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'

import { logLine } from './log.ts'

/** How many paths the process-level version table keeps before it drops the oldest. */
const MAX_TRACKED_PATHS = 4_096

/** How many paths one conversation remembers having read. */
const MAX_KNOWN_PATHS = 512

/** How many started calls may wait for their result at once (one turn runs a handful). */
const MAX_PENDING_CALLS = 512

/**
 * How long one in-flight write may block another conversation before it is treated as gone.
 *
 * The engine emits a result for every tool call, including a failed or aborted one, and the mark is
 * released there. This is the safety valve for a call that somehow never reports back: a file write
 * is local and finishes in well under a second, so a mark older than a minute is a dead call rather
 * than a write still landing.
 */
const INFLIGHT_MAX_MS = 60_000

/** Files up to this size are fingerprinted by their bytes; larger ones by size and mtime. */
const HASH_MAX_BYTES = 4 * 1024 * 1024

/**
 * A file's observed state: its content hash (small files) or size + mtime (large ones).
 *
 * `null` means the directory exists and the file does not; `undefined` means this process could not
 * observe the path at all (a test fixture, an internal resource), which is what keeps the rules
 * below from acting on a state nobody measured.
 */
type Fingerprint = string | null | undefined

/**
 * The state of one file right now, independent of who changed it.
 *
 * This is the half of the guard that sees **out-of-band writers**: a bash command, a subagent, the
 * desktop's own editor, a git checkout. Those never tell this table they wrote, so a version count
 * cannot notice them; comparing the bytes the conversation read against the bytes on disk can. A
 * large file falls back to size + mtime (a whole-file hash of a huge log on every read would cost
 * more than the guard is worth); every file a coding agent overwrites whole is far below the limit.
 */
function fingerprintOf(key: string): Fingerprint {
  try {
    const stats = fs.statSync(key)
    if (!stats.isFile()) return undefined
    if (stats.size <= HASH_MAX_BYTES) {
      return `h:${createHash('sha256').update(fs.readFileSync(key)).digest('hex')}`
    }
    return `s:${String(stats.size)}:${String(stats.mtimeMs)}`
  } catch {
    try {
      // The directory tells "a file that is not there yet" (the common case: creating one) from a
      // path this process cannot observe at all.
      return fs.statSync(path.dirname(key)).isDirectory() ? null : undefined
    } catch {
      return undefined
    }
  }
}

/** Tools whose effect on a file this guard tracks. `read` feeds the "what did we see" side. */
const WRITE_TOOLS: Record<string, true> = { write: true, edit: true, apply_patch: true }

/** The four-hex tag the engine copies around a path in hashline output (`[src/a.ts#1A2B]`). */
const SNAPSHOT_WRAPPER = /^\[(.+?)#[0-9a-fA-F]{4}\]$/

/** `apply_patch` sections name their targets on their own header lines. */
const APPLY_PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm
const APPLY_PATCH_MOVE = /^\*\*\* Move to: (.+)$/gm

/**
 * The read tool's selector suffix on a `path`.
 *
 * A read names both the file and the window it wants in one string: `src/app.ts:10-20`,
 * `src/app.ts:raw`, `src/app.ts:img`, `src/app.ts:-60`, `src/app.ts:1h5m42s`,
 * `src/app.ts:5-16,960-973`, `src/app.ts:raw:2-4`. Every one of them is a *suffix* after the last
 * colon that separates it from a real path (a Windows drive colon is followed by a separator, which
 * no selector starts with).
 */
const READ_SELECTOR = /^(.+):(raw(?::[^:]*)?|img|conflicts|-?\d[\d.,:+\-a-z]*)$/

/** One read's path, and whether the read showed the whole file. */
interface ReadTarget {
  readonly path: string
  readonly whole: boolean
}

/**
 * A read's path without its range selector, and whether that read was a whole-file view.
 *
 * This guard keys files by path, and a ranged read used to register the selector as part of the key
 * (`src/app.ts:10-20`) - a name no write ever uses. A conversation that re-read a file with any
 * window therefore never cleared its staleness, and its next edit was refused with "read the file
 * again": advice that could not work while every read carried a range (2026-10-23, a dead end the
 * user hit on this very file). The read itself already happened; this only records *which file* it
 * was against, and how much of it was shown.
 *
 * "Whole" is what a **whole-file write** needs: a range read proves the file's version, not its
 * unseen lines, and overwriting those from memory is how another conversation's change disappears.
 * `:raw` (and no selector) shows the whole file; every window, `:img` and `:conflicts` does not.
 */
function readTarget(raw: string): ReadTarget {
  let value = raw.trim()
  let whole = true
  // At most a few suffixes (`:raw:2-4`, `:01:23`); a longer run is a name, not a selector.
  for (let step = 0; step < 3; step += 1) {
    const match = READ_SELECTOR.exec(value)
    if (match === null || match[1].length === 0) break
    // `raw` alone shows the whole file; a range or tail shows a window, in either order
    // (`:raw:2-4` and `:2-4:raw` are both partial).
    if (match[2] !== 'raw') whole = false
    value = match[1]
  }
  return { path: value, whole }
}

/** One path as this guard spells it: the canonical key it compares, and the text a model knows. */
interface GuardPath {
  /** Identity used for comparison: canonical (symlinks/junctions resolved), lower-cased on Windows. */
  readonly key: string
  /** The path as the tool call spelled it, for the error the model reads. */
  readonly raw: string
  /** Whether the call showed the whole file. Meaningful for `read`; ignored for writes. */
  readonly whole: boolean
  /** The file's state when a **write** call is being checked; absent for reads and other tools. */
  readonly fingerprint?: Fingerprint
}

/** What the last guarded write of one path left behind. */
interface PathVersion {
  readonly version: number
  readonly writer: string
}

/** What one conversation knows of one path. */
interface SeenVersion {
  /** The version the last read (of any size) was taken at. */
  readonly version: number
  /** The version this conversation last saw the **whole** file at, or -1 when it never did. */
  readonly wholeVersion: number
  /** The file's state at the last read (any size); `undefined` when it could not be observed. */
  readonly fingerprint: Fingerprint
  /** The file's state when the whole file was last read or written; `undefined` when never. */
  readonly wholeFingerprint: Fingerprint
}

/** Why a write is being refused. */
export type StaleKind =
  /** Another conversation wrote the file after this one's last read of it (version fallback). */
  | 'stale'
  /** Another conversation's write is between its call and its result right now. */
  | 'inflight'
  /** This conversation has not seen the whole current file, so a whole-file write would drop the
   *  lines it never read. */
  | 'unseen'
  /** The bytes on disk are not the bytes this conversation last saw whole - whoever changed them
   *  (another conversation, a command, an editor, a checkout). */
  | 'changed'
  /** The file already exists and this conversation has never read it; a whole-file write would
   *  replace content it never saw. */
  | 'unread'

/** The first path one blocked call should tell the model about, and why. */
export interface StaleWrite {
  readonly path: string
  readonly kind: StaleKind
}

/**
 * The process-wide table of who wrote what, and what each conversation has already seen.
 *
 * Exported as a class so tests can build an isolated table; production code uses
 * {@link writeGuard}.
 */
export class WriteGuard {
  readonly #versions = new Map<string, PathVersion>()
  readonly #known = new Map<string, Map<string, SeenVersion>>()
  readonly #pending = new Map<string, string[]>()
  /**
   * Path -> the conversation whose write is between its call and its result.
   *
   * The version below only moves when a write **succeeds**, so two calls that overlap would both
   * pass the check and the later one would silently overwrite the earlier one's bytes. The tool call
   * is the earliest point both sides can see, so it marks the path occupied here; another
   * conversation's write is refused until the result lands and the version moves (`takePending`).
   * Bound: at most one key per pending call's paths (`MAX_PENDING_CALLS`); an evicted or forgotten
   * call releases its marks with it, and a mark older than `INFLIGHT_MAX_MS` is treated as a call
   * that never reported back.
   */
  readonly #inflight = new Map<string, { readonly session: string; readonly at: number }>()

  /** Records what `sessionId` has just read of each path (how much of it, and which bytes). */
  noteRead(sessionId: string, paths: readonly GuardPath[]): void {
    if (paths.length === 0) return
    const known = this.#knownOf(sessionId)
    for (const guarded of paths) {
      const previous = known.get(guarded.key)
      const current = this.#versions.get(guarded.key)?.version ?? 0
      const print = fingerprintOf(guarded.key)
      // A whole read at this version is the strongest view; a range read never upgrades it.
      const wholeVersion = guarded.whole ? current : (previous?.wholeVersion ?? -1)
      const wholeFingerprint = guarded.whole ? print : previous?.wholeFingerprint
      known.delete(guarded.key)
      known.set(guarded.key, {
        version: current,
        wholeVersion,
        fingerprint: print,
        wholeFingerprint,
      })
      this.#trimKnown(known)
    }
  }

  /**
   * The first reason a write of these paths must be refused, if any.
   *
   * Three situations, in the order they can hurt:
   *
   * 1. **inflight** - another conversation's write is between its call and its result right now.
   *    The version has not moved yet, so without this both writes would pass and the later bytes
   *    would win.
   * 2. **stale** - another conversation wrote after this one's last read of any size: the model's
   *    view is of an older file.
   * 3. **unseen** - only checked for a whole-file `write`: the last read was a window (or the file
   *    was only ever seen through one), and another conversation has written since this
   *    conversation last saw the whole file. Writing every line from memory would drop the lines it
   *    never read (and with them the other conversation's change). A targeted `edit` or
   *    `apply_patch` is unaffected: both are checked against the file's own content.
   *
   * A path this conversation never read is not stale: creating a file, or overwriting one whose
   * content was never part of this conversation's view, is the caller's own decision.
   */
  firstStale(
    sessionId: string,
    paths: readonly GuardPath[],
    requireWhole: boolean,
  ): StaleWrite | undefined {
    const known = this.#known.get(sessionId)
    for (const guarded of paths) {
      const holder = this.#inflight.get(guarded.key)
      if (holder !== undefined && holder.session !== sessionId) {
        if (Date.now() - holder.at < INFLIGHT_MAX_MS) {
          return { path: guarded.raw, kind: 'inflight' }
        }
        // The call never reported back; a local write cannot still be landing after this long.
        this.#inflight.delete(guarded.key)
      }
      const seen = known?.get(guarded.key)
      if (seen === undefined) {
        // A file that exists and was never read is not safe to overwrite whole: the conversation
        // has no idea what it would replace. Creating a file (nothing on disk) is always fine.
        if (requireWhole && guarded.fingerprint !== undefined && guarded.fingerprint !== null) {
          return { path: guarded.raw, kind: 'unread' }
        }
        continue
      }
      // With an observable file, the bytes are the authority: whoever changed them - a guarded
      // conversation, a shell command, a subagent, an editor - a mismatch is a stale view. When the
      // bytes are exactly the ones this conversation saw whole, no version check can add anything
      // (and a same-content rewrite must not lock the file).
      if (requireWhole && guarded.fingerprint !== undefined) {
        if (seen.wholeFingerprint === undefined) {
          return { path: guarded.raw, kind: 'unseen' }
        }
        if (guarded.fingerprint !== seen.wholeFingerprint) {
          return { path: guarded.raw, kind: 'changed' }
        }
        continue
      }
      const current = this.#versions.get(guarded.key)
      if (current === undefined || current.writer === sessionId) continue
      if (current.version > seen.version) return { path: guarded.raw, kind: 'stale' }
      if (requireWhole && current.version > seen.wholeVersion) {
        return { path: guarded.raw, kind: 'unseen' }
      }
    }
    return undefined
  }

  /** Remembers the paths a guarded call is about to write, for its `tool_result` to confirm. */
  notePending(sessionId: string, toolCallId: string, paths: readonly GuardPath[]): void {
    if (paths.length === 0) return
    const key = pendingKey(sessionId, toolCallId)
    this.#releaseCall(sessionId, key)
    this.#pending.set(
      key,
      paths.map(guarded => guarded.key),
    )
    for (const guarded of paths) {
      this.#inflight.set(guarded.key, { session: sessionId, at: Date.now() })
    }
    while (this.#pending.size > MAX_PENDING_CALLS) {
      const oldest = this.#pending.keys().next().value
      if (oldest === undefined) break
      const owner = oldest.split('\u0000', 1)[0] ?? ''
      this.#releaseCall(owner, oldest)
    }
  }

  /** Drops one call's pending paths, answering them so the caller can record the write. */
  takePending(sessionId: string, toolCallId: string): readonly string[] | undefined {
    const key = pendingKey(sessionId, toolCallId)
    const paths = this.#pending.get(key)
    if (paths === undefined) return undefined
    this.#releaseCall(sessionId, key)
    return paths
  }

  /**
   * Records a successful write and the bytes it left on disk.
   *
   * A `write` replaced every line, so the writer's view is the whole current file. An `edit` is
   * checked against the file's own content by the engine and leaves the parts it did not touch
   * alone, so a session that already knew the whole file still does. An `apply_patch` only claims
   * the lines it patched: a later whole-file write still needs a fresh whole read.
   */
  noteWrite(sessionId: string, keys: readonly string[], toolName: string): void {
    const known = this.#knownOf(sessionId)
    for (const key of keys) {
      const version = (this.#versions.get(key)?.version ?? 0) + 1
      this.#versions.delete(key)
      this.#versions.set(key, { version, writer: sessionId })
      const previous = known.get(key)
      const whole = toolName === 'write' || (toolName === 'edit' && previous?.wholeFingerprint !== undefined)
      const print = fingerprintOf(key)
      const wholeVersion = whole ? version : (previous?.wholeVersion ?? -1)
      const wholeFingerprint = whole ? print : previous?.wholeFingerprint
      known.delete(key)
      known.set(key, {
        version,
        wholeVersion,
        fingerprint: print,
        wholeFingerprint,
      })
      this.#trimKnown(known)
    }
    while (this.#versions.size > MAX_TRACKED_PATHS) {
      const oldest = this.#versions.keys().next().value
      if (oldest === undefined) break
      this.#versions.delete(oldest)
    }
  }

  /**
   * Releases every call this conversation still has open (a turn ended without a result for one).
   *
   * The read marks stay: they are what the conversation saw, and a turn boundary does not change the
   * file. Only the call bookkeeping goes, so a write that never reported back cannot keep a path
   * locked after the turn it belonged to.
   */
  releaseCalls(sessionId: string): void {
    const prefix = `${sessionId}\u0000`
    for (const key of [...this.#pending.keys()]) {
      if (key.startsWith(prefix)) this.#releaseCall(sessionId, key)
    }
    for (const [key, holder] of this.#inflight) {
      if (holder.session === sessionId) this.#inflight.delete(key)
    }
  }

  /** Drops one conversation's view; the versions it wrote stay, so other views still go stale. */
  forget(sessionId: string): void {
    this.#known.delete(sessionId)
    this.releaseCalls(sessionId)
  }

  /** Test seam: how many paths and sessions the table currently holds. */
  sizesForTest(): { versions: number; sessions: number; pending: number; inflight: number } {
    return {
      versions: this.#versions.size,
      sessions: this.#known.size,
      pending: this.#pending.size,
      inflight: this.#inflight.size,
    }
  }

  #knownOf(sessionId: string): Map<string, SeenVersion> {
    let known = this.#known.get(sessionId)
    if (known === undefined) {
      known = new Map()
      this.#known.set(sessionId, known)
    }
    return known
  }

  /** Keeps one conversation's view bounded, oldest path first. */
  #trimKnown(known: Map<string, SeenVersion>): void {
    while (known.size > MAX_KNOWN_PATHS) {
      const oldest = known.keys().next().value
      if (oldest === undefined) break
      known.delete(oldest)
    }
  }

  /** Drops a call's pending entry and the path marks it held, when it is still this call's. */
  #releaseCall(sessionId: string, callKey: string): void {
    const paths = this.#pending.get(callKey)
    if (paths === undefined) return
    this.#pending.delete(callKey)
    for (const key of paths) {
      if (this.#inflight.get(key)?.session === sessionId) this.#inflight.delete(key)
    }
  }
}

/** The host process's single table: every conversation is registered against this one. */
export const writeGuard = new WriteGuard()

function pendingKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}\u0000${toolCallId}`
}

/**
 * The text the model gets when a write is refused.
 *
 * It names the file and the reason, and says what to do next: an error the model cannot act on
 * would only be retried. It deliberately does not name the other conversation - the id is the
 * host's bookkeeping, not something the model needs to continue.
 */
function blockedReason(stale: StaleWrite): string {
  switch (stale.kind) {
    case 'inflight':
      return (
        `Blocked: another conversation is writing ${stale.path} right now. ` +
        `Read the file again after that write lands, then re-apply your change so both edits survive.`
      )
    case 'changed':
      return (
        `Blocked: ${stale.path} changed on disk since this conversation last read it whole ` +
        `(another conversation, a command or an editor may have written it). ` +
        `Read it again, then re-apply your change so both edits survive.`
      )
    case 'unread':
      return (
        `Blocked: ${stale.path} already exists and this conversation has not read it, so a whole-file ` +
        `write could replace content it never saw. Read it first, then write.`
      )
    case 'unseen':
      return (
        `Blocked: this conversation has not read the whole of ${stale.path} at its current version, ` +
        `so a whole-file write could drop lines it never saw (including another conversation's change). ` +
        `Read the file without a range, or make a targeted edit, then re-apply your change.`
      )
    default:
      return (
        `Blocked: another conversation modified ${stale.path} after your last read of it. ` +
        `Read the file again, then re-apply your change so both edits survive.`
      )
  }
}

/**
 * The plain filesystem paths a tool call names, or none when it names no local file.
 *
 * A read's `path` also names the window it wants (`file:10-20`), and its selector is stripped so the
 * guard keys the file. `whole` records whether the read showed all of it: a whole-file write needs
 * that, a range read does not provide it.
 */
function guardedPaths(cwd: string, toolName: string, input: unknown): GuardPath[] {
  if (typeof input !== 'object' || input === null) return []
  const fields = input as Record<string, unknown>
  const raw: string[] = []
  const single = fields.path
  if (typeof single === 'string') raw.push(single)
  const many = fields.paths
  if (Array.isArray(many)) {
    for (const entry of many) if (typeof entry === 'string') raw.push(entry)
  }
  if (toolName === 'apply_patch' && typeof fields.input === 'string') {
    raw.push(...applyPatchPaths(fields.input))
  }
  const seen = new Set<string>()
  const paths: GuardPath[] = []
  for (const entry of raw) {
    const target = toolName === 'read' ? readTarget(entry) : { path: entry, whole: false }
    const guarded = guardPath(cwd, target.path, target.whole)
    if (guarded === undefined || seen.has(guarded.key)) continue
    seen.add(guarded.key)
    // A whole-file write is checked against the bytes on disk at this moment; reads are
    // fingerprinted when they land (`noteRead`).
    const fingerprint = toolName === 'write' ? fingerprintOf(guarded.key) : undefined
    paths.push(fingerprint === undefined ? guarded : { ...guarded, fingerprint })
  }
  return paths
}

/** The file paths an `apply_patch` payload names. */
function applyPatchPaths(payload: string): string[] {
  const paths: string[] = []
  for (const pattern of [APPLY_PATCH_FILE, APPLY_PATCH_MOVE]) {
    pattern.lastIndex = 0
    let match = pattern.exec(payload)
    while (match !== null) {
      if (match[1] !== undefined) paths.push(match[1])
      match = pattern.exec(payload)
    }
  }
  return paths
}

/**
 * One path, resolved against the session's directory, or `undefined` when it is not a file.
 *
 * The key is the file's **canonical** path, not the spelling this call used: a workspace reached
 * through a junction, a symlink or a different letter case names the same file, and two spellings
 * that compare unequal would let one conversation's write pass a check the other's read had already
 * invalidated. `realpath` resolves the file when it exists and its directory when it does not (a
 * file about to be created); a path it cannot resolve (a fake path in a test, a not-yet-existing
 * directory) keeps the plain resolution.
 */
function guardPath(cwd: string, raw: string, whole: boolean): GuardPath | undefined {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  const unwrapped = SNAPSHOT_WRAPPER.exec(trimmed)?.[1] ?? trimmed
  if (isInternalUrl(unwrapped)) return undefined
  const resolved = canonicalPath(path.resolve(cwd, unwrapped))
  return {
    key: process.platform === 'win32' ? resolved.toLowerCase() : resolved,
    raw: unwrapped,
    whole,
  }
}

/** The final path of a file, or of its directory plus the name when the file does not exist yet. */
function canonicalPath(resolved: string): string {
  try {
    return fs.realpathSync(resolved)
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved))
    } catch {
      return resolved
    }
  }
}

/**
 * Whether a path names an internal resource rather than a file.
 *
 * The engine's internal URLs are `scheme://…` or `scheme:…` (`xd://`, `agent://`, `proc://`,
 * `history://`, `db.sqlite:table`), and `write` delegates to them. A Windows drive letter is a
 * single-letter scheme before a colon (`C:\…`), which is why the scheme needs at least two
 * characters.
 */
function isInternalUrl(value: string): boolean {
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value)?.[1]
  return scheme !== undefined && scheme.length > 1
}

/** The `tool_call` half: note reads, refuse stale writes, remember what is being written. */
export function guardToolCall(
  guard: WriteGuard,
  sessionId: string,
  cwd: string,
  event: ToolCallEvent,
): ToolCallEventResult | undefined {
  const paths = guardedPaths(cwd, event.toolName, event.input)
  if (paths.length === 0) return undefined
  if (event.toolName === 'read') {
    guard.noteRead(sessionId, paths)
    return undefined
  }
  if (WRITE_TOOLS[event.toolName] !== true) return undefined
  // Only a whole-file write can drop content the conversation never saw; a patch or an edit is
  // checked against the file's own content by the engine.
  const stale = guard.firstStale(sessionId, paths, event.toolName === 'write')
  if (stale !== undefined) {
    logLine(`write guard blocked ${sessionId} (${event.toolName} ${stale.path}: ${stale.kind})`)
    return { block: true, reason: blockedReason(stale) }
  }
  guard.notePending(sessionId, event.toolCallId, paths)
  return undefined
}

/** The `tool_result` half: a call that succeeded advances the version its peers compare against. */
export function guardToolResult(guard: WriteGuard, sessionId: string, event: ToolResultEvent): void {
  if (WRITE_TOOLS[event.toolName] !== true) return
  const keys = guard.takePending(sessionId, event.toolCallId)
  if (keys === undefined) return
  if (event.isError) return
  // A `write` replaced every line, so the writer knows the whole current file; an edit only changed
  // the lines it named (and keeps a whole view it already had).
  guard.noteWrite(sessionId, keys, event.toolName)
}

/**
 * The turn-end half: a call that never reported back must not keep a path locked after its turn.
 *
 * The engine answers every tool call, including a failed or aborted one, so this is the safety net
 * for the case it somehow does not. It releases only the call bookkeeping, never what the
 * conversation has read: a turn boundary does not change the file.
 */
export function guardTurnEnd(guard: WriteGuard, sessionId: string): void {
  guard.releaseCalls(sessionId)
}

/**
 * The extension one conversation is created with.
 *
 * The factory closes over the session's routing id and its working directory, so the handler
 * never has to look either up from a context the engine owns.
 */
export function writeGuardExtension(
  sessionId: string,
  cwd: string,
  guard: WriteGuard = writeGuard,
): ExtensionFactory {
  return pi => {
    pi.on('tool_call', event => guardToolCall(guard, sessionId, cwd, event))
    pi.on('tool_result', event => guardToolResult(guard, sessionId, event))
    pi.on('turn_end', () => guardTurnEnd(guard, sessionId))
  }
}
