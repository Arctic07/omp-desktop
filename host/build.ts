/**
 * Compile driver: turns `host/src/**` plus the installed SDK into one standalone executable.
 *
 * The recipe is the SDK's own release pipeline with one change (see OPERATOR NOTES below), and it
 * is transplanted rather than re-invented: `scripts/compile-binary.ts` hardcodes `bytecode: true`,
 * which panics Bun 1.3.14 on win32-x64 for this module graph, so the identical option set is
 * rebuilt here with bytecode dropped.
 *
 * OPERATOR NOTES - the four constraints the pipeline needs and an installed package does not have:
 *   1. `bytecode` must stay off (Bun 1.3.14 win32-x64 panic in the bundler).
 *   2. The native addon has to be embedded by a build plugin; patching the file inside
 *      `node_modules` does not survive, the toolchain restores the published copy mid-build.
 *   3. `buildDocsIndexPayload()` globs `<packageDir>/../../docs`, which an installed package only
 *      satisfies through a restored `docs/` directory.
 *   4. `createLegacyPiVirtualModulePlugin()` reads `<repoRoot>/packages/<name>/package.json` for
 *      six workspace packages, which an installed package never has.
 *
 * Constraints 3 and 4 are satisfied by materializing a build input tree under the gitignored
 * `host/.build/tree`: real directories where the pipeline needs real directories (junctions are
 * resolved to their target, which would move the derived paths out of the writable tree), and
 * junctions where only reads are needed.
 *
 * Usage: `bun run host/build.ts` (compile), `bun run host/build.ts --install` (also place the
 * artifacts where Tauri expects them), `bun run host/build.ts --install-only` (place what is
 * already built, verifying the existing dist artifacts against their manifest),
 * `bun run host/build.ts --bundle` (write the non-compiled artifact: runtime + JavaScript + addons;
 * add `--install` to place it where Tauri resolves its resources).
 */

import * as fs from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
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
const entrypoint = path.join(hostDir, 'src', 'main.ts')
const require_ = createRequire(import.meta.url)

/**
 * Target triple per build host.
 *
 * The triple is not a knob: the compile below targets whatever Bun itself runs on, and
 * `host_bin::target_triple()` in the launcher resolves the same triple from its own compile target
 * to decide which file under `src-tauri/binaries` it looks for. Writing the mapping down per host
 * keeps the two in step; the `win32-x64` entry is byte-for-byte the constant this file used to
 * carry, so the Windows artifact keeps the name it has always had.
 */
const BUILD_HOST_TARGETS: Record<string, string> = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
}

/**
 * Target triple of the produced executable, derived from the host this build runs on.
 *
 * An unlisted host is refused instead of guessed: a wrong triple does not fail the compile, it
 * fails much later as a launcher that cannot find the artifact built beside it.
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

/** The compiled artifact's name inside `host/dist`, and the name the messages below quote. */
const DIST_ARTIFACT = `omp-host${EXE_SUFFIX}`
/** Non-compiled artifact: the official runtime plus plain files, with no self-extracting PE. */
const BUNDLE_DIR = path.join(distDir, BUNDLE_DIRNAME)
/** Placeholder served in place of `native/embedded-addon.js`; injected by a build plugin. */
const EMBEDDED_ADDON_FILENAME = 'embedded-addon.js'

/**
 * The workspace packages the legacy-Pi virtual module resolves through `<repoRoot>/packages`.
 *
 * The list mirrors the pipeline's own `BUNDLED_PACKAGES` (`scripts/legacy-pi-virtual-module.ts`),
 * which the pipeline does not export: it reads `packages/<dir>/package.json` for each entry, so a
 * package it names but this map does not link fails the compile with ENOENT (the 18.6.1 SDK added
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
const PIPELINE_SCRIPTS = ['legacy-pi-virtual-module.ts', 'json-parse-plugin.ts', 'generate-docs-index.ts']

/**
 * Runtime dependencies kept out of the compiled binary and resolved from the on-demand install.
 *
 * Transcribed from the pipeline's own `COMPILED_EXTERNAL_DEPENDENCIES`
 * (`packages/coding-agent/scripts/compile-binary.ts`). It used to be imported from that script, but
 * from SDK 18.10.x the script also imports `../../natives/scripts/embed-native`, a monorepo-only
 * module the published `@oh-my-pi/pi-natives` does not ship - so importing the script at all now
 * fails an installed-package build. The value is small and stable; re-check it against the script
 * on every SDK bump, exactly like `BUNDLED_PACKAGES` above.
 */
const COMPILED_EXTERNAL_DEPENDENCIES: readonly string[] = ['fastembed', 'onnxruntime-node']

/** The build manifest the launcher verifies (contract §1.2). */
interface HostManifest {
  readonly sdkVersion: string
  readonly bunVersion: string
  readonly protocol: number
  readonly target: string
  readonly bytes: number
  readonly sha256: string
  readonly builtAt: string
  readonly entry: string
}

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

/** Concrete Transformers.js version baked into the tiny-model worker, as the pipeline derives it. */
function transformersVersion(installedCodingAgent: string): string {
  const manifest = createRequire(path.join(installedCodingAgent, 'package.json'))('@huggingface/transformers/package.json') as {
    version?: unknown
  }
  if (typeof manifest.version !== 'string') throw new Error('@huggingface/transformers manifest has no string version')
  return manifest.version
}

/** One addon the compiled binary carries, in the shape the `pi-natives` loader reads. */
interface EmbeddedAddonFile {
  readonly variant: 'modern' | 'baseline' | 'default'
  readonly filename: string
  /** Decompressed `.node` size: the loader rejects a frame that does not expand to it. */
  readonly size: number
  /** The zstd frame holding those bytes, written under `host/.build`. */
  readonly framePath: string
}

/** Addon bytes the embedding plugin reports from inside the binary. */
interface EmbeddedAddon {
  readonly version: string
  readonly files: readonly EmbeddedAddonFile[]
  readonly addonBytes: number
  readonly frameBytes: number
}

/** Filenames to embed for this build host, mirroring the loader's own `getAddonFilenames()`. */
function embeddedAddonCandidates(): { variant: EmbeddedAddonFile['variant']; filename: string }[] {
  if (process.arch !== 'x64') return [{ variant: 'default', filename: `pi_natives.${PLATFORM_TAG}.node` }]
  return [
    { variant: 'modern', filename: `pi_natives.${PLATFORM_TAG}-modern.node` },
    { variant: 'baseline', filename: `pi_natives.${PLATFORM_TAG}-baseline.node` },
  ]
}

/** One published addon this build host ships, read and release-stamp-checked. */
interface AddonSource {
  readonly variant: EmbeddedAddonFile['variant']
  readonly filename: string
  readonly source: string
  readonly bytes: Buffer
}

/**
 * The addons the platform leaf publishes for this host, with the release stamp verified once.
 *
 * Both artifacts use them: the compiled build compresses these bytes into zstd frames, and the
 * bundle ships the files as they are. Checking here keeps "the addon is the published one" a
 * property of the input rather than of each writer.
 */
async function verifiedAddonSources(natives: string): Promise<{ version: string; files: AddonSource[] }> {
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
  for (const candidate of embeddedAddonCandidates()) {
    const source = path.join(leaf, candidate.filename)
    if (!fs.existsSync(source)) continue
    const bytes = fs.readFileSync(source)
    if (!sentinel.containsVersionStamp(bytes, version)) {
      throw new Error(`${candidate.filename} does not carry the @oh-my-pi/pi-natives@${version} release stamp`)
    }
    files.push({ variant: candidate.variant, filename: candidate.filename, source, bytes })
  }
  if (files.length === 0) throw new Error(`No ${PLATFORM_TAG} addon to ship in ${leaf}`)
  return { version, files }
}

/**
 * Compresses the addon into the zstd frames the SDK's native loader extracts from a compiled
 * binary.
 *
 * The manifest shape is the loader's, not ours: `native/loader-state.js` reads `files[].zstdPath`
 * and expands it with `Bun.zstdDecompressSync`, so any other shape - the tar.gz archive 18.6.x
 * parsed, for one - leaves the addon unextractable and the host dead before its first frame. The
 * release stamp is checked by `verifiedAddonSources` rather than left to the running application
 * for the same reason.
 *
 * Frames are written under `host/.build`, never into `node_modules`: the toolchain restores
 * published files inside the install tree mid-build, so that copy is not dependable input.
 */
async function generateEmbeddedAddon(natives: string): Promise<EmbeddedAddon> {
  const { version, files: sources } = await verifiedAddonSources(natives)
  const files = sources.map<EmbeddedAddonFile>(({ variant, filename, bytes }) => {
    const framePath = path.join(buildDir, `${filename}.zst`)
    fs.writeFileSync(framePath, Bun.zstdCompressSync(bytes))
    return { variant, filename, size: bytes.length, framePath }
  })
  return {
    version,
    files,
    addonBytes: files.reduce((total, file) => total + file.size, 0),
    frameBytes: files.reduce((total, file) => total + fs.statSync(file.framePath).size, 0),
  }
}

/**
 * Serves `native/embedded-addon.js` from memory with the manifest the loader expects, so the binary
 * carries the addon without any file inside the install tree being written to.
 *
 * The module is remapped to a path inside the build tree first: each frame is embedded through a
 * relative `with { type: "file" }` import, which has to resolve next to the module, and the install
 * tree is not writable.
 */
function createEmbeddedAddonPlugin(natives: string, addon: EmbeddedAddon): BunPlugin {
  const embeddedAddonJs = path.join(natives, 'native', EMBEDDED_ADDON_FILENAME).replaceAll('\\', '/')
  const virtualModule = path.join(treeDir, 'embedded-addon.js').replaceAll('\\', '/')
  const imports: string[] = []
  const entries: string[] = []
  addon.files.forEach((file, index) => {
    fs.copyFileSync(file.framePath, path.join(treeDir, `${file.filename}.zst`))
    imports.push(`import frame${index} from "./${file.filename}.zst" with { type: "file" };`)
    entries.push(
      `    { variant: ${JSON.stringify(file.variant)}, filename: ${JSON.stringify(file.filename)}, ` +
        `size: ${file.size}, zstdPath: frame${index} },`,
    )
  })
  const source = `// AUTOGENERATED by host/build.ts - mirrors packages/natives/scripts/embed-native.ts
${imports.join('\n')}

export const embeddedAddon = {
  platformTag: ${JSON.stringify(PLATFORM_TAG)},
  version: ${JSON.stringify(addon.version)},
  files: [
${entries.join('\n')}
  ],
};
`
  const normalized = (value: string): string => value.replaceAll('\\', '/')
  return {
    name: 'omp-host:embedded-addon',
    setup(build): void {
      // The loader imports the module relatively, so the specifier - not a resolved path - is what
      // arrives here; the importer keeps the rewrite scoped to the natives package.
      build.onResolve({ filter: /embedded-addon\.js$/ }, args => {
        if (args.path !== './embedded-addon.js' && normalized(args.path) !== embeddedAddonJs) return undefined
        if (!normalized(args.importer).includes('/pi-natives/native/')) return undefined
        return { path: virtualModule }
      })
      build.onLoad({ filter: /embedded-addon\.js$/ }, args =>
        normalized(args.path) === virtualModule ? { contents: source, loader: 'js' } : undefined,
      )
    },
  }
}

/** Size of the chunks the artifact hash and byte comparison are read in. */
const VERIFY_CHUNK_BYTES = 4 * 1024 * 1024

/** sha256 of one file, read in bounded chunks so a 170 MB artifact never lands in one buffer. */
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

/** Byte-for-byte comparison of two files, chunked for the same reason. */
function sameBytes(left: string, right: string): boolean {
  if (fs.statSync(left).size !== fs.statSync(right).size) return false
  const leftHandle = fs.openSync(left, 'r')
  const rightHandle = fs.openSync(right, 'r')
  const leftChunk = Buffer.allocUnsafe(VERIFY_CHUNK_BYTES)
  const rightChunk = Buffer.allocUnsafe(VERIFY_CHUNK_BYTES)
  try {
    for (;;) {
      const leftRead = fs.readSync(leftHandle, leftChunk, 0, leftChunk.length, null)
      const rightRead = fs.readSync(rightHandle, rightChunk, 0, rightChunk.length, null)
      if (leftRead !== rightRead) return false
      if (leftRead <= 0) return true
      if (!leftChunk.subarray(0, leftRead).equals(rightChunk.subarray(0, rightRead))) return false
    }
  } finally {
    fs.closeSync(leftHandle)
    fs.closeSync(rightHandle)
  }
}

/** Renders the manifest for one artifact. */
function manifestFor(file: string, sdkVersion: string): HostManifest {
  return {
    sdkVersion,
    bunVersion: Bun.version,
    protocol: PROTOCOL_VERSION,
    target: TARGET,
    bytes: fs.statSync(file).size,
    sha256: sha256Of(file),
    builtAt: new Date().toISOString(),
    entry: path.relative(repoRoot, entrypoint).split(path.sep).join('/'),
  }
}

/**
 * Resolves the legacy virtual module's `@oh-my-pi/*` imports against the build input tree.
 *
 * `createLegacyPiVirtualModulePlugin()` emits lazy imports for every bundled package subpath, and
 * those specifiers are resolved from a module that exists only in memory - so they never reach the
 * install layout the rest of the graph uses. Every other importer keeps default resolution (the
 * installed pnpm tree), which is what the bundled SDK sources need.
 */
function createDependencyRootPlugin(treeRoot: string): BunPlugin {
  return {
    name: 'omp-host:legacy-dependency-root',
    setup(build): void {
      build.onLoad({ filter: /.*/, namespace: 'omp-legacy-pi-modules-build' }, () => undefined)
      build.onResolve({ filter: /^@oh-my-pi\// }, args => {
        if (!args.importer.includes('omp-legacy-pi-modules')) return undefined
        // Bun's resolver requires forward slashes in a plugin-resolved path; a Windows path
        // panics the bundler instead of failing the build.
        return { path: Bun.resolveSync(args.path, treeRoot).replaceAll('\\', '/') }
      })
    },
  }
}

/** The fields a compiled executable publishes about itself in its Windows `VERSIONINFO` and icon. */
interface WindowsIdentity {
  readonly title: string
  readonly publisher: string
  readonly version: string
  readonly description: string
  readonly copyright: string
  readonly icon: string
}

/**
 * Identity the artifact carries, read from the desktop's own config.
 *
 * `bun build --compile` copies Bun's identity into every executable it produces: without these
 * fields the host reports `CompanyName` "Oven", `FileDescription` "Bun" and `InternalName` "bun".
 * An unsigned single-file runtime that calls itself another company's `bun.exe` while it writes a
 * native addon into the profile and spawns shells is the shape malware heuristics score highest -
 * measured 2026-11-03, when Kaspersky Free quarantined this artifact as
 * `PDM:Trojan.Win32.Bazon.a` during a session. Name, publisher, version and icon are what a
 * reputation lookup, a vendor allowlist entry and a false-positive report all key on.
 *
 * `src-tauri/tauri.conf.json` is the one home for that identity: `bundle.publisher` and
 * `bundle.copyright` are also what the desktop executable's `VERSIONINFO` reports.
 */
function windowsIdentity(): WindowsIdentity {
  const configFile = 'src-tauri/tauri.conf.json'
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, configFile), 'utf8')) as {
    productName?: string
    version?: string
    bundle?: { publisher?: string; copyright?: string }
  }
  const productName = requiredConfigValue(configFile, 'productName', config.productName)
  const version = requiredConfigValue(configFile, 'version', config.version)
  const publisher = requiredConfigValue(configFile, 'bundle.publisher', config.bundle?.publisher)
  const copyright = requiredConfigValue(configFile, 'bundle.copyright', config.bundle?.copyright)
  const icon = path.join(repoRoot, 'src-tauri', 'icons', 'icon.ico')
  if (!fs.existsSync(icon)) throw new Error(`the executable icon is missing at ${path.relative(repoRoot, icon)}`)
  return {
    title: `${productName} Host`,
    publisher,
    version: fourPartVersion(configFile, version),
    description: `${productName} host process`,
    copyright,
    icon,
  }
}

/** One config value the identity cannot be built without. */
function requiredConfigValue(file: string, key: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`${file} is missing ${key}: the compiled host has no identity to publish without it`)
  }
  return value
}

/** `0.1.0` → `0.1.0.0`: a Windows version resource holds exactly four numeric fields. */
function fourPartVersion(file: string, version: string): string {
  const parts = version.split('.')
  if (parts.length < 3 || parts.length > 4 || parts.some(part => !/^\d+$/.test(part))) {
    throw new Error(`${file} version "${version}" is not the dotted numeric form a Windows version resource takes`)
  }
  return [...parts, ...Array<string>(4 - parts.length).fill('0')].join('.')
}

/** Everything the two artifact writers need from the install tree, resolved once. */
interface BuildInputs {
  readonly treeRoot: string
  readonly buildEntrypoint: string
  readonly natives: string
  readonly sdkVersion: string
  readonly transformers: string
  readonly docsPayload: string
  readonly userAgent: string
  readonly legacy: { createLegacyPiVirtualModulePlugin: () => Promise<BunPlugin> }
  readonly jsonParse: { createJsonParsePlugin: () => BunPlugin }
}

/**
 * Materializes the input tree and loads the pipeline pieces both artifacts are built from.
 *
 * The compiled build embeds the docs payload and the platform identity; the bundle keeps the docs
 * payload too, because it is how the host answers documentation requests without the installed
 * package's `docs/` directory on disk.
 */
async function prepareBuildInputs(): Promise<BuildInputs> {
  const { treeRoot, codingAgent, natives, entrypoint: buildEntrypoint } = materializeTree()

  const installedCodingAgent = resolvePackage(repoRoot, '@oh-my-pi/pi-coding-agent')
  const pkg = JSON.parse(fs.readFileSync(path.join(installedCodingAgent, 'package.json'), 'utf8')) as unknown
  if (typeof pkg !== 'object' || pkg === null || !('version' in pkg) || typeof pkg.version !== 'string') {
    throw new Error(`${installedCodingAgent}/package.json has no string version`)
  }
  const sdkVersion = pkg.version
  const transformers = transformersVersion(installedCodingAgent)

  const scriptUrl = (name: string): string => pathToFileURL(path.join(codingAgent, 'scripts', name)).href
  // Dynamic imports are required: the pipeline scripts must be loaded THROUGH the input tree so
  // their `import.meta.dir` - and therefore the repository root they derive - stays inside
  // `host/.build`, which is the only writable place the docs and package layout may be built in.
  const legacy = (await import(scriptUrl('legacy-pi-virtual-module.ts'))) as {
    createLegacyPiVirtualModulePlugin: () => Promise<BunPlugin>
  }
  const jsonParse = (await import(scriptUrl('json-parse-plugin.ts'))) as {
    createJsonParsePlugin: () => BunPlugin
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
    transformers,
    docsPayload: docsPayload.payload,
    userAgent: utils.USER_AGENT,
    legacy,
    jsonParse,
  }
}

async function compile(): Promise<void> {
  const started = Date.now()
  const inputs = await prepareBuildInputs()

  const addon = await generateEmbeddedAddon(inputs.natives)
  const embedded = addon.files.map(file => `${file.variant}:${file.size}`).join(' ')
  console.log(
    `[addon] version=${addon.version} addonBytes=${addon.addonBytes} frameBytes=${addon.frameBytes} files=[${embedded}]`,
  )

  fs.mkdirSync(distDir, { recursive: true })
  const outfile = path.join(distDir, DIST_ARTIFACT)
  // The legacy virtual module exists only in memory, so its bare imports have no file to resolve
  // against and fall back to the process working directory. Building from the input tree is what
  // puts the tree's `node_modules` on that path.
  const previousCwd = process.cwd()
  process.chdir(inputs.treeRoot)
  let output: BunBuildOutput
  try {
    output = await Bun.build({
      entrypoints: [inputs.buildEntrypoint],
      root: inputs.treeRoot,
      external: [...COMPILED_EXTERNAL_DEPENDENCIES],
      define: {
        'process.env.PI_COMPILED': JSON.stringify('true'),
        'process.env.PI_TINY_TRANSFORMERS_VERSION': JSON.stringify(inputs.transformers),
        'process.env.PI_DOCS_EMBED': JSON.stringify(inputs.docsPayload),
      },
      // Constraint 1: bytecode panics this Bun version for this module graph.
      bytecode: false,
      minify: { identifiers: false, keepNames: true },
      plugins: [
        createEmbeddedAddonPlugin(inputs.natives, addon),
        inputs.jsonParse.createJsonParsePlugin(),
        await inputs.legacy.createLegacyPiVirtualModulePlugin(),
      ],
      compile: {
        execArgv: [`--user-agent=${inputs.userAgent}`],
        outfile,
        autoloadBunfig: false,
        autoloadDotenv: false,
        autoloadTsconfig: false,
        autoloadPackageJson: false,
        // Windows-only in Bun's bundler; other targets ignore the block.
        windows: windowsIdentity(),
      },
      throw: false,
    })
  } finally {
    process.chdir(previousCwd)
  }
  for (const log of output.logs) console.log(`[build] ${log.level} ${log.message.slice(0, 500)}`)
  if (!output.success) throw new Error(`bundle failed with ${output.logs.length} log entries`)

  const manifest = manifestFor(outfile, inputs.sdkVersion)
  fs.writeFileSync(path.join(distDir, 'omp-host.json'), `${JSON.stringify(manifest)}\n`, 'utf8')
  console.log(
    `[build] hostVersion=${HOST_VERSION} sdk=${inputs.sdkVersion} transformers=${inputs.transformers} bun=${Bun.version} ` +
      `outfile=${path.relative(repoRoot, outfile)} bytes=${manifest.bytes} sha256=${manifest.sha256} buildMs=${Date.now() - started}`,
  )
}

/** Size and digest of one bundled file. */
function describeFile(file: string): { bytes: number; sha256: string } {
  return { bytes: fs.statSync(file).size, sha256: sha256Of(file) }
}

/**
 * Writes the non-compiled artifact: the official `bun` runtime, one plain JavaScript bundle, and
 * the addons as files.
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
      external: [...COMPILED_EXTERNAL_DEPENDENCIES],
      define: {
        'process.env.PI_TINY_TRANSFORMERS_VERSION': JSON.stringify(inputs.transformers),
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
  for (const addon of addons.files) fs.writeFileSync(path.join(BUNDLE_DIR, addon.filename), addon.bytes)

  // The same two runtime settings the compiled build bakes in (`execArgv`, `autoloadDotenv: false`)
  // become command-line flags here, so the launcher has one documented invocation to reproduce.
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
      ...addons.files.map(addon => ({
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
 * Same rule as the compiled install: the manifest describes what was built, so the copy is checked
 * against it file by file rather than the manifest being re-derived from whatever landed.
 */
function installBundle(): void {
  const source = BUNDLE_DIR
  if (!fs.existsSync(path.join(source, 'manifest.json'))) throw new Error('Nothing to install: build the bundle first.')
  const target = path.join(repoRoot, 'src-tauri', 'binaries', BUNDLE_DIRNAME)
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

/**
 * Copies the built artifacts where Tauri resolves its `externalBin` entry.
 *
 * The manifest describes the dist artifact, so both files are checked against it here rather than
 * the manifest being re-derived from whatever landed: a copy that came out short, or a manifest
 * left over from an earlier build, fails the install instead of being published under a hash it
 * does not have. The comparison is byte-exact (`cmp`) plus a fresh sha256 of the installed file.
 */
function install(): void {
  const binariesDir = path.join(repoRoot, 'src-tauri', 'binaries')
  const source = path.join(distDir, DIST_ARTIFACT)
  if (!fs.existsSync(source)) throw new Error('Nothing to install: build first.')
  const manifest = JSON.parse(fs.readFileSync(path.join(distDir, 'omp-host.json'), 'utf8')) as HostManifest
  const distBytes = fs.statSync(source).size
  const distSha256 = sha256Of(source)
  if (distBytes !== manifest.bytes || distSha256 !== manifest.sha256) {
    throw new Error(
      `host/dist/${DIST_ARTIFACT} does not match omp-host.json: ${distBytes} B / ${distSha256}, manifest says ${manifest.bytes} B / ${manifest.sha256}`,
    )
  }

  fs.mkdirSync(binariesDir, { recursive: true })
  const target = path.join(binariesDir, `omp-host-${TARGET}${EXE_SUFFIX}`)
  fs.copyFileSync(source, target)
  const label = path.relative(repoRoot, target)
  if (!sameBytes(source, target)) throw new Error(`${label} is not a byte-for-byte copy of host/dist/${DIST_ARTIFACT}.`)
  const installedBytes = fs.statSync(target).size
  const installedSha256 = sha256Of(target)
  if (installedBytes !== manifest.bytes || installedSha256 !== manifest.sha256) {
    throw new Error(`${label} does not match the manifest: ${installedBytes} B / ${installedSha256}`)
  }
  fs.writeFileSync(path.join(binariesDir, 'omp-host.json'), `${JSON.stringify(manifest)}\n`, 'utf8')
  console.log(`[install] ${label} bytes=${installedBytes} sha256=${installedSha256} verified=cmp+sha256`)
}

// `--install` also places the artifacts where Tauri resolves them. `--install-only` runs just that
// step against what is already in `host/dist`, which is what makes the verification above testable
// against a manifest and an artifact that disagree - a rebuild would simply overwrite both.
// `--bundle` writes the non-compiled artifact instead (runtime + JavaScript + addons); with
// `--install` it also places that directory where Tauri resolves its resources, which is the layout
// `host_bin::locate_candidate` and `src-tauri/tauri.bundle.conf.json` expect.
const installOnly = process.argv.includes('--install-only')
if (process.argv.includes('--bundle')) {
  await bundle()
  if (process.argv.includes('--install')) installBundle()
} else {
  if (!installOnly) await compile()
  if (installOnly || process.argv.includes('--install')) install()
}
