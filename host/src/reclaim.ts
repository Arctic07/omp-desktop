/**
 * Reclaiming what the engine itself left on disk, from inside the engine's own process.
 *
 * The data ownership rule (`rules.md#engine-integration-and-data-ownership`) is that the engine's tree is read-only to everything
 * else in this application, and that anything written there goes through the protocol. Caches the
 * engine creates are the one case where that rule leaves the user with a growing directory nobody
 * can reclaim: this module is that reclaim, performed by the process that owns the directory.
 *
 * One kind of leftover, all of it derived and rebuildable:
 *
 * - **`natives/<version>`** - the engine's compiled addon, one directory per engine version. Every
 *   version but the running one is dead weight (181 MiB measured for a single stale version).
 *
 * Two rules keep this from destroying something live:
 *
 * 1. **A directory written to recently is left alone.** A native build a running engine loaded is
 *    being written to; `RECENT_MS` is the same one-day window the storage tooling in this sector
 *    uses, and it is checked against the newest file in the directory rather than the directory's
 *    own stamp.
 * 2. **Every path is proven to be inside the engine's own config root**, after resolving links, and
 *    a link itself is never followed. Nothing here can be pointed at a path outside the tree.
 *
 * The answer is per target, with bytes and a reason, so the caller can report what it freed and what
 * it had to leave - a clear that silently skipped half of what it claimed is worse than no clear.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * How recently a directory may have been written to and still count as in use, for the clear the
 * settings page offers.
 *
 * One day is the window the storage tooling in this sector uses, and the explicit clear is allowed
 * to be this aggressive because the reader is watching: everything it removes is rebuilt on demand.
 * The automatic pass asks for a week instead (`services::runtime::reclaim` in the desktop): nobody is
 * watching it, and a native build touched a day or two ago is more likely an engine that stopped
 * running than a leftover.
 */
const RECENT_MS = 24 * 60 * 60 * 1000

/**
 * The "recently written" window one reclaim was asked to use.
 *
 * `engine_reclaim` carries it because the same reclaim serves two callers with different appetites
 * (the explicit clear, and the desktop's automatic pass). A frame that names nothing - the clear,
 * and every answer from a build older than this field - resolves to {@link RECENT_MS}; a value that
 * is not a positive finite number is the same missing value rather than an error, because the
 * consequence of guessing low is an in-use directory being offered for removal.
 */
export function reclaimWindow(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : RECENT_MS
}

/** Ceiling on the entries one reclaim walks, so a pathological tree cannot hold the call. */
const MAX_ENTRIES = 200_000

export type ReclaimKind = 'engine-natives'

/** One directory this reclaim decided about. */
export interface ReclaimTarget {
  readonly path: string
  readonly kind: ReclaimKind
  readonly bytes: number
}

/** One directory it left behind, and why. */
export interface ReclaimSkip extends ReclaimTarget {
  readonly reason: 'in-use' | 'current-version' | 'unreadable' | 'failed' | 'outside-root'
}

export interface ReclaimOutcome {
  readonly freedBytes: number
  readonly removed: ReclaimTarget[]
  readonly skipped: ReclaimSkip[]
}

/** What the reclaim needs to know about the engine's own layout. */
export interface ReclaimPaths {
  /** `PI_CONFIG_DIR` under the pinned home: `<home>/omp-desktop`. */
  readonly configRoot: string
  /** The pinned `HOME`; the engine's `natives/` lives at `<home>/.omp/natives`. */
  readonly home: string
}

/** The running engine version, which is the one native build that must stay. */
export interface ReclaimOptions {
  readonly engineVersion: string
  /** How recently a target may have been written and still count as in use (`reclaimWindow`). */
  readonly recentMs: number
  /** Injected so a test can place "now" without waiting a day. */
  readonly now?: number
}

/** Every leftover this reclaim may consider, newest-safe first. */
function candidates(paths: ReclaimPaths): Array<{ path: string; kind: ReclaimKind }> {
  const found: Array<{ path: string; kind: ReclaimKind }> = []

  const natives = path.join(paths.home, '.omp', 'natives')
  for (const entry of listDirectories(natives)) {
    found.push({ path: entry, kind: 'engine-natives' })
  }

  return found
}

/**
 * Reclaims every leftover it can prove is safe, and answers what it did.
 *
 * Synchronous and bounded: the caller is a protocol frame handler that must answer, and the work is
 * a handful of directory removals under a tree this process owns.
 */
export function reclaimCaches(paths: ReclaimPaths, options: ReclaimOptions): ReclaimOutcome {
  const now = options.now ?? Date.now()
  const roots = [paths.configRoot, path.join(paths.home, '.omp')]
  const removed: ReclaimTarget[] = []
  const skipped: ReclaimSkip[] = []
  for (const candidate of candidates(paths)) {
    const resolved = resolve(candidate.path)
    if (resolved === null || !roots.some((root) => isInside(root, resolved))) {
      skipped.push({ ...candidate, bytes: 0, reason: 'outside-root' })
      continue
    }
    if (
      candidate.kind === 'engine-natives' &&
      path.basename(candidate.path) === options.engineVersion
    ) {
      // The addon the running engine loaded. Deleting it would break the next start.
      skipped.push({ ...candidate, bytes: measure(candidate.path), reason: 'current-version' })
      continue
    }
    const bytes = measure(candidate.path)
    if (newestWrite(candidate.path, now - options.recentMs) !== null) {
      skipped.push({ ...candidate, bytes, reason: 'in-use' })
      continue
    }
    try {
      fs.rmSync(candidate.path, { recursive: true, force: false })
      removed.push({ ...candidate, bytes })
    } catch {
      // Windows refuses a directory a running process holds open, which is the ordinary way this
      // fails: the answer says so instead of pretending the space came back.
      skipped.push({ ...candidate, bytes, reason: 'failed' })
    }
  }
  const freedBytes = removed.reduce((total, target) => total + target.bytes, 0)
  return { freedBytes, removed, skipped }
}

/**
 * The directories directly under `parent`, in name order; empty when there is none.
 *
 * A link counts as one so it can be *reported* rather than silently ignored: a linked directory is
 * not this application's to delete, and a reclaim that skipped it without a word would leave the
 * reader wondering where that space went.
 */
function listDirectories(parent: string): string[] {
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => path.join(parent, entry.name))
      .sort()
  } catch {
    return []
  }
}

/** The real path of `target`, or `null` when it is a link or cannot be resolved. */
function resolve(target: string): string | null {
  try {
    // A link is refused rather than followed: this application never creates one under the engine's
    // tree, so one there was put by something else and its contents are somewhere else.
    if (fs.lstatSync(target).isSymbolicLink()) return null
    // `realpath` resolves the parent's links too, which is what makes the containment test honest.
    const parent = fs.realpathSync(path.dirname(target))
    return path.join(parent, path.basename(target))
  } catch {
    return null
  }
}

/** Whether `child` is `root` or below it, on both sides resolved. */
function isInside(root: string, child: string): boolean {
  let base: string
  try {
    base = fs.realpathSync(root)
  } catch {
    return false
  }
  const relative = path.relative(base, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** The bytes under `directory`, bounded by `MAX_ENTRIES`; links are neither counted nor followed. */
function measure(directory: string): number {
  let total = 0
  let visited = 0
  const pending = [directory]
  while (pending.length > 0) {
    const next = pending.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(next, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (visited >= MAX_ENTRIES) return total
      visited += 1
      const child = path.join(next, entry.name)
      if (entry.isDirectory()) {
        pending.push(child)
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(child).size
        } catch {
          // A file that vanished while the walk ran contributes nothing.
        }
      }
    }
  }
  return total
}

/**
 * The newest write under `directory` at or after `floor`, or `null` when everything is older.
 *
 * The walk stops as soon as one file is recent enough: this is asked to answer "is it in use", and a
 * single fresh file already answers yes.
 */
function newestWrite(directory: string, floor: number): number | null {
  const pending = [directory]
  while (pending.length > 0) {
    const next = pending.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(next, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = path.join(next, entry.name)
      if (entry.isDirectory()) {
        pending.push(child)
        continue
      }
      try {
        const written = fs.lstatSync(child).mtimeMs
        if (written >= floor) return written
      } catch {
        // Skipped: a file that vanished is not evidence of use.
      }
    }
  }
  return null
}
