/**
 * Data-isolation evidence: a file inventory of every directory a host run may touch.
 *
 * Two runs (before/after) let the diff prove that nothing outside the data root was written -
 * in particular not the real user profile, which is where the engine would write if a pin
 * variable were missing.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const repoRoot = path.resolve(import.meta.dir, '..', '..')
const evidenceDir = path.join(repoRoot, 'host', 'evidence')
const devData = path.join(repoRoot, 'host', '.dev-data')
const label = process.argv[2] ?? 'snapshot'

/** Recursive inventory: every path under `root`, with the size and modification time of files. */
function inventory(root: string, limit = 200_000): string[] {
  const entries: string[] = []
  const walk = (directory: string): void => {
    if (entries.length > limit) return
    let names: string[]
    try {
      names = fs.readdirSync(directory)
    } catch {
      return
    }
    for (const name of names) {
      const full = path.join(directory, name)
      let stats: fs.Stats
      try {
        stats = fs.lstatSync(full)
      } catch {
        continue
      }
      if (stats.isDirectory()) {
        entries.push(`${full}|dir`)
        walk(full)
      } else {
        entries.push(`${full}|${stats.size}|${Math.round(stats.mtimeMs)}`)
      }
    }
  }
  walk(root)
  entries.sort()
  return entries
}

const realHome = os.homedir()
const userProfile = process.env.USERPROFILE ?? realHome

/** Compares two inventories and reports the paths that were added, removed or changed. */
function diff(left: readonly string[], right: readonly string[]): { added: string[]; removed: string[]; changed: string[] } {
  const before = new Map(left.map(entry => [entry.split('|')[0] as string, entry]))
  const after = new Map(right.map(entry => [entry.split('|')[0] as string, entry]))
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  for (const [key, value] of after) {
    const previous = before.get(key)
    if (previous === undefined) added.push(value)
    else if (previous !== value) changed.push(`${previous} -> ${value}`)
  }
  for (const [key, value] of before) {
    if (!after.has(key)) removed.push(value)
  }
  return { added, removed, changed }
}

if (label === 'diff') {
  const before = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'w2-isolation-before.json'), 'utf8')) as {
    devData: string[]
    userEngineRoots: Record<string, string[]>
  }
  const after = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'w2-isolation-after.json'), 'utf8')) as {
    devData: string[]
    userEngineRoots: Record<string, string[]>
  }
  const report: Record<string, unknown> = {}
  const dev = diff(before.devData, after.devData)
  report.devData = {
    added: dev.added.length,
    removed: dev.removed.length,
    changed: dev.changed.length,
    removedPaths: dev.removed.slice(0, 20),
    changedPaths: dev.changed.slice(0, 20),
  }
  // A run under the pinned data root must not add a single path outside it; anything that appears
  // here belongs to another process on this machine and must be attributed as such.
  for (const root of Object.keys(after.userEngineRoots)) {
    const entries = diff(before.userEngineRoots[root] ?? [], after.userEngineRoots[root] ?? [])
    report[root] = { added: entries.added, removed: entries.removed.length, changed: entries.changed.length }
  }
  const target = path.join(evidenceDir, 'w2-isolation.diff.json')
  fs.writeFileSync(target, `${JSON.stringify(report, null, 1)}\n`, 'utf8')
  console.log(JSON.stringify(report, null, 1))
  process.exit(0)
}

const snapshot = {
  label,
  at: new Date().toISOString(),
  devData: inventory(devData),
  // The engine's own config root and agent directory as they exist for a real user; a run with
  // pinned directories must not add a single entry here.
  userEngineRoots: {
    [path.join(realHome, '.omp')]: inventory(path.join(realHome, '.omp')),
    [path.join(userProfile, 'omp-desktop')]: inventory(path.join(userProfile, 'omp-desktop')),
  },
}

fs.mkdirSync(evidenceDir, { recursive: true })
const target = path.join(evidenceDir, `w2-isolation-${label}.json`)
fs.writeFileSync(target, `${JSON.stringify(snapshot, null, 1)}\n`, 'utf8')
console.log(
  `isolation[${label}]: devData=${snapshot.devData.length} entries, ` +
    `userRoots=${Object.entries(snapshot.userEngineRoots)
      .map(([root, entries]) => `${path.basename(root)}=${entries.length}`)
      .join(' ')} -> ${path.relative(repoRoot, target)}`,
)
