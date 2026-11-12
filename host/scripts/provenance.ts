/**
 * Provenance checks for the built host bundle: the files in `host/dist/bundle` must come from the
 * packages this checkout has installed.
 *
 * `manifest.json` records what the build wrote, but the same build writes both the manifest and the
 * files it describes, so agreeing with each other proves only that nothing changed after packaging.
 * The checks therefore read the bundle as a whole: the SDK version must equal what the checkout
 * resolves, the entry must carry this host's own code and the uncompiled shape, the addons must be
 * the ones the platform leaf publishes, and every listed file must hash to its recorded digest.
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { BUNDLE_DIRNAME, type BundleFile, type BundleManifest, PLATFORM_TAG, resolvePackage } from './packages.ts'

/** The checks, named after what they pin rather than how they read it. */
export type ProvenanceCheckName =
  | 'sdk-version'
  | 'bundle-entry'
  | 'runtime'
  | 'addon-files'
  | 'file-hashes'

export interface ProvenanceCheck {
  readonly name: ProvenanceCheckName
  readonly ok: boolean
  readonly detail: string
}

export interface ProvenanceReport {
  readonly artifact: string
  readonly ok: boolean
  readonly checks: readonly ProvenanceCheck[]
}

function versionOf(packageDir: string): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error(`${packageDir}/package.json has no string version`)
  return manifest.version
}

/** The addon files the platform leaf package publishes, as size plus digest. */
function publishedAddons(nativesDir: string): { file: string; bytes: number; sha256: string }[] {
  const leaf = resolvePackage(nativesDir, `@oh-my-pi/pi-natives-${PLATFORM_TAG}`)
  const files = fs.readdirSync(leaf).filter(name => name.startsWith('pi_natives.') && name.endsWith('.node'))
  if (files.length === 0) throw new Error(`${leaf} publishes no pi_natives.*.node`)
  return files.map(file => {
    const bytes = fs.readFileSync(path.join(leaf, file))
    return { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
}

/**
 * Verifies the shipped bundle: the runtime plus plain files that `build.ts` writes.
 *
 * The evidence is the whole directory rather than one digest: every listed file is checked, the
 * addons must equal what the platform leaf publishes, and the entry must be the uncompiled shape
 * rather than a stale compiled copy sitting in its place.
 *
 * Returns null when the directory is absent: nothing has been built yet.
 */
export function verifyBundleProvenance(repoRoot = path.resolve(import.meta.dir, '..', '..')): ProvenanceReport | null {
  const bundleDir = path.join(repoRoot, 'host', 'dist', BUNDLE_DIRNAME)
  if (!fs.existsSync(bundleDir)) return null
  const manifestFile = path.join(bundleDir, 'manifest.json')
  if (!fs.existsSync(manifestFile)) {
    return {
      artifact: bundleDir,
      ok: false,
      checks: [{ name: 'file-hashes', ok: false, detail: 'the bundle directory has no manifest.json' }],
    }
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as BundleManifest
  const sdkDir = resolvePackage(repoRoot, '@oh-my-pi/pi-coding-agent')
  const resolvedVersion = versionOf(sdkDir)
  const checks: ProvenanceCheck[] = []

  checks.push({
    name: 'sdk-version',
    ok: manifest.sdkVersion === resolvedVersion,
    detail:
      manifest.sdkVersion === resolvedVersion
        ? `bundle and checkout both name ${resolvedVersion}`
        : `bundle says ${manifest.sdkVersion}, checkout resolves ${resolvedVersion} - rebuild with \`pnpm host:install\``,
  })

  const byRole = (role: BundleFile['role']): BundleFile[] => manifest.files.filter(entry => entry.role === role)
  const bundleFile = manifest.files.find(entry => entry.file === manifest.entry)
  const bundlePath = bundleFile === undefined ? null : path.join(bundleDir, bundleFile.file)
  if (bundlePath === null || !fs.existsSync(bundlePath)) {
    checks.push({ name: 'bundle-entry', ok: false, detail: `the manifest's entry ${manifest.entry} is not in the directory` })
  } else {
    const text = fs.readFileSync(bundlePath, 'utf8')
    // Two facts at once: the file carries this application's own code, and it is a plain bundle
    // rather than a compiled artifact copied under the entry name. `B:/~BUN/` is the module path a
    // compiled binary resolves its own code through, so it cannot appear in an uncompiled bundle.
    const ours = text.includes('OMP_DESKTOP_CODING_AGENT_DIR')
    const compiled = text.includes('B:/~BUN/')
    checks.push({
      name: 'bundle-entry',
      ok: ours && !compiled,
      detail:
        ours && !compiled
          ? `${manifest.entry} is a plain bundle of this host`
          : `the entry is not the expected bundle (own code: ${ours}, compiled marker: ${compiled})`,
    })
  }

  const runtime = byRole('runtime')
  checks.push({
    name: 'runtime',
    ok: runtime.length === 1,
    detail:
      runtime.length === 1
        ? `runtime ${runtime[0]?.file} (${runtime[0]?.bytes} B)`
        : `expected exactly one runtime file, the manifest lists ${runtime.length}`,
  })

  const published = publishedAddons(resolvePackage(sdkDir, '@oh-my-pi/pi-natives'))
  const publishedDigests = new Set(published.map(entry => entry.sha256))
  const addons = byRole('addon')
  const unknown = addons.filter(entry => !publishedDigests.has(entry.sha256))
  const missing = addons.length === 0
  checks.push({
    name: 'addon-files',
    ok: !missing && unknown.length === 0,
    detail: missing
      ? 'the manifest lists no addon'
      : unknown.length === 0
        ? `${addons.map(entry => entry.file).join(', ')} match the published leaf`
        : `${unknown.map(entry => entry.file).join(', ')} do not match any published pi_natives.*.node`,
  })

  const wrong = manifest.files.filter(entry => {
    const file = path.join(bundleDir, entry.file)
    if (!fs.existsSync(file)) return true
    const bytes = fs.statSync(file).size
    return bytes !== entry.bytes || createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== entry.sha256
  })
  checks.push({
    name: 'file-hashes',
    ok: wrong.length === 0,
    detail:
      wrong.length === 0
        ? `${manifest.files.length} files match the manifest`
        : `${wrong.map(entry => entry.file).join(', ')} differ from the manifest (missing, resized, or rewritten)`,
  })

  return { artifact: bundleDir, ok: checks.every(check => check.ok), checks }
}
