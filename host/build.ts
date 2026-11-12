/**
 * Artifact driver: turns `host/src/**` plus the installed SDK into the host bundle the installer
 * ships - the vendor's `bun` runtime, one plain JavaScript bundle, and the native addons as files.
 *
 * The recipe is the SDK's own pipeline with the two constraints an installed package introduces:
 *   1. `buildDocsIndexPayload()` globs `<packageDir>/../../docs`, which an installed package only
 *      satisfies through a restored `docs/` directory.
 *   2. `createLegacyPiVirtualModulePlugin()` reads `<repoRoot>/packages/<name>/package.json` for
 *      the workspace packages, which an installed package never has.
 * Both are satisfied by materializing a build input tree under the gitignored `host/.build/tree`:
 * real directories where the pipeline needs real directories (junctions are resolved to their
 * target, which would move the derived paths out of the writable tree), and junctions where only
 * reads are needed.
 *
 * The compiled single-file executable is deliberately not produced; `bundle()` carries the measured
 * reason and the shipped shape.
 *
 * Usage: `bun run host/build.ts` (write `host/dist/bundle`) and `bun run host/build.ts --install`
 * (also place it where Tauri resolves resources).
 */

import * as fs from 'node:fs'
import { createHash } from 'node:crypto'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

import { HOST_VERSION, PROTOCOL_VERSION } from './src/constants.ts'
import { BUNDLE_DIRNAME, type BundleFile, type BundleManifest, PLATFORM_TAG, resolvePackage } from './scripts/packages.ts'

const hostDir = import.meta.dir
const repoRoot = path.resolve(hostDir, '..')
const buildDir = path.join(hostDir, '.build')
const treeDir = path.join(buildDir, 'tree')
const distDir = path.join(hostDir, 'dist')

/**
 * Target triple per build host.
 *
 * The triple is not a knob: the bundle is built for whatever Bun itself runs on, and the launcher
 * records it in the manifest so a check on another host cannot accept the wrong artifact. The
 * `win32-x64` entry is byte-for-byte the constant this file used to carry.
 */
const BUILD_HOST_TARGETS: Record<string, string> = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
}

/**
 * Target triple of the produced bundle, derived from the host this build runs on.
 *
 * An unlisted host is refused instead of guessed: a wrong triple does not fail the bundle build,
 * it fails much later as a launcher that cannot start the artifact.
 */
function targetTriple(): string {
  const host = `${process.platform}-${process.arch}`
  const triple: string | undefined = BUILD_HOST_TARGETS[host]
  if (triple === undefined) throw new Error(`Unsupported build host ${host}`)
  return triple
}

const TARGET = targetTriple()

/** Executable suffix of this host: Windows appends one, every other platform does not. */
const EXE_SUFFIX = process.platform === 'win32' ? '.exe' : ''

/** Bundle: the official runtime plus plain files, with no self-extracting PE. */
const BUNDLE_DIR = path.join(distDir, BUNDLE_DIRNAME)

/**
 * The workspace packages the legacy-Pi virtual module resolves through `<repoRoot>/packages`.
 *
 * The list mirrors the pipeline's own `BUNDLED_PACKAGES` (`scripts/legacy-pi-virtual-module.ts`),
 * which the pipeline does not export: it reads `packages/<dir>/package.json` for each entry, so a
 * package it names but this map does not link fails the build with ENOENT (the 18.6.1 SDK added
 * `catalog`). Re-check this map against that list on every SDK bump - it was last checked against
 * 18.10.3, whose list is still these seven.
 */
const BUNDLED_PACKAGES: Record<string, string> = {
  agent: '@oh-my-pi/pi-agent-core',
  ai: '@oh-my-pi/pi-ai',
  catalog: '@oh-my-pi/pi-catalog',
  'coding-agent': '@oh-my-pi/pi-coding-agent',
  natives: '@oh-my-pi/pi-natives',
  tui: '@oh-my-pi/pi-tui',
  utils: '@oh-my-pi/pi-utils',
}

/** Pipeline scripts copied into the input tree so their derived paths land inside it. */
const PIPELINE_SCRIPTS = ['legacy-pi-virtual-module.ts', 'generate-docs-index.ts']

/**
 * Runtime dependencies kept out of the JavaScript bundle and resolved by the engine's on-demand
 * install.
 *
 * Transcribed from the SDK pipeline's own `COMPILED_EXTERNAL_DEPENDENCIES`
 * (`packages/coding-agent/scripts/compile-binary.ts`). It used to be imported from that script, but
 * from SDK 18.10.x the script also imports `../../natives/scripts/embed-native`, a monorepo-only
 * module the published `@oh-my-pi/pi-natives` does not ship - so importing the script at all now
 * fails an installed-package build. The value is small and stable; re-check it against the script
 * on every SDK bump, exactly like `BUNDLED_PACKAGES` above.
 */
const EXTERNAL_DEPENDENCIES: readonly string[] = [
  '@huggingface/transformers',
  'fastembed',
  'onnxruntime-node',
]

/** Creates a directory junction, replacing whatever is already there. */
function linkDirectory(target: string, linkPath: string): void {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  fs.rmSync(linkPath, { recursive: true, force: true })
  fs.symlinkSync(target, linkPath, 'junction')
}

/** Copies a file, creating its directory first. */
function copyFile(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(source, destination)
}

/** Restores the `docs/` corpus the official pipeline globs from the package's own embed. */
function materializeDocs(embedFile: string, docsDir: string): { files: number; bytes: number } {
  const raw = fs.readFileSync(embedFile, 'utf8')
  const separator = raw.indexOf('\n')
  if (separator === -1) throw new Error(`Malformed docs embed at ${embedFile}`)
  const filenames = JSON.parse(raw.slice(0, separator)) as string[]
  const bodies = JSON.parse(gunzipSync(Buffer.from(raw.slice(separator + 1), 'base64')).toString('utf8')) as string[]
  if (filenames.length !== bodies.length) {
    throw new Error(`Docs embed mismatch: ${filenames.length} names vs ${bodies.length} bodies`)
  }
  fs.rmSync(docsDir, { recursive: true, force: true })
  let bytes = 0
  for (let index = 0; index < filenames.length; index += 1) {
    const target = path.join(docsDir, filenames[index] as string)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const body = bodies[index] as string
    fs.writeFileSync(target, body, 'utf8')
    bytes += Buffer.byteLength(body, 'utf8')
  }
  return { files: filenames.length, bytes }
}

/**
 * Materializes the build input tree and returns the paths the pipeline needs.
 *
 * Two directories must be real rather than junctions. `packages/coding-agent` has to be, because
 * the pipeline derives its repository root from its own `import.meta.dir` and a module loaded
 * through a junction reports the junction's target instead - which would point the docs and
 * packages lookups at the read-only pnpm store. The entrypoint's directory has to be, because a
 * module's imports resolve from where the module physically lives, and only a real path inside the
 * tree reaches the tree's own `node_modules`.
 */
function materializeTree(): { treeRoot: string; codingAgent: string; natives: string; entrypoint: string } {
  const installedCodingAgent = resolvePackage(repoRoot, '@oh-my-pi/pi-coding-agent')
  const natives = resolvePackage(installedCodingAgent, '@oh-my-pi/pi-natives')

  fs.mkdirSync(treeDir, { recursive: true })
  const docs = materializeDocs(path.join(installedCodingAgent, 'dist', 'docs-index.generated.txt'), path.join(treeDir, 'docs'))
  console.log(`[tree] docs restored: ${docs.files} files, ${docs.bytes} bytes`)

  for (const [dir, packageName] of Object.entries(BUNDLED_PACKAGES)) {
    linkDirectory(resolvePackage(installedCodingAgent, packageName), path.join(treeDir, 'packages', dir))
    linkDirectory(resolvePackage(installedCodingAgent, packageName), path.join(treeDir, 'node_modules', ...packageName.split('/')))
  }

  const codingAgent = path.join(treeDir, 'packages', 'coding-agent')
  const sourceScripts = path.join(installedCodingAgent, 'scripts')
  fs.rmSync(codingAgent, { recursive: true, force: true })
  fs.mkdirSync(path.join(codingAgent, 'scripts'), { recursive: true })
  copyFile(path.join(installedCodingAgent, 'package.json'), path.join(codingAgent, 'package.json'))
  linkDirectory(path.join(installedCodingAgent, 'src'), path.join(codingAgent, 'src'))
  for (const script of PIPELINE_SCRIPTS) {
    copyFile(path.join(sourceScripts, script), path.join(codingAgent, 'scripts', script))
  }

  const treeSource = path.join(treeDir, 'host', 'src')
  fs.rmSync(treeSource, { recursive: true, force: true })
  fs.cpSync(path.join(hostDir, 'src'), treeSource, { recursive: true })
  return { treeRoot: treeDir, codingAgent, natives, entrypoint: path.join(treeSource, 'main.ts') }
}

/** Filenames to ship for this build host, mirroring the loader's own `getAddonFilenames()`. */
function addonFilenames(): string[] {
  if (process.arch !== 'x64') return [`pi_natives.${PLATFORM_TAG}.node`]
  return [
    `pi_natives.${PLATFORM_TAG}-modern.node`,
    `pi_natives.${PLATFORM_TAG}-baseline.node`,
  ]
}

/** One published addon this build host ships, read and release-stamp-checked. */
interface AddonSource {
  readonly filename: string
  readonly bytes: Buffer
}

/**
 * The addons the platform leaf publishes for this host, with the release stamp verified once.
 *
 * The bundle ships the files as they are; checking here keeps "the addon is the published one" a
 * property of the input rather than of the writer.
 */
async function verifiedAddonSources(natives: string): Promise<AddonSource[]> {
  const pkg = JSON.parse(fs.readFileSync(path.join(natives, 'package.json'), 'utf8')) as unknown
  if (typeof pkg !== 'object' || pkg === null || !('version' in pkg) || typeof pkg.version !== 'string') {
    throw new Error(`${path.join(natives, 'package.json')} has no string version`)
  }
  const version = pkg.version
  const leaf = resolvePackage(natives, `@oh-my-pi/pi-natives-${PLATFORM_TAG}`)
  // Runtime-selected path: the sentinel lives in the installed package, whose location this build
  // only knows after resolution, so a static specifier cannot name it.
  const sentinel = (await import(pathToFileURL(path.join(natives, 'native', 'version-sentinel.js')).href)) as {
    containsVersionStamp(bytes: Uint8Array, version: string): boolean
  }

  const files: AddonSource[] = []
  for (const filename of addonFilenames()) {
    const source = path.join(leaf, filename)
    if (!fs.existsSync(source)) continue
    const bytes = fs.readFileSync(source)
    if (!sentinel.containsVersionStamp(bytes, version)) {
      throw new Error(`${filename} does not carry the @oh-my-pi/pi-natives@${version} release stamp`)
    }
    files.push({ filename, bytes })
  }
  if (files.length === 0) throw new Error(`No ${PLATFORM_TAG} addon to ship in ${leaf}`)
  return files
}

/** Size of the chunks the artifact hash is read in. */
const VERIFY_CHUNK_BYTES = 4 * 1024 * 1024

/** sha256 of one file, read in bounded chunks so a two hundred megabyte artifact never lands in one buffer. */
function sha256Of(file: string): string {
  const hash = createHash('sha256')
  const handle = fs.openSync(file, 'r')
  const chunk = Buffer.allocUnsafe(VERIFY_CHUNK_BYTES)
  try {
    for (;;) {
      const read = fs.readSync(handle, chunk, 0, chunk.length, null)
      if (read <= 0) break
      hash.update(chunk.subarray(0, read))
    }
  } finally {
    fs.closeSync(handle)
  }
  return hash.digest('hex')
}

/** Everything the artifact writer needs from the install tree, resolved once. */
interface BuildInputs {
  readonly treeRoot: string
  readonly buildEntrypoint: string
  readonly natives: string
  readonly sdkVersion: string
  readonly docsPayload: string
  readonly userAgent: string
  readonly legacy: { createLegacyPiVirtualModulePlugin: () => Promise<BunPlugin> }
}

/**
 * Materializes the input tree and loads the pipeline pieces the bundle is built from.
 *
 * The docs payload is embedded because it is how the host answers documentation requests without
 * the installed package's `docs/` directory on disk.
 */
async function prepareBuildInputs(): Promise<BuildInputs> {
  const { treeRoot, codingAgent, natives, entrypoint: buildEntrypoint } = materializeTree()

  const installedCodingAgent = resolvePackage(repoRoot, '@oh-my-pi/pi-coding-agent')
  const pkg = JSON.parse(fs.readFileSync(path.join(installedCodingAgent, 'package.json'), 'utf8')) as unknown
  if (typeof pkg !== 'object' || pkg === null || !('version' in pkg) || typeof pkg.version !== 'string') {
    throw new Error(`${installedCodingAgent}/package.json has no string version`)
  }
  const sdkVersion = pkg.version

  const scriptUrl = (name: string): string => pathToFileURL(path.join(codingAgent, 'scripts', name)).href
  // Dynamic imports are required: the pipeline scripts must be loaded THROUGH the input tree so
  // their `import.meta.dir` - and therefore the repository root they derive - stays inside
  // `host/.build`, which is the only writable place the docs and package layout may be built in.
  const legacy = (await import(scriptUrl('legacy-pi-virtual-module.ts'))) as {
    createLegacyPiVirtualModulePlugin: () => Promise<BunPlugin>
  }
  const docs = (await import(scriptUrl('generate-docs-index.ts'))) as {
    buildDocsIndexPayload: () => Promise<{ payload: string }>
  }
  const utils = (await import(pathToFileURL(path.join(resolvePackage(installedCodingAgent, '@oh-my-pi/pi-utils'), 'src', 'dirs.ts')).href)) as {
    USER_AGENT: string
  }

  const docsPayload = await docs.buildDocsIndexPayload()
  return {
    treeRoot,
    buildEntrypoint,
    natives,
    sdkVersion,
    docsPayload: docsPayload.payload,
    userAgent: utils.USER_AGENT,
    legacy,
  }
}

/** Size and digest of one bundled file. */
function describeFile(file: string): { bytes: number; sha256: string } {
  return { bytes: fs.statSync(file).size, sha256: sha256Of(file) }
}

/**
 * Writes the artifact: the official `bun` runtime, one plain JavaScript bundle, and the addons as
 * files.
 *
 * Why this layout exists: a compiled host is a new, unsigned 178 MB PE that decompresses a 117 MB
 * native module into the profile at startup and loads it - three traits antivirus heuristics score
 * highest, and the reason `ADV:Trojan/GenInjector` matched an artifact with no malicious code in it
 * (measured 2026-11-08). Here the only executable in the directory is the runtime the vendor ships
 * and signs, and nothing is self-extracted: `pi-natives` finds its addon next to the executable
 * (`loader-state.js`'s `execDir` candidate) and loads it in place.
 *
 * `PI_COMPILED` is deliberately not defined, so `sdk.ts`'s compiled-only worker handoff never arms
 * and the ordinary host path runs - the same path an installed `node_modules` tree takes.
 */
async function bundle(): Promise<void> {
  const started = Date.now()
  const inputs = await prepareBuildInputs()
  const addons = await verifiedAddonSources(inputs.natives)
  const runtimeName = `bun${EXE_SUFFIX}`
  if (!path.basename(process.execPath).toLowerCase().startsWith('bun')) {
    throw new Error(`the build runtime is ${process.execPath}; only a bun executable can be shipped as the runtime`)
  }

  fs.rmSync(BUNDLE_DIR, { recursive: true, force: true })
  fs.mkdirSync(BUNDLE_DIR, { recursive: true })

  const entry = 'host.js'
  const stagingDir = path.join(BUNDLE_DIR, '.emit')
  const outfile = path.join(BUNDLE_DIR, entry)
  const previousCwd = process.cwd()
  process.chdir(inputs.treeRoot)
  let output: BunBuildOutput
  try {
    output = await Bun.build({
      entrypoints: [inputs.buildEntrypoint],
      root: inputs.treeRoot,
      target: 'bun',
      external: [...EXTERNAL_DEPENDENCIES],
      define: {
        'process.env.PI_DOCS_EMBED': JSON.stringify(inputs.docsPayload),
      },
      minify: { identifiers: false, keepNames: true },
      // `createJsonParsePlugin` is not installed here: it rewrites every JSON over 256 KB into a
      // zstd file asset plus a path resolved against `import.meta.dir`, which is the layout a
      // compiled binary's `$bunfs` expects. A plain bundle keeps Bun's own JSON loader instead, so
      // the data is inlined and nothing is read from disk at startup.
      plugins: [await inputs.legacy.createLegacyPiVirtualModulePlugin()],
      outdir: stagingDir,
      throw: false,
    })
  } finally {
    process.chdir(previousCwd)
  }
  for (const log of output.logs) console.log(`[bundle] ${log.level} ${log.message.slice(0, 500)}`)
  if (!output.success) throw new Error(`bundle failed with ${output.logs.length} log entries`)

  // `Bun.build` names the JavaScript after the entry file and may emit assets beside it; the
  // launcher and the manifest agree on one entry name, so the JavaScript is moved to it and every
  // other emitted file keeps its name in the same directory, where its relative reference lands.
  const emitted = output.outputs ?? []
  const entryArtifact = emitted.find(artifact => artifact.path.endsWith('.js'))
  if (entryArtifact === undefined) throw new Error('the bundle build wrote no JavaScript artifact')
  const assets: string[] = []
  for (const artifact of emitted) {
    const destination = artifact === entryArtifact ? outfile : path.join(BUNDLE_DIR, path.basename(artifact.path))
    if (artifact !== entryArtifact) assets.push(path.basename(destination))
    fs.renameSync(artifact.path, destination)
  }
  fs.rmSync(stagingDir, { recursive: true, force: true })

  const runtimeTarget = path.join(BUNDLE_DIR, runtimeName)
  fs.copyFileSync(process.execPath, runtimeTarget)
  // The verified bytes, not the file they came from: `verifiedAddonSources` checked these bytes, and
  // re-reading the install tree would ship whatever the toolchain left there afterwards.
  for (const addon of addons) fs.writeFileSync(path.join(BUNDLE_DIR, addon.filename), addon.bytes)

  // The two runtime settings become command-line flags, so the launcher has one documented
  // invocation to reproduce from the manifest.
  const manifest: BundleManifest = {
    layout: 'bundle',
    hostVersion: HOST_VERSION,
    sdkVersion: inputs.sdkVersion,
    bunVersion: Bun.version,
    protocol: PROTOCOL_VERSION,
    target: TARGET,
    entry,
    argv: ['--no-env-file', `--user-agent=${inputs.userAgent}`, entry],
    files: [
      { file: entry, role: 'bundle', ...describeFile(outfile) },
      { file: runtimeName, role: 'runtime', ...describeFile(runtimeTarget) },
      ...assets.map(asset => ({ file: asset, role: 'asset' as const, ...describeFile(path.join(BUNDLE_DIR, asset)) })),
      ...addons.map(addon => ({
        file: addon.filename,
        role: 'addon' as const,
        ...describeFile(path.join(BUNDLE_DIR, addon.filename)),
      })),
    ],
    builtAt: new Date().toISOString(),
  }
  fs.writeFileSync(path.join(BUNDLE_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`, 'utf8')
  console.log(
    `[bundle] sdk=${inputs.sdkVersion} bun=${Bun.version} dir=${path.relative(repoRoot, BUNDLE_DIR)} ` +
      `files=${manifest.files.map(file => `${file.role}:${file.bytes}`).join(' ')} buildMs=${Date.now() - started}`,
  )
}

/**
 * Copies the bundle where Tauri resolves its resources.
 *
 * The manifest describes what was built, so the copy is checked against it file by file rather
 * than the manifest being re-derived from whatever landed.
 */
function installBundle(): void {
  const source = BUNDLE_DIR
  if (!fs.existsSync(path.join(source, 'manifest.json'))) throw new Error('Nothing to install: build the bundle first.')
  const target = path.join(repoRoot, 'src-tauri', 'binaries', BUNDLE_DIRNAME)
  // The compiled pair this repository shipped before the bundle is retired, not left beside it:
  // a stale copy is exactly what an upgrade used to start instead of the release's engine.
  for (const name of [`omp-host-${TARGET}${EXE_SUFFIX}`, 'omp-host.json']) {
    fs.rmSync(path.join(repoRoot, 'src-tauri', 'binaries', name), { force: true })
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8')) as BundleManifest
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
  for (const name of ['manifest.json', ...manifest.files.map(file => file.file)]) {
    fs.copyFileSync(path.join(source, name), path.join(target, name))
  }
  fs.writeFileSync(path.join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`, 'utf8')
  for (const file of manifest.files) {
    const copy = path.join(target, file.file)
    const installed = describeFile(copy)
    if (installed.bytes !== file.bytes || installed.sha256 !== file.sha256) {
      throw new Error(`${path.relative(repoRoot, copy)} does not match the manifest: ${installed.bytes} B / ${installed.sha256}`)
    }
  }
  console.log(`[install] ${path.relative(repoRoot, target)} files=${manifest.files.length} verified=sha256`)
}

// `--install` also places the bundle where Tauri resolves its resources, which is the layout
// `host_bin::locate_bundle` and `src-tauri/tauri.conf.json` expect. There is no second artifact:
// the installer ships this directory and nothing else.
await bundle()
if (process.argv.includes('--install')) installBundle()
