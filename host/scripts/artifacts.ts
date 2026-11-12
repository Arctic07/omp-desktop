/**
 * Records the artifact metrics the delivery claims: the shipped bundle's files, bytes and digests,
 * the installed copy's parity with it, the addon identity and the measured startup latencies taken
 * from the smoke summaries. It also fails when the bundle is not the build this checkout describes,
 * which is what `provenance.ts` reads out of the bundle's own files.
 *
 * Usage: `bun run host/scripts/artifacts.ts`
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { verifyBundleProvenance } from './provenance.ts'
import { BUNDLE_DIRNAME, type BundleManifest, PLATFORM_TAG, resolvePackage } from './packages.ts'

const repoRoot = path.resolve(import.meta.dir, '..', '..')
const evidenceDir = path.join(repoRoot, 'host', 'evidence')
const distBundle = path.join(repoRoot, 'host', 'dist', BUNDLE_DIRNAME)
const installedBundle = path.join(repoRoot, 'src-tauri', 'binaries', BUNDLE_DIRNAME)

interface BundleFileMetric {
  readonly file: string
  readonly bytes: number
  readonly sha256: string
  readonly declaredBytes: number
  readonly declaredSha256: string
  readonly ok: boolean
}

interface BundleDescription {
  readonly directory: string
  readonly files: BundleFileMetric[]
  readonly totalBytes: number
  readonly protocol: number
  readonly sdkVersion: string
}

/** One bundle's manifest and every file it names, re-hashed from disk. */
function describeBundle(directory: string): BundleDescription | null {
  const manifestPath = path.join(directory, 'manifest.json')
  if (!fs.existsSync(manifestPath)) return null
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BundleManifest
  const files = manifest.files.map(file => {
    const filePath = path.join(directory, file.file)
    const bytes = fs.statSync(filePath).size
    const sha256 = createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
    return {
      file: file.file,
      bytes,
      sha256,
      declaredBytes: file.bytes,
      declaredSha256: file.sha256,
      ok: bytes === file.bytes && sha256 === file.sha256,
    }
  })
  return {
    directory: path.relative(repoRoot, directory),
    files,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    protocol: manifest.protocol,
    sdkVersion: manifest.sdkVersion,
  }
}

/**
 * Whether two described bundles are the same artifact: the same file names in the same order, each
 * with the same bytes and digest. Comparing a directory byte for byte is what makes "the installed
 * copy is the build" a fact rather than an assumption about the copy step.
 */
function sameBundle(left: BundleDescription | null, right: BundleDescription | null): boolean {
  if (left === null || right === null) return false
  if (left.files.length !== right.files.length) return false
  return left.files.every((file, index) => {
    const peer = right.files[index]
    return peer !== undefined && file.file === peer.file && file.bytes === peer.bytes && file.sha256 === peer.sha256
  })
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

const dist = describeBundle(distBundle)
const installed = describeBundle(installedBundle)
const provenance = verifyBundleProvenance(repoRoot)
// The addon is resolved the way the build resolves it: from the installed coding agent down to
// the platform leaf. Globbing `.pnpm` picked whichever version directory the filesystem listed
// first, so after an upgrade that left an unpruned old tree the check reported the previous
// version's file while the bundle carried the new one (2026-11-09).
const installedCodingAgent = resolvePackage(repoRoot, '@oh-my-pi/pi-coding-agent')
const natives = resolvePackage(installedCodingAgent, '@oh-my-pi/pi-natives')
const addonSource = path.join(
  resolvePackage(natives, `@oh-my-pi/pi-natives-${PLATFORM_TAG}`),
  `pi_natives.${PLATFORM_TAG}-baseline.node`,
)
// The bundle ships the addon as a plain file beside `host.js`; compare that file with the published
// leaf directly. The old per-version extraction cache belonged to the compiled layout, which no
// longer exists.
const addonFile = path.basename(addonSource)
const addonDigest = createHash('sha256').update(fs.readFileSync(addonSource)).digest('hex')
const shippedAddon = installed?.files.find(file => file.file === addonFile)

const report = {
  at: new Date().toISOString(),
  dist,
  installed,
  installedMatchesDist: sameBundle(dist, installed),
  provenance,
  addon: {
    sourceFile: path.relative(repoRoot, addonSource),
    sourceBytes: fs.statSync(addonSource).size,
    bundleFile: shippedAddon?.file ?? null,
    bundleBytes: shippedAddon?.bytes ?? null,
    identical: shippedAddon !== undefined && shippedAddon.sha256 === addonDigest,
  },
  startup: startups(),
}

const target = path.join(evidenceDir, 'w2-artifacts.json')
fs.writeFileSync(target, `${JSON.stringify(report, null, 1)}\n`, 'utf8')
console.log(JSON.stringify(report, null, 1))

const failed: string[] = []
if (dist === null) failed.push('bundle: host/dist/bundle is missing; run `pnpm host:install`')
else failed.push(...dist.files.filter(file => !file.ok).map(file => `dist/${file.file}: bytes or sha256 differ from the manifest`))
if (installed === null) failed.push('installed: src-tauri/binaries/bundle is missing; run `pnpm host:install`')
else failed.push(...installed.files.filter(file => !file.ok).map(file => `installed/${file.file}: bytes or sha256 differ from the manifest`))
if (!sameBundle(dist, installed)) failed.push('installed bundle is not the bundle host/dist built')
if (provenance === null) failed.push('bundle provenance: no bundle at host/dist/bundle')
else failed.push(...provenance.checks.filter(entry => !entry.ok).map(entry => `bundle/${entry.name}: ${entry.detail}`))
if (failed.length > 0) {
  for (const line of failed) console.error(`FAIL ${line}`)
  process.exitCode = 1
}
