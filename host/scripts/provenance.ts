/**
 * Provenance checks for the built host executable: the bytes in `host/dist` must come from the
 * packages this checkout has installed.
 *
 * `omp-host.json` records what the build embedded, but the same build writes both the manifest and
 * the artifact it describes, so agreeing with each other proves only that nothing changed after
 * packaging. Measured 2026-11-08: `host/dist/omp-host.exe` carried SDK 18.13.3 (`"18.13.3"`
 * appearing 3,125 times inside the executable, `"18.16.0"` zero) while the checkout had resolved
 * 18.16.0 - a stale artifact every existing check passed, because the manifest agreed with the
 * binary it described.
 *
 * These checks read the executable instead of the manifest:
 *
 *   - `sdk-version`    the manifest's version equals the version the checkout resolves
 *   - `entry-module`   the embedded bundle starts at this repository's `host/src/main.ts`
 *   - `embedded-addon` the embedded zstd frame decompresses to exactly the published `.node`
 *
 * `embedded-addon` is what makes a hand-copied or substituted artifact visible: the frame is the
 * addon's only home in the executable, and nothing else in the tree pins those bytes.
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { BUNDLE_DIRNAME, type BundleFile, type BundleManifest, PLATFORM_TAG, resolvePackage } from './packages.ts'

/** The checks, named after what they pin rather than how they read it. */
export type ProvenanceCheckName =
  | 'artifact-size'
  | 'sdk-version'
  | 'entry-module'
  | 'embedded-addon'
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

/** One section of a PE image, in the terms the checks need to reach bytes by name. */
interface Section {
  readonly name: string
  readonly rawSize: number
  readonly rawOffset: number
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function versionOf(packageDir: string): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error(`${packageDir}/package.json has no string version`)
  return manifest.version
}

function sectionsOf(bytes: Buffer): Section[] {
  if (bytes.length < 0x40) throw new Error('artifact is shorter than a DOS header')
  const peOffset = bytes.readUInt32LE(0x3c)
  if (bytes.toString('latin1', peOffset, peOffset + 4) !== 'PE\0\0') throw new Error('artifact has no PE signature')
  const coff = peOffset + 4
  const count = bytes.readUInt16LE(coff + 2)
  const table = coff + 20 + bytes.readUInt16LE(coff + 16)
  const sections: Section[] = []
  for (let index = 0; index < count; index += 1) {
    const at = table + index * 40
    sections.push({
      name: bytes.toString('latin1', at, at + 8).replace(/\0+$/, ''),
      rawSize: bytes.readUInt32LE(at + 16),
      rawOffset: bytes.readUInt32LE(at + 20),
    })
  }
  return sections
}

/**
 * Content size a zstd frame declares, and the offset just past its last block.
 *
 * The size field is not the size outright: RFC 8878 §3.1.1.1.4 reads the two-byte form as
 * `value + 256`, so a 1000-byte payload's frame declares 744 (measured on Bun 1.3.14, which writes
 * exactly that header). Callers match frames to addons by size, so the stored value alone would
 * miss every addon in the 256..65,791-byte range. The other field widths - 1, 4 and 8 bytes - are
 * the value verbatim.
 *
 * The block walk is what makes the frame slice exact: the block header is three little-endian
 * bytes carrying a last-block bit, a two-bit type, and a size that counts the payload except for
 * RLE blocks, which carry one byte regardless of their declared expansion.
 * `Bun.zstdDecompressSync` rejects a slice with trailing bytes, so the end cannot be estimated.
 *
 * Null covers every header the walk cannot trust: a frame without a declared size (optional when
 * the single-segment flag is clear), a header or block run past the buffer, and a four-byte magic
 * that merely occurs inside other data.
 */
export function zstdFrameBounds(bytes: Buffer, at: number): { contentSize: number; end: number } | null {
  if (at + 5 > bytes.length) return null
  const descriptor = bytes[at + 4] as number
  const contentSizeFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  const dictionarySize = [0, 1, 2, 4][descriptor & 3] as number
  const fieldSize = contentSizeFlag === 0 ? (singleSegment === 1 ? 1 : 0) : ([0, 2, 4, 8][contentSizeFlag] as number)
  const fieldAt = at + 5 + (singleSegment === 1 ? 0 : 1) + dictionarySize
  if (fieldSize === 0 || fieldAt + fieldSize > bytes.length) return null
  const stored = fieldSize === 8 ? Number(bytes.readBigUInt64LE(fieldAt)) : bytes.readUIntLE(fieldAt, fieldSize)
  const contentSize = fieldSize === 2 ? stored + 256 : stored

  let cursor = fieldAt + fieldSize
  for (;;) {
    if (cursor + 3 > bytes.length) return null
    const header = bytes.readUIntLE(cursor, 3)
    const last = header & 1
    const type = (header >> 1) & 3
    const size = header >>> 3
    cursor += 3 + (type === 1 ? 1 : size)
    if (cursor > bytes.length) return null
    if (last === 1) return { contentSize, end: cursor }
  }
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
 * Runs every check against one artifact and returns them all, so a report names both the drift and
 * whatever else is wrong with the same build.
 */
export function verifyHostProvenance(repoRoot = path.resolve(import.meta.dir, '..', '..')): ProvenanceReport {
  const artifact = path.join(repoRoot, 'host', 'dist', 'omp-host.exe')
  const manifestFile = path.join(repoRoot, 'host', 'dist', 'omp-host.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as {
    sdkVersion: string
    entry: string
    bytes: number
  }
  const sdkDir = resolvePackage(repoRoot, '@oh-my-pi/pi-coding-agent')
  const resolvedVersion = versionOf(sdkDir)
  const checks: ProvenanceCheck[] = []

  checks.push({
    name: 'sdk-version',
    ok: manifest.sdkVersion === resolvedVersion,
    detail:
      manifest.sdkVersion === resolvedVersion
        ? `manifest and checkout both name ${resolvedVersion}`
        : `manifest says ${manifest.sdkVersion}, checkout resolves ${resolvedVersion} - rebuild with \`pnpm host:install\``,
  })

  const bytes = fs.readFileSync(artifact)
  if (bytes.length !== manifest.bytes) {
    // The other two checks read the bundle, which a wrong-size artifact cannot be trusted to
    // contain; naming them here would report a failure for work that never ran.
    checks.push({
      name: 'artifact-size',
      ok: false,
      detail: `${bytes.length} B on disk, manifest says ${manifest.bytes} B - rebuild with \`pnpm host:install\``,
    })
    return { artifact, ok: false, checks }
  }

  const sections = sectionsOf(bytes)
  const bunSection = sections.find(entry => entry.name === '.bun')
  if (bunSection === undefined) {
    checks.push({ name: 'entry-module', ok: false, detail: 'the artifact has no .bun section' })
    checks.push({ name: 'embedded-addon', ok: false, detail: 'the artifact has no .bun section' })
    return { artifact, ok: false, checks }
  }
  const bundle = bytes.subarray(bunSection.rawOffset, bunSection.rawOffset + bunSection.rawSize)

  // The bundled module keeps the source path it was compiled from, so the entry names the file this
  // repository owns rather than a runtime-only identifier.
  const expectedEntry = `B:/~BUN/root/${manifest.entry.replace(/\.tsx?$/, '.js')}`
  const head = bundle.subarray(0, 4096).toString('latin1')
  const namesEntry = head.includes(expectedEntry)
  checks.push({
    name: 'entry-module',
    ok: namesEntry,
    detail: namesEntry
      ? `bundle starts at ${expectedEntry}`
      : `bundle does not name ${expectedEntry} in its first 4 KiB`,
  })

  const published = publishedAddons(resolvePackage(sdkDir, '@oh-my-pi/pi-natives'))
  const sizes = new Map(published.map(entry => [entry.bytes, entry]))
  let matched: { file: string; sha256: string } | null = null
  const found = new Set<number>()
  for (let at = bundle.indexOf(ZSTD_MAGIC); at !== -1; at = bundle.indexOf(ZSTD_MAGIC, at + 4)) {
    const bounds = zstdFrameBounds(bundle, at)
    if (bounds === null) continue
    found.add(bounds.contentSize)
    const candidate = sizes.get(bounds.contentSize)
    if (candidate === undefined || matched !== null) continue
    let content: Buffer
    try {
      content = Bun.zstdDecompressSync(bundle.subarray(at, bounds.end))
    } catch {
      // A four-byte match inside the JavaScript text is not a frame, and a damaged frame is not
      // readable at all; both leave this candidate unaccounted for instead of aborting the report.
      continue
    }
    if (createHash('sha256').update(content).digest('hex') === candidate.sha256) {
      matched = { file: candidate.file, sha256: candidate.sha256 }
    }
  }
  checks.push({
    name: 'embedded-addon',
    ok: matched !== null,
    detail:
      matched === null
        ? `no embedded frame matches ${published.map(entry => `${entry.file} (${entry.bytes} B)`).join(', ')}; ` +
          `frames declare ${[...found].join(', ') || 'none'} - rebuild with \`pnpm host:install\``
        : `frame expands to ${matched.file}, sha256 ${matched.sha256.slice(0, 16)}`,
  })

  return { artifact, ok: checks.every(check => check.ok), checks }
}

/**
 * Verifies the non-compiled artifact: the runtime plus plain files that `build.ts --bundle` writes.
 *
 * The question is the same one the compiled checks ask - are these bytes the build this checkout
 * describes - but the evidence differs: there is no single file whose digest covers everything, so
 * every listed file is checked, the addons must equal what the platform leaf publishes, and the
 * bundle must be the uncompiled shape rather than a stale compiled copy sitting in its place.
 *
 * Returns null when the directory is absent: a checkout that has only run the compiled build has
 * nothing to verify here, and inventing a failure would make the gate useless on that path.
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
        : `bundle says ${manifest.sdkVersion}, checkout resolves ${resolvedVersion} - rebuild with \`bun run host/build.ts --bundle\``,
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
