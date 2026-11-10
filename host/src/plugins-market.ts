/**
 * `marketplaces_list` / `marketplaces_add` / `marketplaces_remove` / `marketplaces_update` /
 * `marketplace_plugins`: the marketplace registry, the catalogue entries a registry holds, and the
 * manager pair every plugin frame shares.
 *
 * The engine owns every rule here: `MarketplaceManager` fetches a catalog, validates the name it
 * declares, writes the registry entry and drops its cache, so this module only bounds the request,
 * projects the fields the desktop renders, and wraps what the engine threw in the code the caller
 * branches on. A marketplace name is never invented host-side: `add` is handed a *source*, and every
 * answer is the registry read back.
 *
 * The catalogue entries (`marketplace_plugins`) are read out of the engine's own cached catalogues
 * and projected field by field: what a listing may carry is the engine's `MarketplacePluginEntry`,
 * and the store renders exactly those fields - nothing here invents a display name, an icon or a
 * category the catalogue did not declare (spec §3.4, R2 §1.6).
 */

import * as fs from 'node:fs/promises'

import type { BootServices } from './boot.ts'
import { requireText, resolveCwd } from './capabilities.ts'
import { PLUGIN_ID_MAX, PLUGIN_KEY_MAX, PLUGIN_SOURCE_MAX } from './constants.ts'
import type { HostPaths } from './env.ts'
import { logLine, sanitizeMessage } from './log.ts'
import { ERROR_CODES, HostError, invalidInput } from './protocol/errors.ts'
import type {
  MarketplaceManager,
  MarketplacePluginEntry,
  MarketplaceRegistryEntry,
  PluginManager,
  PluginSource,
  SdkBundle,
} from './sdk.ts'

/**
 * One install or marketplace source string, read the same way by both entry points (D10).
 *
 * `plugins_install` and `marketplaces_add` hand the string to the engine's own classifier and then
 * to a filesystem or network call, so the bound and the control-character refusal are one rule
 * rather than two that could drift apart. A control character is never part of a package name, a
 * path or a URL, and a newline in one is exactly the shape a request-smuggling attempt carries.
 *
 * A plaintext `http://` URL is refused unless its host is this machine. The engine's classifier
 * accepts `http://` for both the catalog fetch and a git clone, which would put a catalog (and
 * every package it names) on an unauthenticated wire; the desktop's own download path already
 * requires https, and one source string should not have two policies. Loopback stays open for a
 * local registry or a test catalog. `ssh://`, `git@…` and `owner/repo` are authenticated or
 * resolved by git itself and pass through untouched.
 */
export function pluginSourceField(value: unknown): string {
  const source = requireText(value, 'source', PLUGIN_SOURCE_MAX).trim()
  if (/\p{Cc}/u.test(source)) throw invalidInput('source must not contain control characters.')
  assertSourceScheme(source)
  return source
}

/**
 * Refuse a plaintext `http://` address unless it points at this machine.
 *
 * Two callers share it because both end in a network fetch by the engine: the string the reader
 * pasted, and the address a catalogue entry declares for its own package. Checking only the first
 * would leave a registered marketplace free to name `http://…` and have the engine clone it
 * unauthenticated. Loopback stays open for a local registry; `https`, `ssh`, `git@…`, `owner/repo`,
 * a local path and an npm spec are none of this function's business and pass untouched.
 */
export function assertSourceScheme(source: string): void {
  if (!/^http:\/\//i.test(source)) return
  let host = ''
  try {
    host = new URL(source).hostname.toLowerCase()
  } catch {
    // An unparsable URL is not a loopback one, so it takes the refusal below.
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return
  throw invalidInput('http:// sources are refused; use https:// (http is allowed only for this machine).')
}

/**
 * Where one plugin write points: a marketplace install handle, or a package name.
 *
 * T0 (plan §4.1) makes the row's identity the plugin's own id and demotes the engine's
 * `name@marketplace` to an install handle, so a caller passes `row.installId` for a marketplace row
 * and the package name for an npm or linked one. The shape is the whole classifier, and the
 * ambiguity the previous bare-name guess carried is exactly what T0 removes: a bare name is never
 * resolved to a marketplace install, because picking one of several markets would act on a plugin
 * the caller did not name.
 *
 * `@scope/pkg` is a package name, not a handle: the segment before its last `@` is empty, which is
 * the engine's own test (`parsePluginId` returns `null` for it). A handle that is not in the
 * engine's installed set is `plugin_not_found` rather than a silent npm attempt, so the page learns
 * its row is stale instead of receiving an uninstall that took nothing away.
 */
export type PluginTarget =
  | { readonly kind: 'marketplace'; readonly installId: string }
  | { readonly kind: 'npm'; readonly name: string }

/** One `targetId` as the engine command that will act on it: a marketplace handle or a package. */
export function pluginTargetField(value: unknown, installedIds: readonly string[]): PluginTarget {
  const target = requireText(value, 'targetId', PLUGIN_ID_MAX).trim()
  if (target.lastIndexOf('@') <= 0) return { kind: 'npm', name: target }
  if (!installedIds.includes(target)) {
    throw new HostError(ERROR_CODES.plugin_not_found, `No marketplace install is recorded as "${target}".`)
  }
  return { kind: 'marketplace', installId: target }
}

/** Both managers a plugin command needs, built for one working directory. */
export async function pluginManagers(
  sdk: SdkBundle,
  cwd: string,
): Promise<{ manager: PluginManager; market: MarketplaceManager }> {
  const manager = new sdk.PluginManager(cwd)
  const market = new sdk.MarketplaceManager({
    marketplacesRegistryPath: sdk.pluginPaths.marketplacesRegistry(),
    installedRegistryPath: sdk.pluginPaths.installedRegistry(),
    projectInstalledRegistryPath: await sdk.resolveOrDefaultProjectRegistryPath(cwd),
    marketplacesCacheDir: sdk.pluginPaths.marketplacesCache(),
    pluginsCacheDir: sdk.pluginPaths.pluginsCache(),
    // The engine's own cache invalidation: every write through this manager changes what the
    // plugin roots hold, and the discovery caches a session reads are the ones it drops.
    clearPluginRootsCache: sdk.clearPluginRootsAndCaches,
  })
  return { manager, market }
}

/**
 * Structured signals an engine failure may carry before its message is read (spec §15.1-5).
 *
 * Errno values that mean the environment could not run the work, rather than the work failing.
 *
 * `ENOENT` is the one the engine really reaches us with: `Bun.spawn(['bun', …])` throws its
 * `SystemError` - `code`, `path`, `syscall` - when an install's runtime is not there. It is mapped
 * to the environment answer even when the missing file was not the tool itself, because a raw
 * `ENOENT` reaching this function means the engine's own sentence ("package.json not found at …")
 * was not written, and refusing loudly beats reporting an environment fault as a broken plugin.
 */
const UNAVAILABLE_CODES: Record<string, true> = { ENOENT: true, ENOSYS: true, ENOTSUP: true }

/** Errno values that mean the symlink a link install needs was refused by the platform. */
const LINK_REFUSED_CODES: Record<string, true> = { EACCES: true, EPERM: true }

/**
 * Shell exit statuses that mean the tool could not be executed (126) or found (127).
 *
 * The Volta shim this machine's `bun` comes from exits 126 once the host's pinned `HOME` hides
 * `LocalAppData` (spec §14.1-1), so a status an engine error carries is as good a signal as a
 * sentence would be.
 */
const TOOL_ABSENT_STATUS: Record<string, true> = { '126': true, '127': true }

/** Errno values that mean the work ran and the network refused it - never "unavailable". */
const UNREACHABLE_CODES: Record<string, true> = {
  ENOTFOUND: true,
  EAI_AGAIN: true,
  ECONNREFUSED: true,
  ECONNRESET: true,
  ETIMEDOUT: true,
  EHOSTUNREACH: true,
  ENETUNREACH: true,
}

/**
 * Compatibility shims: the sentences a missing external tool is reported with when the error
 * carries no structured signal.
 *
 * These are not a classification rule of ours - they are the phrasings the platform shells and
 * npm/Volta shims really produce, matched only because the engine can wrap a spawn's stderr into a
 * plain `Error` and drop the errno with it. A shim that stops matching degrades the answer to
 * `plugin_install_failed` (a scene-level FAIL), never to a success.
 */
const TOOL_ABSENT_SHIM = /command not found|is not recognized as an internal or external command|executable file not found|Could not determine executable|not found in \$?PATH/i

/**
 * The tool a sentence names, or `null` when it names none.
 *
 * Only the tool's name is ever taken from a message: it is what the answer quotes back, and it is
 * the one thing that may be said about the environment without carrying a path out with it.
 */
const TOOL_NAME_PATTERNS: Record<string, RegExp> = {
  bun: /(?:^|[^a-z])bun(?:[^a-z]|$)/i,
  git: /(?:^|[^a-z])git(?:[^a-z]|$)/i,
  npm: /npx|(?:^|[^a-z])npm(?:[^a-z]|$)/i,
}

/** The structured `code`/`name`/`status` an error carries, as strings, before its message is read. */
function errorSignals(error: unknown): { code: string; name: string; status: string } {
  const record = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>
  const text = (value: unknown): string =>
    typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
  return {
    code: text(record.code).toUpperCase(),
    name: (error instanceof Error ? error.name : text(record.name)).toUpperCase(),
    status: text(record.status),
  }
}

/** The tool a sentence names, or `null` when it names none of the ones an install spawns. */
function namedTool(reason: string): string | null {
  for (const [tool, pattern] of Object.entries(TOOL_NAME_PATTERNS)) {
    if (pattern.test(reason)) return tool
  }
  return null
}

/**
 * The environment's own account of why the work never ran, or `null` when the error says nothing
 * about the environment (spec §15.1-6).
 */
function toolchainUnavailable(signals: { code: string; status: string }, reason: string): string | null {
  if (LINK_REFUSED_CODES[signals.code] === true) {
    return 'this machine refused the symbolic link a link install needs'
  }
  const tool = namedTool(reason)
  if (UNAVAILABLE_CODES[signals.code] === true) {
    return `${tool ?? 'a required external tool'} is not available on this machine`
  }
  if (TOOL_ABSENT_STATUS[signals.status] === true || TOOL_ABSENT_SHIM.test(reason)) {
    return `${tool ?? 'a required external tool'} could not be started on this machine`
  }
  return null
}

/**
 * The error a plugin command is answered with when the engine refused it.
 *
 * Classification is structured first (spec §15.1-5): an engine error may carry a `code`, a `name` or
 * a `status` (`ENOENT` from a spawn whose tool is missing, `EACCES`/`EPERM` from a symlink the
 * platform refused, `126` from a shim that could not start the tool), and a known one is mapped
 * directly. Only an error that carries no structured signal has its message read, and the patterns
 * there are a compatibility shim over sentences the engine really throws
 * (`extensibility/plugins/manager.ts`, `marketplace/manager.ts`, `plugins/installer.ts`): if the
 * upstream wording moves, the answer degrades to `plugin_install_failed` - a scene-level failure -
 * rather than being classified as something it is not.
 *
 * The four families a caller branches on: the request names something that is not there (a stale
 * row), the request itself is not usable (a name or spec the engine will not accept), the work was
 * fine but the environment could not run it (no `bun`/`git`, no symlink permission), and the work
 * ran and failed (an offline npm registry, a clone that failed, a catalog that would not parse).
 * Anything unmatched lands on the last one, the honest default for "accepted, then failed".
 *
 * This is a classification of engine *failures*, not a validation rule: what may be installed is
 * still decided by the engine alone.
 */
export function pluginEngineError(action: string, error: unknown): HostError {
  const reason = error instanceof Error ? error.message : String(error)
  const signals = errorSignals(error)
  const unavailable = toolchainUnavailable(signals, reason)
  if (unavailable !== null) {
    // The raw sentence stays in the host log (redacted at the sink); the wire answer names only the
    // tool, because a spawn error's text can carry absolute paths this host must not publish.
    logLine(`plugin work could not run during "${action}": ${reason}`)
    return new HostError(ERROR_CODES.plugin_install_unavailable, sanitizeMessage(`The ${action} could not run: ${unavailable}.`))
  }
  // The classification above reads the raw sentence; what travels on the wire does not. Both the
  // action and the engine's sentence can name the paths the work touched (`link "C:\…"`), and the
  // desktop's own redactor covers only drive-letter and UNC shapes - a POSIX path would arrive
  // whole. The raw pair is logged instead (redacted at the sink), so the detail is not lost.
  logLine(`plugin work failed during "${action}": ${reason}`)
  const message = sanitizeMessage(`The ${action} failed: ${reason}`)
  if (UNREACHABLE_CODES[signals.code] === true || UNREACHABLE_CODES[signals.name] === true) {
    return new HostError(ERROR_CODES.plugin_install_failed, message)
  }
  if (/installed in both user and project scope|is not installed in (?:user|project) scope/i.test(reason)) {
    return new HostError(ERROR_CODES.plugin_scope_mismatch, message)
  }
  // The addressed plugin or marketplace is not there - the engine's own wording, and the answer a
  // page showing a stale row needs. Deliberately narrow: "package.json not found at …" and
  // "Marketplace catalog not found at …" are failures of the work, not of the address.
  if (/(?:Plugin|Marketplace) "[^"]*" (?:not found|is not installed)|Plugin \S+ not found in runtime config/i.test(reason)) {
    return new HostError(ERROR_CODES.plugin_not_found, message)
  }
  // The request itself cannot be used: a package name, a plugin id, an install source or a local
  // directory the engine refuses to read as a package.
  if (
    /Invalid (?:package|plugin|marketplace)|Invalid characters in|^package\.json not found at|must have a name field|Unrecognized source format/i.test(
      reason,
    )
  ) {
    return new HostError(ERROR_CODES.plugin_invalid_spec, message)
  }
  return new HostError(ERROR_CODES.plugin_install_failed, message)
}

/**
 * The refusal a preflight answers with, before any engine work runs.
 *
 * The same code and sentence `pluginEngineError` produces for the spawn error itself, so the layer
 * that noticed is invisible to the caller - and one sentence means the page renders the same
 * "this machine cannot install plugins" either way.
 */
export function pluginToolchainRefusal(action: string, tool: string): HostError {
  return new HostError(ERROR_CODES.plugin_install_unavailable, `The ${action} could not run: ${tool} is not available on this machine.`)
}

/**
 * One registry row the desktop renders.
 *
 * `sourceType` stays host-side: it decides whether the source's path can be checked, and the page
 * never renders it. `available` is this host's fact: a remote source can be refreshed without the
 * filesystem, while a local directory that no longer exists can neither be refreshed nor browsed.
 */
async function marketplaceRow(entry: MarketplaceRegistryEntry): Promise<Record<string, unknown>> {
  let available = true
  if (entry.sourceType === 'local') {
    try {
      available = (await fs.stat(entry.sourceUri)).isDirectory()
    } catch {
      available = false
    }
  }
  return {
    name: entry.name,
    sourceUri: entry.sourceUri,
    available,
  }
}

/**
 * The registry as it stands now.
 *
 * Read back after every write, like the plugin list is: a marketplace is named by the catalog it
 * fetched, so the answer has to be the registry rather than an echo of the request.
 */
async function registryView(sdk: SdkBundle, cwd: string): Promise<Record<string, unknown>> {
  const { market } = await pluginManagers(sdk, cwd)
  const entries = await market.listMarketplaces()
  return { marketplaces: await Promise.all(entries.map(entry => marketplaceRow(entry))) }
}

/** `marketplaces_list`: every catalog the user has added. */
export async function listMarketplaces(
  paths: HostPaths,
  _services: BootServices,
  sdk: SdkBundle,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const cwd = resolveCwd(paths, frame.cwd)
  try {
    return await registryView(sdk, cwd)
  } catch (error) {
    if (error instanceof HostError) throw error
    throw pluginEngineError('be listed', error)
  }
}

/** `marketplaces_add`: fetch a catalog and register it under the name it declares. */
export async function addMarketplace(
  paths: HostPaths,
  _services: BootServices,
  sdk: SdkBundle,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const source = pluginSourceField(frame.source)
  const cwd = resolveCwd(paths, frame.cwd)
  const { market } = await pluginManagers(sdk, cwd)
  try {
    await market.addMarketplace(source)
  } catch (error) {
    throw pluginEngineError('add that source', error)
  }
  return await registryView(sdk, cwd)
}

/** `marketplaces_remove`: forget a catalog and drop the clone it was read from. */
export async function removeMarketplace(
  paths: HostPaths,
  _services: BootServices,
  sdk: SdkBundle,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const name = requireText(frame.name, 'name', PLUGIN_KEY_MAX)
  const cwd = resolveCwd(paths, frame.cwd)
  const { market } = await pluginManagers(sdk, cwd)
  try {
    await market.removeMarketplace(name)
  } catch (error) {
    throw pluginEngineError(`remove "${name}"`, error)
  }
  return await registryView(sdk, cwd)
}

/** `marketplaces_update`: refresh one catalog, or every one when the frame names none. */
export async function updateMarketplace(
  paths: HostPaths,
  _services: BootServices,
  sdk: SdkBundle,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Absent, `null` and `''` all mean "every marketplace": the engine has a call for each shape
  // (`updateMarketplace` for one, `updateAllMarketplaces` for the registry) and a frame that names
  // nobody has to land on the second one, or a page with one stale catalog could not be refreshed.
  const name = frame.name === undefined || frame.name === null ? '' : requireText(frame.name, 'name', PLUGIN_KEY_MAX)
  const cwd = resolveCwd(paths, frame.cwd)
  const { market } = await pluginManagers(sdk, cwd)
  try {
    if (name === '') {
      await market.updateAllMarketplaces()
    } else {
      await market.updateMarketplace(name)
    }
  } catch (error) {
    throw pluginEngineError(name === '' ? 'update any marketplace' : `update "${name}"`, error)
  }
  return await registryView(sdk, cwd)
}

/** One catalogue entry as the store renders it. */
export interface MarketplacePluginView {
  name: string
  marketplace: string
  description: string | null
  version: string | null
  author: string | null
  homepage: string | null
  repository: string | null
  license: string | null
  category: string | null
  tags: string[]
  /** The install source as one readable label (`github:owner/repo@ref`, `npm:pkg@1.0.0`, …). */
  source: string
}

/** How many entries one answer carries before it is truncated. */
const MARKETPLACE_PLUGINS_MAX = 512
/** Longest display text one entry's field carries; a longer value is clipped, never dropped. */
const MARKETPLACE_TEXT_MAX = 512
/** Longest tag, and how many tags one entry carries. */
const MARKETPLACE_TAG_MAX = 64
const MARKETPLACE_TAGS_MAX = 32

/** One catalogue string as the store renders it: one bounded line, or `null` when it says nothing. */
function listingText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  // A catalogue is remote input, so a control character never reaches a renderer: it becomes a space
  // rather than being dropped, so two halves of a value cannot be glued into a third.
  const line = value.replace(/\p{Cc}/gu, ' ').trim()
  if (line === '') return null
  return line.length <= max ? line : line.slice(0, max)
}

/** The `author` field as one line: the catalogue's own object carries a name and an email. */
function authorText(value: unknown): string | null {
  if (typeof value === 'string') return listingText(value, MARKETPLACE_TEXT_MAX)
  if (typeof value !== 'object' || value === null) return null
  const record = value as { name?: unknown; email?: unknown }
  return listingText(record.name, MARKETPLACE_TEXT_MAX) ?? listingText(record.email, MARKETPLACE_TEXT_MAX)
}

/**
 * One entry's tags: `tags` when the catalogue declares them, its `keywords` otherwise.
 *
 * Deduplicated, each one bounded and at most `MARKETPLACE_TAGS_MAX` of them, so a catalogue cannot
 * decide how much of the store's row is tags.
 */
function entryTags(entry: MarketplacePluginEntry): string[] {
  const raw = Array.isArray(entry.tags) ? entry.tags : Array.isArray(entry.keywords) ? entry.keywords : []
  const tags: string[] = []
  for (const value of raw) {
    const tag = listingText(value, MARKETPLACE_TAG_MAX)
    if (tag === null || tags.includes(tag)) continue
    tags.push(tag)
    if (tags.length === MARKETPLACE_TAGS_MAX) break
  }
  return tags
}

/** `base@ref`, or `base` when the catalogue declares no reference. */
function withRef(base: string, ref: unknown): string {
  const trimmed = typeof ref === 'string' ? ref.trim() : ''
  return trimmed === '' ? base : `${base}@${trimmed}`
}

/**
 * The install source of one entry as a stable label.
 *
 * A catalogue may spell `source` as a bare string (a relative path inside the marketplace) or as one
 * of the engine's four structured forms. The label is derived rather than passed through so the page
 * shows one shape whatever the catalogue wrote - and it is the engine's own fields that go into it,
 * never a display name this module would have to keep in step.
 */
function sourceLabel(source: PluginSource): string {
  if (typeof source === 'string') return listingText(source, MARKETPLACE_TEXT_MAX) ?? ''
  switch (source.source) {
    case 'github':
      return withRef(`github:${source.repo}`, source.ref)
    case 'url':
      return withRef(`url:${source.url}`, source.ref)
    case 'git-subdir':
      return withRef(`git-subdir:${source.url}/${source.path}`, source.ref)
    case 'npm':
      return withRef(`npm:${source.package}`, source.version)
  }
}

/** One catalogue entry, projected into the row the store renders. */
function marketplacePluginRow(
  entry: MarketplacePluginEntry,
  marketplace: string,
): MarketplacePluginView {
  return {
    name: listingText(entry.name, MARKETPLACE_TEXT_MAX) ?? '',
    marketplace,
    description: listingText(entry.description, MARKETPLACE_TEXT_MAX),
    version: listingText(entry.version, MARKETPLACE_TEXT_MAX),
    author: authorText(entry.author),
    homepage: listingText(entry.homepage, MARKETPLACE_TEXT_MAX),
    repository: listingText(entry.repository, MARKETPLACE_TEXT_MAX),
    license: listingText(entry.license, MARKETPLACE_TEXT_MAX),
    category: listingText(entry.category, MARKETPLACE_TEXT_MAX),
    tags: entryTags(entry),
    source: sourceLabel(entry.source),
  }
}

/**
 * `marketplace_plugins`: the catalogue entries the store lists - one marketplace's, or every
 * registered marketplace's.
 *
 * The entries come from the engine's own cached catalogues (`listAvailablePlugins`), which is what
 * the marketplace refresh writes: this frame never fetches, so opening the store costs a file read
 * per marketplace and nothing else. A named marketplace is asked for directly - the engine refuses a
 * name it does not hold with its own sentence, which `pluginEngineError` restates as
 * `plugin_not_found` - while every marketplace is read one by one, because a catalogue entry carries
 * no marketplace of its own and the row the store renders has to say where it came from.
 */
export async function listMarketplacePlugins(
  paths: HostPaths,
  _services: BootServices,
  sdk: SdkBundle,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Absent, `null` and `''` all mean "every marketplace", the same reading `marketplaces_update`
  // gives a frame that names nobody.
  const marketplace =
    frame.marketplace === undefined || frame.marketplace === null
      ? ''
      : requireText(frame.marketplace, 'marketplace', PLUGIN_KEY_MAX).trim()
  const cwd = resolveCwd(paths, frame.cwd)
  const { market } = await pluginManagers(sdk, cwd)
  try {
    const names =
      marketplace === '' ? (await market.listMarketplaces()).map(entry => entry.name) : [marketplace]
    const plugins: MarketplacePluginView[] = []
    let truncated = false
    for (const name of names) {
      for (const entry of await market.listAvailablePlugins(name)) {
        if (plugins.length === MARKETPLACE_PLUGINS_MAX) {
          truncated = true
          break
        }
        plugins.push(marketplacePluginRow(entry, name))
      }
      if (truncated) break
    }
    if (truncated) {
      logLine(`marketplace_plugins answer was truncated at ${MARKETPLACE_PLUGINS_MAX} entries`)
    }
    return { plugins }
  } catch (error) {
    if (error instanceof HostError) throw error
    throw pluginEngineError(
      marketplace === '' ? 'list the marketplace entries' : `list the entries of "${marketplace}"`,
      error,
    )
  }
}

/** One catalogue version of one plugin: what a registered marketplace declares (plan §4.2). */
export interface PluginCatalogVersion {
  readonly marketplace: string
  readonly version: string
}

/**
 * Every registered marketplace's catalogue, keyed by the plugin id a row uses (the catalogue entry's
 * name), as the row sources and the cross-market update scan read it.
 */
export type PluginCatalog = ReadonlyMap<string, readonly PluginCatalogVersion[]>

/**
 * The catalogue versions of every registered marketplace, for the row sources and the update scan.
 *
 * One read per marketplace, because a catalogue entry carries no marketplace of its own - the same
 * loop `marketplace_plugins` runs, for the same reason. A marketplace whose cached catalogue cannot
 * be read (its cache removed behind the registry's back, a file that no longer parses) is one
 * diagnostic line and no entries: the installed rows and the engine's own update answer stay
 * correct, and failing the whole list because one catalog file is gone would take the plugin page
 * down with it.
 *
 * An entry that declares no version is dropped, exactly as the engine's own update check skips one:
 * a source the page can show needs a version, and a versionless entry is not a candidate to upgrade
 * to.
 */
export async function readPluginCatalog(market: MarketplaceManager): Promise<PluginCatalog> {
  const catalog = new Map<string, PluginCatalogVersion[]>()
  for (const registered of await market.listMarketplaces()) {
    let entries: readonly MarketplacePluginEntry[]
    try {
      entries = await market.listAvailablePlugins(registered.name)
    } catch (error) {
      logLine(
        `marketplace catalogue "${registered.name}" could not be read: ${error instanceof Error ? error.message : String(error)}`,
      )
      continue
    }
    for (const entry of entries) {
      if (entry.name === '' || typeof entry.version !== 'string' || entry.version === '') continue
      const found = { marketplace: registered.name, version: entry.version }
      const versions = catalog.get(entry.name)
      if (versions === undefined) catalog.set(entry.name, [found])
      else versions.push(found)
    }
  }
  return catalog
}
