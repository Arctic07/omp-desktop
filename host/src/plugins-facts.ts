/**
 * The facts one plugin row carries: what its package declares, and the code it would run.
 *
 * These rows are the engine's own plugin system, projected. They come from `PluginManager.list()`
 * (npm and linked plugins) and `MarketplaceManager.listInstalledPlugins()` (marketplace
 * installs). What this module adds is the part the desktop needs and the engine does not model: the
 * facts a settings page has to show (what code the plugin would run, what its manifest declares,
 * what its settings schema holds) and the consent answer a caller can branch on when the engine
 * refuses.
 *
 * The facts are read, never judged (contract §1): a row reports that a manifest lists extension
 * modules, that it configures an MCP server or that it ships a `hooks/` directory, and the page
 * turns exactly those into the warning that gates enabling it. One fact is deliberately not read as
 * "nothing to see": a manifest the host could not read, or whose block is not an object, fails
 * closed as `manifest-unreadable` - the engine may still load code this host cannot enumerate, so
 * the row asks for confirmation instead of reporting no code at all (spec §15.1-4). The entry
 * points counted here are the ones the engine would really load - the manifest's own plus those of
 * the features it enables - so a plugin whose whole code lives in `omp.features.<name>` is not
 * reported as carrying none. The `omp.desktop` block read in the same pass is projected by
 * `plugins-desktop.ts`, and the manifest/tree primitives come from `plugins-manifest.ts`.
 *
 * The commands that write (install, uninstall, set_enabled, upgrade, reload) and the list they
 * answer with live in `plugins.ts`, which reads these rows back after every write. A row's identity
 * - the plugin's own id, the install handle and the marketplaces the same plugin is listed in - is
 * `plugins-rows.ts`' projection (plan §4.1): this module reads one install record's facts, and that
 * one merges the records into the rows the page keys by plugin id.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { PLUGIN_DAP_FILENAMES, PLUGIN_LSP_FILENAMES, PLUGIN_MCP_FILENAMES } from './constants.ts'
import { logLine } from './log.ts'
import { desktopOf } from './plugins-desktop.ts'
import type { DesktopView } from './plugins-desktop.ts'
import { isRecord, manifestBlockUnreadable, manifestOf, manifestText, pathIsDirectory, pathIsFile, readPackageJson, readPluginIdentity, realRoot } from './plugins-manifest.ts'
import { pluginManagers, readPluginCatalog } from './plugins-market.ts'
import { mergeCandidates, pluginIdOf } from './plugins-rows.ts'
import type { CodeFacts, PluginCandidate, PluginFeatureView, PluginIdParser, PluginRow } from './plugins-rows.ts'
import type {
  InstalledPlugin,
  InstalledPluginEntry,
  InstalledPluginSummary,
  PluginManager,
  PluginSettingSchema,
  SdkBundle,
} from './sdk.ts'

/** Everything a plugin's own package.json and tree say about it. */
export interface PluginFacts {
  readonly displayName: string | null
  readonly description: string | null
  readonly version: string | null
  readonly settings: Record<string, PluginSettingSchema>
  /** `omp.features` with the engine's own resolution for this installation. */
  readonly features: PluginFeatureView[]
  readonly consent: { readonly required: boolean; readonly reasons: string[] }
  readonly code: CodeFacts
  readonly desktop: DesktopView | null
  /**
   * Why the manifest yielded no desktop block, when it did not: an unreadable or unparsable
   * `package.json`, or an `omp.desktop` block that failed a rule. `null` is the ordinary case of a
   * manifest that parsed and declares no desktop part (an engine-only plugin), so the page can tell
   * the two apart (spec §3.3).
   */
  readonly desktopError: string | null
}

/**
 * One entry-point field of a manifest block, read the way the engine reads it.
 *
 * `extensions` / `tools` / `hooks` / `commands` are the fields the engine resolves into files, and
 * for those it accepts a single string as well as a list (`resolvePluginManifestEntries` wraps a
 * non-array value before resolving it). A list member that is not a usable string is dropped rather
 * than guessed at, exactly as `manifestList` drops one: the engine cannot turn such a member into a
 * file either, so dropping it never hides an entry point it would have loaded.
 */
function manifestEntries(source: Record<string, unknown>, key: string): string[] {
  const value = source[key]
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return typeof value === 'string' && value.length > 0 ? [value] : []
}

/**
 * The manifest blocks a plugin's *effective* entry points come from: the top-level fields plus the
 * features the engine enables.
 *
 * The engine's rule is the only one that counts (`extensibility/plugins/loader.ts`,
 * `resolvePluginManifestEntries`): `null` - what an ordinary install leaves in the lock file -
 * enables the features whose `default` is truthy, an array enables exactly the names it lists, and
 * an empty array enables none. A feature the engine would not enable must not contribute an entry
 * point here, or the gate would ask for code that never loads; and a feature the engine *would*
 * enable must, or a plugin whose only code lives in a feature would be waved through. `default` is
 * tested for truthiness rather than against `true`, because that is the engine's own check.
 */
function effectiveBlocks(
  manifest: Record<string, unknown>,
  enabledFeatures: string[] | null,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [manifest]
  if (!isRecord(manifest.features)) return blocks
  for (const [name, feature] of Object.entries(manifest.features)) {
    if (!isRecord(feature)) continue
    const enabled = enabledFeatures === null ? Boolean(feature.default) : enabledFeatures.includes(name)
    if (enabled) blocks.push(feature)
  }
  return blocks
}

/**
 * The manifest's `features` block as the page renders it.
 *
 * `enabledFeatures` is the engine's resolution (null = the features whose `default` is truthy), so
 * this function never decides a default of its own: it reports what the engine would load.
 */
function featureFacts(manifest: Record<string, unknown>, enabledFeatures: string[] | null): PluginFeatureView[] {
  if (!isRecord(manifest.features)) return []
  const features: PluginFeatureView[] = []
  for (const [name, value] of Object.entries(manifest.features)) {
    if (!isRecord(value)) continue
    features.push({
      name,
      description: manifestText(value, 'description'),
      default: Boolean(value.default),
      enabled: enabledFeatures === null ? Boolean(value.default) : enabledFeatures.includes(name),
    })
  }
  return features
}

/**
 * Whether the plugin declares MCP servers in a plugin manifest, the way the engine reads them.
 *
 * `.omp-plugin/plugin.json` takes precedence over `.claude-plugin/plugin.json`, and the field may
 * be an inline object or a path to a config file (spec §3.1). The check is deliberately coarse -
 * "the field is present and usable" - because that is the fact the gate needs; what the servers are
 * is the engine's business.
 */
function declaresMcpServers(root: string): boolean {
  for (const file of ['.omp-plugin/plugin.json', '.claude-plugin/plugin.json']) {
    const manifestPath = path.join(root, ...file.split('/'))
    if (!pathIsFile(manifestPath)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch {
      // A manifest that cannot be parsed is not a declaration this side can read; the file's own
      // presence is still a fact, and an unreadable plugin.json is reported through the reasons
      // below rather than guessed at.
      continue
    }
    if (!isRecord(parsed) || !('mcpServers' in parsed)) continue
    const servers = parsed.mcpServers
    if (isRecord(servers) && Object.keys(servers).length > 0) return true
    if (typeof servers === 'string' && servers.trim() !== '') return true
  }
  return false
}

/**
 * What a plugin's directory declares and ships, for the features the engine enables.
 *
 * The consent reasons are facts, never a judgement (contract §1): "this manifest lists extension
 * modules" is what the page turns into a warning, and a plugin that ships none of these is one the
 * desktop can enable without asking. The directory flags at the end are the same kind of fact for
 * the surfaces the spec adds later - `skills/`, `commands/`, `agents/`, `rules/`, `prompts/` - and
 * only the reasons the contract names are consent reasons, because only those run code. The two
 * prompt surfaces are still reported: a rule can change the system prompt, and "this plugin injects
 * prompt text" is exactly the fact a reader of the detail page needs (spec §4.1.1).
 *
 * Two of those reasons are about content the *engine* adds rather than the package: MCP servers a
 * plugin manifest declares (`plugin.json#mcpServers`, which the engine prefers over `.mcp.json`),
 * and the LSP/DAP configuration a marketplace entry carries, which the manager materialises as
 * `.lsp.json` / `.dap.json` inside the installed plugin. Both end in processes the engine spawns,
 * so a plugin shipping either is a plugin that runs code - and a probe that missed them would wave
 * exactly those through the gate (spec §9.2-5).
 *
 * `extensions`, `tools` and `hooks` are read from every block the engine would load, not from the
 * top level alone: a plugin may declare all of its entry points inside `omp.features.<name>`
 * (the engine merges the enabled features' entries into the same load), so reading the top level
 * only would report such a plugin as carrying no code at all. `enabledFeatures` is the manager's
 * own resolution for this plugin - `null` meaning "the engine's defaults" - and a plugin whose
 * features cannot be resolved is passed in as `null` too, so the row over-asks rather than waving
 * a plugin through.
 *
 * The desktop block adds two of its own, because its code is the code this application itself
 * runs: `process-main` for a resident `omp.desktop.main` process and `renderer-module` for a slot
 * module (`omp.desktop.renderer`) that runs in the application document. Both are read off the
 * block this host re-validated, so a block it refused declares no code it would run. The token
 * vocabulary is therefore bounded to this list - `extension-modules`, `base-tools`, `base-hooks`,
 * `hooks-dir`, `tools-dir`, `mcp-config`, `lsp-config`, `dap-config`, `process-main`,
 * `renderer-module` - plus the fail-closed `manifest-unreadable`.
 *
 * Exported for the facts' own tests: one root in, one row's facts out, with no engine loaded.
 */
export function pluginFacts(root: string, enabledFeatures: string[] | null): PluginFacts {
  const manifestRead = readPackageJson(root)
  const pkg = manifestRead.pkg
  const manifest = manifestOf(pkg)
  // The engine reads name/version/description from the plugin-manifest documents too; a probe
  // that stopped at `package.json` reported a Claude-format or Agent Plugins package as an
  // unreadable manifest and asked consent for code it could enumerate.
  const identity = readPluginIdentity(root, pkg, manifest)
  const blocks = effectiveBlocks(manifest, enabledFeatures)
  const extensions = blocks.reduce((total, block) => total + manifestEntries(block, 'extensions').length, 0)
  const baseTools = blocks.some(block => manifestEntries(block, 'tools').length > 0)
  const baseHooks = blocks.some(block => manifestEntries(block, 'hooks').length > 0)
  // The engine accepts either spelling of each config file (`constants.ts` carries the sets and
  // their provenance); probing only the dotted one would report a plugin that ships `mcp.json`,
  // `lsp.yaml` or `dap.json` as carrying no code and wave it through the gate.
  const anyFile = (names: readonly string[]): boolean => names.some(name => pathIsFile(path.join(root, name)))
  const code = {
    extensions,
    baseTools,
    baseHooks,
    hooksDir: pathIsDirectory(path.join(root, 'hooks')),
    toolsDir: pathIsDirectory(path.join(root, 'tools')),
    // Either source the engine resolves: any of the conventional files, or the manifest field that
    // takes precedence over them.
    mcpConfig: anyFile(PLUGIN_MCP_FILENAMES) || declaresMcpServers(root),
    lspConfig: anyFile(PLUGIN_LSP_FILENAMES),
    dapConfig: anyFile(PLUGIN_DAP_FILENAMES),
    skillsDir: pathIsDirectory(path.join(root, 'skills')),
    commandsDir: pathIsDirectory(path.join(root, 'commands')),
    agentsDir: pathIsDirectory(path.join(root, 'agents')),
    // Prompt surfaces are facts like the rest, and they are deliberately not consent reasons: the
    // gate is about code that runs, and a markdown file does not (spec §6.1). They still belong on
    // the detail page, because a rule that lands in the system prompt changes what the agent does
    // and nothing else in this application would say so.
    rulesDir: pathIsDirectory(path.join(root, 'rules')),
    promptsDir: pathIsDirectory(path.join(root, 'prompts')),
  }
  const reasons: string[] = []
  if (code.extensions > 0) reasons.push('extension-modules')
  if (code.baseTools) reasons.push('base-tools')
  if (code.baseHooks) reasons.push('base-hooks')
  if (code.hooksDir) reasons.push('hooks-dir')
  if (code.toolsDir) reasons.push('tools-dir')
  if (code.mcpConfig) reasons.push('mcp-config')
  if (code.lspConfig) reasons.push('lsp-config')
  if (code.dapConfig) reasons.push('dap-config')
  // The desktop block is read before the gate is answered: a `main` is a resident process this
  // application spawns and a `renderer` is a module that runs in the application document, so both
  // are code that runs - the same kind of fact as an extension module, and without them a
  // third-party process plugin could never be confirmed at all (plan §5.4/§6.1/§7.1).
  const desktop = desktopOf(manifest, root)
  if (desktop.desktop !== null && desktop.desktop.process !== null) reasons.push('process-main')
  if (desktop.desktop !== null && desktop.desktop.renderer !== null) reasons.push('renderer-module')
  // Fail closed (spec §15.1-4): a `package.json` that could not be read, was not a JSON object, or
  // carries an `omp`/`pi` block that is not an object is a manifest the *engine* may still load
  // from - its own rule is `omp || pi` and it never requires an object. A plugin-manifest document
  // is the engine's other manifest, so a readable one means the package is not unreadable as a
  // whole: its directories are probed below, and a package manifest that failed is reported on the
  // page rather than turned into a consent demand for code nobody could enumerate.
  const unreadablePackage = manifestRead.error !== null && !identity.hasPluginJson
  const manifestUnreadable = unreadablePackage || (pkg !== null && manifestBlockUnreadable(pkg))
  const consent = manifestUnreadable
    ? { required: true, reasons: ['manifest-unreadable'] }
    : { required: reasons.length > 0, reasons }
  // A missing `package.json` is ordinary for the other manifest formats; a present one that does
  // not parse is a real failure the page should still state, even when a plugin.json carried the
  // identity fields.
  const packageError =
    manifestRead.error === null || (!manifestRead.exists && identity.hasPluginJson) ? null : manifestRead.error
  const settings = isRecord(manifest.settings) ? (manifest.settings as Record<string, PluginSettingSchema>) : {}

  return {
    displayName: identity.name,
    description: identity.description,
    version: identity.version,
    settings,
    features: featureFacts(manifest, enabledFeatures),
    consent,
    code,
    desktop: desktop.desktop,
    desktopError: desktop.error ?? packageError,
  }
}

/** The settings summary a list row carries: the keys a form can render, and whether one is secret. */
function settingsSummary(facts: PluginFacts): { readonly keys: string[]; readonly hasSecret: boolean } {
  const keys = Object.keys(facts.settings)
  return { keys, hasSecret: keys.some(key => facts.settings[key]?.secret === true) }
}

/** True when the plugin directory the manager reported is a link to somewhere else on disk. */
function isLink(pluginPath: string, real: string): boolean {
  try {
    if (fs.lstatSync(pluginPath).isSymbolicLink()) return true
  } catch {
    // A path that cannot be inspected is reported as it was found: the row still lists.
  }
  // The engine's second signal: a package that resolves outside the plugins directory was linked
  // there rather than installed into it.
  const inside = `${path.sep}node_modules${path.sep}`
  return !real.includes(inside) && !pluginPath.includes(inside)
}

/**
 * One npm or linked plugin as a candidate.
 *
 * Its package name is already the plugin's own id, and the engine gives it no install handle, so
 * there is nothing to parse: `installId` is `null` and the source carries no marketplace (plan
 * §4.1). Both facts are what tell a caller this row can never switch source.
 */
function npmCandidate(plugin: InstalledPlugin): PluginCandidate {
  const root = realRoot(plugin.path)
  // The engine already resolved this plugin's enabled features from the same lock file and project
  // overrides (`PluginManager.list`), so the row reads its answer instead of asking a second time.
  const facts = pluginFacts(root, plugin.enabledFeatures ?? null)
  const linked = isLink(plugin.path, root)
  return {
    pluginId: plugin.name,
    installId: null,
    name: facts.displayName ?? plugin.name,
    description: facts.description,
    version: facts.version ?? plugin.version,
    scope: 'user',
    enabled: plugin.enabled,
    shadowedBy: null,
    // A link row shows where the plugin really is, i.e. the development directory its author chose
    // (`root` is that path, resolved): spec §3.4 makes the source visible in dev mode, and the
    // package name is already the row's id. An npm install keeps its name, which is all it has.
    // `installed: true` because a candidate is an installed record by definition (plan §4.1).
    source: { kind: linked ? 'link' : 'npm', label: linked ? root : plugin.name, gitCommitSha: null, marketplace: null, installId: null, installed: true },
    installedAt: null,
    lastUpdated: null,
    rootPath: root,
    consent: facts.consent,
    code: facts.code,
    settings: settingsSummary(facts),
    features: facts.features,
    desktop: facts.desktop,
    desktopError: facts.desktopError,
  }
}

/**
 * The features the engine enables for one marketplace plugin, resolved the way the engine resolves
 * the plugin itself.
 *
 * A marketplace install is recorded under `<name>@<marketplace>` while its runtime state - the
 * enabled features among it - is keyed by the package name inside its install path, so the id's own
 * name is looked up first and the record's install path second; the second lookup takes the package
 * name from the package itself, which is how `plugins-settings.ts` reaches a marketplace plugin's
 * settings too.
 *
 * A plugin neither lookup finds - a record whose cache holds no usable `package.json`, a lookup the
 * engine refuses - is reported as `null`, the engine's "use the defaults" state. That is the
 * fail-closed reading: the row asks for confirmation for the features a fresh install enables
 * rather than being waved through on a manifest nobody could read.
 */
async function marketFeatures(
  sdk: SdkBundle,
  manager: PluginManager,
  id: string,
  installPath: string,
): Promise<string[] | null> {
  const parsed = sdk.parsePluginId(id)
  const wanted = parsed === null ? id : parsed.name
  try {
    const direct = await manager.getPlugin(wanted)
    if (direct !== undefined) return direct.enabledFeatures ?? null
    const resolved = await manager.getPlugin(wanted, { path: installPath })
    return resolved?.enabledFeatures ?? null
  } catch (error) {
    logLine(`plugin features could not be resolved for "${id}": ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/**
 * One marketplace install as a candidate.
 *
 * The entry is the engine's record (`marketplace/types.ts`): the first one is the active install,
 * which is also the one `enabled` and the version are read from. `entries[0].enabled === false` is
 * the only "off" - a missing flag means enabled, which is the engine's own reading. Any further
 * entry of the same summary is another record of the same handle, which the engine itself reads as
 * `entries[0]` everywhere, so it adds nothing a source could show.
 *
 * The plugin's own id comes from the handle's name segment (plan §4.1): `demo@market-a` is the
 * plugin `demo`, installed from `market-a`. A handle the engine's parser rejects keeps the whole
 * string as its id, which is the only name the record has.
 */
async function marketCandidate(
  parse: PluginIdParser,
  sdk: SdkBundle,
  manager: PluginManager,
  summary: InstalledPluginSummary,
  entry: InstalledPluginEntry,
): Promise<PluginCandidate> {
  const root = realRoot(entry.installPath)
  const facts = pluginFacts(root, await marketFeatures(sdk, manager, summary.id, entry.installPath))
  const pluginId = pluginIdOf(parse, summary.id)
  return {
    pluginId,
    installId: summary.id,
    name: facts.displayName ?? pluginId,
    description: facts.description,
    version: facts.version ?? entry.version,
    scope: summary.scope,
    enabled: entry.enabled !== false,
    shadowedBy: summary.shadowedBy ?? null,
    source: {
      kind: 'marketplace',
      label: summary.id,
      gitCommitSha: entry.gitCommitSha ?? null,
      marketplace: parse(summary.id)?.marketplace ?? null,
      installId: summary.id,
      installed: true,
    },
    installedAt: entry.installedAt ?? null,
    lastUpdated: entry.lastUpdated ?? null,
    rootPath: root,
    consent: facts.consent,
    code: facts.code,
    settings: settingsSummary(facts),
    features: facts.features,
    desktop: facts.desktop,
    desktopError: facts.desktopError,
  }
}

/**
 * Every installed plugin, in the order the page renders it.
 *
 * The two registries are the engine's split, not this host's: a marketplace install is recorded in
 * `installed_plugins.json` with a cache path, while everything else is a dependency of the plugins
 * directory. `PluginManager.list()` deliberately omits the marketplace runtime links, so the two
 * sources do not overlap. The catalogues are read in the same pass because a row carries where else
 * the plugin is listed (plan §4.1), and merging is `plugins-rows.ts`' job, including its sort.
 */
export async function pluginRows(sdk: SdkBundle, cwd: string): Promise<PluginRow[]> {
  const { manager, market } = await pluginManagers(sdk, cwd)
  const [npm, installed, catalog] = await Promise.all([
    manager.list(),
    market.listInstalledPlugins(),
    readPluginCatalog(market),
  ])
  const candidates: PluginCandidate[] = npm.map(plugin => npmCandidate(plugin))
  for (const summary of installed) {
    const entry = summary.entries[0]
    if (entry === undefined) continue
    candidates.push(await marketCandidate(sdk.parsePluginId, sdk, manager, summary, entry))
  }
  return mergeCandidates(candidates, catalog)
}

