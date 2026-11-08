/**
 * Row identity and the source projection: a plugin row is keyed by the plugin's own id, and the
 * engine's `name@marketplace` is only the install handle it is acted on through (plan §4.1, D0).
 *
 * The engine records an install under `name@marketplace` and lets the same plugin be recorded from
 * more than one marketplace, while the runtime link it writes allows only one of them to be live in
 * a scope (`marketplace/manager.ts`). That makes the handle the wrong key for everything the desktop
 * keys by plugin - consent, settings, pages, themes - so this module collapses the engine's records
 * into one row per `(plugin id, scope)` and keeps every other record as a source of the same plugin.
 *
 * Nothing here reads a file or the SDK: a candidate is what the engine's registries and a plugin's
 * own directory already said, and the parse function is passed in, so the collapse, the tie-break
 * and the source order are all testable against the engine's own parser without loading it.
 */

import { logLine } from './log.ts'
import type { DesktopView } from './plugins-desktop.ts'
import type { PluginCatalog } from './plugins-market.ts'

/**
 * The engine's `name@marketplace` parser (`marketplace/types.ts::parsePluginId`), injected rather
 * than imported so this module stays free of the SDK.
 */
export type PluginIdParser = (id: string) => { readonly name: string; readonly marketplace: string } | null

/**
 * The plugin's own id, for a record the engine keys by install handle.
 *
 * A marketplace record is always `name@marketplace`, so the handle's name segment is the plugin id.
 * An id the engine's parser rejects is its own id: the row still has to be addressable, and the
 * install handle is the only name the engine gave it.
 */
export function pluginIdOf(parse: PluginIdParser, installId: string): string {
  return parse(installId)?.name ?? installId
}

/**
 * How many extension modules the plugin's effective manifest declares - its own entries plus those
 * of the enabled features: each one runs in this process. Read by `plugins-facts.ts`; it is part of
 * the row, so the shape lives beside the row.
 */
export interface CodeFacts {
  readonly extensions: number
  readonly baseTools: boolean
  readonly baseHooks: boolean
  readonly hooksDir: boolean
  readonly toolsDir: boolean
  readonly mcpConfig: boolean
  /** The engine materialises a marketplace entry's `lspServers` as this file (`manager.ts`). */
  readonly lspConfig: boolean
  /** The same for `dapAdapters`, which the engine writes as `.dap.json`. */
  readonly dapConfig: boolean
  readonly skillsDir: boolean
  readonly commandsDir: boolean
  readonly agentsDir: boolean
  /**
   * The plugin ships rules (`rules/`). The engine reads every rule of an enabled plugin in this
   * host's process, buckets it and hands the `alwaysApply` ones to the system prompt, so this is
   * the strongest prompt-injection surface a package has (spec §4.1.1).
   */
  readonly rulesDir: boolean
  /**
   * The plugin ships prompt templates (`prompts/`). The engine discovers them (its `prompts`
   * capability) but this SDK line gives them no dispatch path, so they are reported as a fact and
   * never promised to run (spec §15.4).
   */
  readonly promptsDir: boolean
}

/** Where one row's code comes from, as the engine's own facts describe it (contract §1). */
export interface PluginRowSource {
  readonly kind: 'marketplace' | 'npm' | 'link'
  readonly label: string
  readonly gitCommitSha: string | null
  /** The marketplace the active install came from; `null` for an npm or linked install. */
  readonly marketplace: string | null
  /** The engine handle the write commands address (`name@marketplace`); `null` for npm/link. */
  readonly installId: string | null
  /** Always true on the row's own source: this is the record the engine acts on. */
  readonly installed: true
}

/** One other place the same plugin is recorded or listed (plan §4.1). */
export interface PluginSourceView {
  readonly marketplace: string
  readonly version: string
  /** The handle an install of that source would be recorded under (`<plugin id>@<marketplace>`). */
  readonly sourceLabel: string
  /** True only for the marketplace of the row's active install. */
  readonly installed: boolean
}

/** One row of the plugin list (contract §1). */
export interface PluginRow {
  /** The plugin's own id - the key every desktop surface uses (plan D0). */
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly version: string
  readonly scope: 'user' | 'project'
  readonly enabled: boolean
  readonly shadowedBy: 'project' | null
  /** The engine handle for a marketplace row; `null` for npm/link (plan §4.1). */
  readonly installId: string | null
  readonly source: PluginRowSource
  readonly sources: PluginSourceView[]
  readonly installedAt: string | null
  readonly lastUpdated: string | null
  readonly rootPath: string
  readonly consent: { readonly required: boolean; readonly reasons: string[] }
  readonly code: CodeFacts
  readonly settings: { readonly keys: string[]; readonly hasSecret: boolean }
  readonly desktop: DesktopView | null
  readonly desktopError: string | null
}

/**
 * One install record, with everything its row needs already read.
 *
 * A candidate is one entry of the engine's registries - an npm/link install (`installId: null`, the
 * package name is the id) or one marketplace record per `(install handle, scope)`. Several
 * candidates can share a plugin id; `mergeCandidates` decides which one the row shows.
 */
export interface PluginCandidate {
  readonly pluginId: string
  readonly installId: string | null
  readonly scope: 'user' | 'project'
  readonly name: string
  readonly description: string | null
  readonly version: string
  readonly enabled: boolean
  readonly shadowedBy: 'project' | null
  readonly installedAt: string | null
  readonly lastUpdated: string | null
  readonly rootPath: string
  readonly consent: { readonly required: boolean; readonly reasons: string[] }
  readonly code: CodeFacts
  readonly settings: { readonly keys: string[]; readonly hasSecret: boolean }
  readonly desktop: DesktopView | null
  readonly desktopError: string | null
  readonly source: PluginRowSource
}

/** The fields the active-install tie-break reads, flat so the update scan can reuse the rule. */
export interface InstallOrderKey {
  readonly enabled: boolean
  readonly lastUpdated: string | null
  readonly marketplace: string | null
  readonly installId: string | null
}

/**
 * Orders two install records of one plugin: negative when `left` is the row's active install.
 *
 * Plan §4.1: the enabled record wins, the newest `lastUpdated` next (an ISO 8601 string, so a plain
 * string compare is the chronological one; a missing stamp sorts oldest - which is what an npm or
 * linked lock entry carries), then a marketplace install over npm/link, then the lexicographically
 * first install handle. With nothing enabled the same order still picks one, because a row is shown
 * for a disabled plugin too.
 *
 * Exported because the update scan groups by the same `(plugin id, scope)` and must point at the
 * same install: a second tie-break would be a second rule.
 */
export function activeInstallFirst(left: InstallOrderKey, right: InstallOrderKey): number {
  if (left.enabled !== right.enabled) return left.enabled ? -1 : 1
  const leftUpdated = left.lastUpdated ?? ''
  const rightUpdated = right.lastUpdated ?? ''
  if (leftUpdated !== rightUpdated) return leftUpdated > rightUpdated ? -1 : 1
  const leftMarketplace = left.marketplace !== null
  const rightMarketplace = right.marketplace !== null
  if (leftMarketplace !== rightMarketplace) return leftMarketplace ? -1 : 1
  const leftHandle = left.installId ?? ''
  const rightHandle = right.installId ?? ''
  if (leftHandle !== rightHandle) return leftHandle < rightHandle ? -1 : 1
  return 0
}

/** Ascending string order: the one comparison every determinism requirement here means. */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * The sources of one plugin: every marketplace that records or lists it, plus the other records of
 * the same `(plugin id, scope)` group.
 *
 * Per marketplace at most two entries: the installed record's version, and the catalog's version
 * when it differs from the installed one - so a stale install shows both "what you run" and "what
 * the marketplace now declares" without repeating them when they agree. `installed` is true only on
 * the active install's marketplace, which is exactly the question a detail page asks.
 *
 * A catalog entry without a version is not a candidate at all: the engine's own update check skips
 * one (`marketplace/manager.ts`), and a source row with no version has nothing to show.
 */
function sourceViews(
  active: PluginCandidate,
  group: readonly PluginCandidate[],
  catalog: readonly { readonly marketplace: string; readonly version: string }[],
): PluginSourceView[] {
  const installed = new Map<string, PluginCandidate>()
  for (const candidate of group) {
    const marketplace = candidate.source.marketplace
    if (marketplace !== null) installed.set(marketplace, candidate)
  }
  const available = new Map<string, string>()
  for (const entry of catalog) {
    if (!available.has(entry.marketplace)) available.set(entry.marketplace, entry.version)
  }
  const names = [...new Set([...installed.keys(), ...available.keys()])].sort(compareText)
  const views: PluginSourceView[] = []
  for (const marketplace of names) {
    const record = installed.get(marketplace)
    const sourceLabel = `${active.pluginId}@${marketplace}`
    if (record !== undefined) {
      views.push({ marketplace, version: record.version, sourceLabel, installed: record === active })
    }
    const version = available.get(marketplace)
    if (version === undefined || version === record?.version) continue
    views.push({ marketplace, version, sourceLabel, installed: false })
  }
  return views
}

/**
 * Collapses the engine's install records into the rows the page renders: one per
 * `(plugin id, scope)`, sorted by id and then scope so the caller never has to.
 *
 * Every record that lost the tie-break is still visible - as a `sources[]` entry and as one
 * diagnostic line naming the handle that was used and the ones that were not. The engine can leave
 * such a group behind (two marketplaces supplying one plugin name, or a marketplace install beside an
 * npm one), and a row that silently dropped the extra record would make the next uninstall look like
 * it removed the wrong thing.
 */
export function mergeCandidates(candidates: readonly PluginCandidate[], catalog: PluginCatalog): PluginRow[] {
  const groups = new Map<string, PluginCandidate[]>()
  for (const candidate of candidates) {
    const key = `${candidate.pluginId}\u0000${candidate.scope}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [candidate])
    else group.push(candidate)
  }

  const rows: PluginRow[] = []
  for (const group of groups.values()) {
    const ordered =
      group.length > 1
        ? [...group].sort((left, right) =>
            activeInstallFirst(
              { enabled: left.enabled, lastUpdated: left.lastUpdated, marketplace: left.source.marketplace, installId: left.installId },
              { enabled: right.enabled, lastUpdated: right.lastUpdated, marketplace: right.source.marketplace, installId: right.installId },
            ),
          )
        : group
    const active = ordered[0] as PluginCandidate
    if (ordered.length > 1) {
      const others = ordered.slice(1).map(other => other.installId ?? other.pluginId).join(', ')
      logLine(
        `plugin "${active.pluginId}" (${active.scope}) has ${String(ordered.length)} install records; the row shows "${active.installId ?? active.pluginId}" and lists ${others} as sources`,
      )
    }
    rows.push({
      id: active.pluginId,
      name: active.name,
      description: active.description,
      version: active.version,
      scope: active.scope,
      enabled: active.enabled,
      shadowedBy: active.shadowedBy,
      installId: active.installId,
      source: active.source,
      sources: sourceViews(active, ordered, catalog.get(active.pluginId) ?? []),
      installedAt: active.installedAt,
      lastUpdated: active.lastUpdated,
      rootPath: active.rootPath,
      consent: active.consent,
      code: active.code,
      settings: active.settings,
      desktop: active.desktop,
      desktopError: active.desktopError,
    })
  }

  rows.sort((left, right) => compareText(left.id, right.id) || compareText(left.scope, right.scope))
  return rows
}
