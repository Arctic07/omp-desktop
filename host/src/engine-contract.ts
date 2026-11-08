/**
 * The compile-time tripwire on the engine types this host reads by key (spec §15.1-3).
 *
 * The engine may add a key to a manifest, a field to an installed-plugin record or a member to a
 * union at any time. Every type below is mapped exhaustively, so a new key is a `typecheck` error
 * here instead of a fact this host quietly stops projecting.
 *
 * Upgrade policy (`rules.md#updates-and-upgrades`) - answer these for every new key:
 *
 * 1. Does the key introduce an executable entry point (an `extensions` / `tools` / `hooks` /
 *    `commands`-shaped value, or anything else the engine would load into this process)? Then it
 *    must be counted in the row's `code`/`consent` facts in `plugins-facts.ts` before it is
 *    `'entry-counted'` here; a code-entry key nobody gates on is the consent gate failing open.
 *    `'entry-ungated: …'` records an entry-point key the current facts do not gate on, with the
 *    reason - it is how an existing gap is documented, never how a new capability is added.
 * 2. Otherwise decide whether the key is read (`'read'`) or deliberately not (`'ignored: …'`), and
 *    say why. A key the desktop never renders belongs in `'ignored'`, not in a new row field.
 *
 * This file is `import type` only, which is what keeps it out of the runtime graph: the engine
 * module graph is loaded in exactly one place (`sdk.ts`'s `loadSdk()`), and `scripts/seam-check.ts`
 * fails the build if that stops being true.
 */

import type {
  InstalledPlugin,
  PluginFeature,
  PluginManifest,
  PluginSettingSchema,
} from '@oh-my-pi/pi-coding-agent/extensibility/plugins/types'
import type {
  InstalledPluginEntry,
  InstalledPluginSummary,
  MarketplacePluginEntry,
  MarketplaceRegistryEntry,
} from '@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace'

/**
 * What this host does with one engine key.
 *
 * `read` is projected into an answer; `entry-counted` is a code entry point the row's consent facts
 * count (the bare form when the reason is obvious, the suffixed one when what is counted needs
 * saying); `entry-ungated` is a code entry point no consent reason covers (a documented gap);
 * `ignored` is deliberately not read, with the reason.
 */
type EngineKeyUse =
  | 'read'
  | 'entry-counted'
  | `entry-counted: ${string}`
  | `entry-ungated: ${string}`
  | `ignored: ${string}`

/**
 * `PluginManifest` (`extensibility/plugins/types.ts`): one key per `omp`/`pi` block field.
 *
 * The three entry-point fields are the consent reasons `extension-modules` / `base-tools` /
 * `base-hooks`; `features` is included because the engine merges an enabled feature's entries into
 * the same load, so `plugins-facts.ts` walks it and counts what it declares.
 */
const MANIFEST_KEYS: Record<keyof PluginManifest, EngineKeyUse> = {
  name: 'read',
  version: 'read',
  description: 'read',
  tools: 'entry-counted',
  hooks: 'entry-counted',
  extensions: 'entry-counted',
  features: 'entry-counted',
  commands: `entry-ungated: 18.6.1 has no consumer for it (getAllPluginCommandPaths is exported but never called), so the row reports commandsDir as a code fact and gates on nothing; wiring it up must add a consent reason first`,
  settings: 'read',
}

/**
 * `PluginFeature` (`extensibility/plugins/types.ts`): one key per feature block field.
 *
 * `default` is read by the engine's own enable rule (`enabledFeatures === null` enables the truthy
 * ones), which `plugins-facts.ts::effectiveBlocks` follows.
 */
const FEATURE_KEYS: Record<keyof PluginFeature, EngineKeyUse> = {
  description: `ignored: display text the engine never loads; no row fact reads it`,
  default: 'read',
  extensions: 'entry-counted',
  tools: 'entry-counted',
  hooks: 'entry-counted',
  commands: `entry-ungated: same gap as PluginManifest.commands - 18.6.1 has no consumer for these files and no consent reason covers them`,
}

/**
 * `PluginSettingSchema`'s union: one member per `type` value the desktop's form can render.
 *
 * The schema object itself is passed through to the page as the engine parsed it
 * (`plugins-settings.ts`), so only the discriminant - which decides the control the page draws - is
 * enumerated here: a fifth type means the frontend needs a decision, and this is where the compile
 * stops until it has one.
 */
const SETTING_TYPES: Record<PluginSettingSchema['type'], EngineKeyUse> = {
  string: 'read',
  number: 'read',
  boolean: 'read',
  enum: 'read',
}

/**
 * `InstalledPlugin` (`extensibility/plugins/types.ts`): the npm/linked plugin record the engine's
 * `PluginManager.list()` answers with, one key per field.
 *
 * `manifest` is read, but not as the row's facts: `plugins-facts.ts` re-reads the package from disk
 * so a stale engine parse cannot decide what the row shows. `plugins-settings.ts` does read
 * `manifest.settings`, which is the engine's own schema for the values it validates.
 */
const INSTALLED_PLUGIN_KEYS: Record<keyof InstalledPlugin, EngineKeyUse> = {
  name: 'read',
  version: 'read',
  path: 'read',
  manifest: 'read',
  enabledFeatures: 'read',
  enabled: 'read',
}

/**
 * `InstalledPluginEntry` (`extensibility/plugins/marketplace/types.ts`): one install record, the
 * first of which is the active one.
 *
 * `enabled` is the engine's own reading of "on": a missing flag means on, which `marketRow`
 * follows.
 */
const MARKETPLACE_ENTRY_KEYS: Record<keyof InstalledPluginEntry, EngineKeyUse> = {
  scope: 'read',
  installPath: 'read',
  version: 'read',
  installedAt: 'read',
  lastUpdated: 'read',
  gitCommitSha: 'read',
  enabled: 'read',
}

/** `InstalledPluginSummary`: the merged user/project view the list walks, one key per field. */
const MARKETPLACE_SUMMARY_KEYS: Record<keyof InstalledPluginSummary, EngineKeyUse> = {
  id: 'read',
  scope: 'read',
  entries: 'read',
  shadowedBy: 'read',
}

/** `MarketplaceRegistryEntry`: one added catalog, one key per field. */
const MARKETPLACE_REGISTRY_KEYS: Record<keyof MarketplaceRegistryEntry, EngineKeyUse> = {
  name: 'read',
  sourceUri: 'read',
  sourceType: `ignored: the marketplaces list renders the name and source only`,
  catalogPath: `ignored: an engine-side cache detail the page does not show`,
  addedAt: `ignored: the marketplaces list carries no timestamps`,
  updatedAt: `ignored: the marketplaces list carries no timestamps`,
}

/**
 * `MarketplacePluginEntry`: one catalog row, one key per field.
 *
 * The listing fields are `read`: the plugin store renders the catalogue itself
 * (`plugins-market.ts::listMarketplacePlugins`, the `marketplace_plugins` frame), which is what a
 * user browses before installing anything. Rendering a catalogue row is not installing it, and the
 * consent story is unchanged by it: what a row *shows* is a name, a version, a category and a
 * description, while what runs is decided after an install, from the directory the engine
 * materialised - and the install itself runs this desktop's own consent chain
 * (`services/plugins/consent_flow.rs`). `keywords` is read as the tags' fallback.
 *
 * The entry-point-shaped fields keep their own answers for that reason: they are the path by which a
 * catalogue entry becomes code, and the gate stays the installed directory's probe
 * (`plugins-facts.ts`), never the catalog field.
 */
const MARKETPLACE_PLUGIN_KEYS: Record<keyof MarketplacePluginEntry, EngineKeyUse> = {
  name: 'read',
  source: 'read',
  description: 'read',
  version: 'read',
  author: 'read',
  homepage: 'read',
  repository: 'read',
  license: 'read',
  // Read as the tags' fallback: the store renders `tags`, and falls back to `keywords` when an
  // entry declares none (`plugins-market.ts::listMarketplacePlugins`).
  keywords: 'read',
  category: 'read',
  tags: 'read',
  strict: `ignored: the store does not render it; the engine applies it when it installs the entry`,
  commands: `entry-ungated: the engine materialises it into the cached plugin; the row gates on that directory, not on the catalog field`,
  agents: `entry-ungated: the engine materialises it into the cached plugin; the row gates on that directory, not on the catalog field`,
  hooks: `entry-ungated: the engine materialises it into the cached plugin; the row gates on that directory, not on the catalog field`,
  // These three are gated through what the row's probe reads. `lspServers` / `dapAdapters` are the
  // two the manager really materialises, as `.lsp.json` / `.dap.json` inside the cached plugin.
  // `mcpServers` is not materialised: the row reads the file names in
  // `constants.ts::PLUGIN_MCP_FILENAMES` (H1) plus the nested `plugin.json` field the engine
  // prefers over them. `plugins-facts.ts` probes all three, and each one is a consent reason
  // (`mcp-config` / `lsp-config` / `dap-config`).
  mcpServers: `entry-counted: the row's mcp probe reads constants.ts::PLUGIN_MCP_FILENAMES (H1) and the nested manifest field; the manager writes no .mcp.json`,
  lspServers: `entry-counted: the manager writes .lsp.json into the cached plugin; the row's lsp probe reads it`,
  dapAdapters: `entry-counted: the manager writes .dap.json into the cached plugin; the row's dap probe reads it`,
}
