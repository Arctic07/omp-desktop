/**
 * Records the artifact metrics the delivery claims: bytes, sha256, embedded addon identity and
 * the measured startup latencies taken from the smoke summaries. It also fails when the artifact
 * is not the build this checkout describes, which is what `provenance.ts` reads out of the
 * executable's own bytes.
 *
 * Usage: `bun run host/scripts/artifacts.ts`
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { verifyBundleProvenance, verifyHostProvenance } from './provenance.ts'
import { PLATFORM_TAG, resolvePackage } from './packages.ts'

const repoRoot = path.resolve(import.meta.dir, '..', '..')
const evidenceDir = path.join(repoRoot, 'host', 'evidence')
const dist = path.join(repoRoot, 'host', 'dist', 'omp-host.exe')
const installed = path.join(repoRoot, 'src-tauri', 'binaries', 'omp-host-x86_64-pc-windows-msvc.exe')

function describe(file: string): { bytes: number; sha256: string } {
  const hash = createHash('sha256')
  hash.update(fs.readFileSync(file))
  return { bytes: fs.statSync(file).size, sha256: hash.digest('hex') }
}

/** Startup latencies as the smoke measured them, per mode and scenario. */
function startups(): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const name of fs.readdirSync(evidenceDir)) {
    if (!name.startsWith('w2-summary.') || !name.endsWith('.json')) continue
    const parsed = JSON.parse(fs.readFileSync(path.join(evidenceDir, name), 'utf8')) as {
      summaries: Record<string, { startup?: { spawnToHelloMs: number | null; spawnToReadyMs: number | null } }>
    }
    for (const [tag, summary] of Object.entries(parsed.summaries)) {
      if (summary.startup !== undefined) result[tag] = summary.startup
    }
  }
  return result
}

const distInfo = describe(dist)
const installedInfo = describe(installed)
const provenance = verifyHostProvenance(repoRoot)
const bundleProvenance = verifyBundleProvenance(repoRoot)
// The addon is resolved the way the build resolves it: from the installed coding agent down to
// the platform leaf. Globbing `.pnpm` picked whichever version directory the filesystem listed
// first, so after an upgrade that left an unpruned old tree the check reported the previous
// version's file while the binary carried the new one (2026-11-09).
const installedCodingAgent = resolvePackage(repoRoot, '@oh-my-pi/pi-coding-agent')
const natives = resolvePackage(installedCodingAgent, '@oh-my-pi/pi-natives')
const nativesManifest = JSON.parse(fs.readFileSync(path.join(natives, 'package.json'), 'utf8')) as { version?: unknown }
if (typeof nativesManifest.version !== 'string') throw new Error('@oh-my-pi/pi-natives manifest has no string version')
const addonVersion = nativesManifest.version
const addonSource = path.join(
  resolvePackage(natives, `@oh-my-pi/pi-natives-${PLATFORM_TAG}`),
  `pi_natives.${PLATFORM_TAG}-baseline.node`,
)
// The addon is staged into a per-version cache directory (`<xdg>/omp/natives/<version>/`), so the
// version is read off the installed package rather than written down here: a pinned literal would
// silently stop matching on the next dependency bump and report a missing extraction as a fact.
const extracted = path.join(
  repoRoot,
  'host',
  '.dev-data',
  'data',
  'host',
  'xdg',
  'omp',
  'natives',
  addonVersion,
  `pi_natives.${PLATFORM_TAG}-baseline.node`,
)
const md5 = (file: string): string => createHash('md5').update(fs.readFileSync(file)).digest('hex')

const report = {
  at: new Date().toISOString(),
  dist: { file: path.relative(repoRoot, dist), ...distInfo },
  installed: { file: path.relative(repoRoot, installed), ...installedInfo },
  installedMatchesDist: distInfo.sha256 === installedInfo.sha256 && distInfo.bytes === installedInfo.bytes,
  provenance,
  bundleProvenance,
  addon: {
    sourceFile: path.relative(repoRoot, addonSource),
    sourceBytes: fs.statSync(addonSource).size,
    extractedFile: path.relative(repoRoot, extracted),
    extractedBytes: fs.existsSync(extracted) ? fs.statSync(extracted).size : null,
    identical: fs.existsSync(extracted) && md5(addonSource) === md5(extracted),
  },
  startup: startups(),
}

const target = path.join(evidenceDir, 'w2-artifacts.json')
fs.writeFileSync(target, `${JSON.stringify(report, null, 1)}\n`, 'utf8')
console.log(JSON.stringify(report, null, 1))

const failed = [
  ...provenance.checks.filter(entry => !entry.ok).map(entry => `compiled/${entry.name}: ${entry.detail}`),
  ...(bundleProvenance === null ? [] : bundleProvenance.checks.filter(entry => !entry.ok).map(entry => `bundle/${entry.name}: ${entry.detail}`)),
]
if (failed.length > 0) {
  for (const line of failed) console.error(`FAIL ${line}`)
  process.exitCode = 1
}
