/**
 * `plugins_check_updates`: the engine's own update rows, plus the cross-market scan it does not do.
 *
 * The engine compares an install only with its own marketplace's catalog
 * (`marketplace/manager.ts::checkForUpdates`), so a plugin the user has installed from market A
 * never learns that market B declares a newer version. Plan §4.2 keeps the comparison exactly as
 * the engine defines it - `Bun.semver.order(candidate, installed) > 0`, falling back to `!==` when
 * either tag cannot be parsed - and adds one pass over every registered marketplace's catalog for
 * the same plugin id.
 *
 * The scan can only report what the engine can act on: `upgradePlugin` reinstalls `name@marketplace`
 * and cannot move a plugin between marketplaces (`manager.ts`), so a newer version in another
 * marketplace is a `switch-source` answer for the desktop to run as uninstall + install, while a
 * newer version in the installed marketplace is the engine's own `in-place` upgrade. An npm or
 * linked install has no marketplace to switch from, so it never produces either.
 *
 * Everything here is a pure function over the engine's registries as read by the caller.
 */

import { logLine } from './log.ts'
import type { PluginCatalog, PluginCatalogVersion } from './plugins-market.ts'
import { activeInstallFirst, compareText } from './plugins-rows.ts'
import type { PluginIdParser } from './plugins-rows.ts'

/** One row `plugins_check_updates` reports (plan §4.2). */
export interface PluginUpdate {
  /** The plugin's own id, i.e. the row id `plugins_list` uses. */
  readonly pluginId: string
  /** The engine handle this update is applied through (`name@marketplace`). */
  readonly installId: string
  readonly scope: 'user' | 'project'
  readonly from: string
  readonly to: string
  /** The marketplace that declares `to`. */
  readonly marketplace: string
  /**
   * `in-place` is the engine's own upgrade; `switch-source` names a newer version in another
   * marketplace, which is a two-step uninstall + install and must be shown as such.
   */
  readonly kind: 'in-place' | 'switch-source'
}

/** One plugin's visible versions, for the update card's "also in these marketplaces" list. */
export interface PluginUpdateCandidates {
  readonly pluginId: string
  readonly scope: 'user' | 'project'
  readonly sources: Array<{ readonly marketplace: string; readonly version: string }>
}

/** The engine's own `checkForUpdates()` row: `pluginId` here is the install handle. */
export interface EngineUpdate {
  readonly pluginId: string
  readonly scope: 'user' | 'project'
  readonly from: string
  readonly to: string
}

/** One installed marketplace record, as the scan reads it (the summary plus its active entry). */
export interface InstalledMarketRecord {
  readonly installId: string
  readonly scope: 'user' | 'project'
  readonly version: string
  readonly enabled: boolean
  readonly lastUpdated: string | null
}

/** What one call to `classifyPluginUpdates` needs. */
export interface UpdateInput {
  /** The engine's `parsePluginId`, injected so this module stays free of the SDK. */
  readonly parse: PluginIdParser
  readonly engine: readonly EngineUpdate[]
  readonly installed: readonly InstalledMarketRecord[]
  readonly catalog: PluginCatalog
}

/**
 * Whether `candidate` is a newer version than `installed`, by the engine's own rule
 * (`marketplace/manager.ts:794-800`).
 *
 * The fallback is not a nicety: a catalog may declare a tag (`next`, a date, a git sha), and the
 * engine treats any inequality as an update for those. Reusing its rule is the only way the two
 * answers can agree, which the unit test pins on one shared fixture set.
 */
export function isNewerVersion(candidate: string, installed: string): boolean {
  try {
    return Bun.semver.order(candidate, installed) > 0
  } catch {
    return candidate !== installed
  }
}

/**
 * The highest version any marketplace declares for one plugin, or `null` when none declares one.
 *
 * The input is ordered by marketplace, so two marketplaces declaring the same version answer with
 * the same marketplace on every read: only a strictly newer version replaces the current best.
 */
function bestCatalogVersion(versions: readonly PluginCatalogVersion[]): PluginCatalogVersion | null {
  let best: PluginCatalogVersion | null = null
  for (const version of versions) {
    if (version.version === '') continue
    if (best === null || isNewerVersion(version.version, best.version)) best = version
  }
  return best
}

/** One plugin's catalog sources as the answer carries them, deduplicated, in the order given. */
function sourceList(versions: readonly PluginCatalogVersion[]): Array<{ marketplace: string; version: string }> {
  const seen = new Set<string>()
  const sources: Array<{ marketplace: string; version: string }> = []
  for (const version of versions) {
    const key = `${version.marketplace}\u0000${version.version}`
    if (seen.has(key)) continue
    seen.add(key)
    sources.push({ marketplace: version.marketplace, version: version.version })
  }
  return sources
}

/** One installed record, with the two segments its handle splits into. */
interface ParsedRecord {
  readonly record: InstalledMarketRecord
  readonly pluginId: string
  readonly marketplace: string
}

/**
 * The engine's rows, renamed into the row identity, plus the scan for the rows it cannot see.
 *
 * The engine reported what the *installed* marketplace declares; the scan is about every other
 * marketplace. They are two answers to two questions, so a group that has both keeps the better one
 * rather than dropping the second (plan §4.2): a newer version in another marketplace is a source
 * switch, and it must not disappear because the engine also found a smaller in-place bump. The
 * engine's row survives when the other marketplace has nothing newer to offer, and a same-marketplace
 * catalog version never adds a second row.
 *
 * A record whose handle the engine's parser rejects is skipped - it cannot be grouped by plugin id at
 * all, and `checkForUpdates` never reports one either - with one diagnostic line rather than silence.
 */
export function classifyPluginUpdates(input: UpdateInput): {
  updates: PluginUpdate[]
  candidates: PluginUpdateCandidates[]
} {
  const updates: PluginUpdate[] = []
  // Where each `(install handle, scope)` row sits in `updates`: the engine's own row, or the
  // `switch-source` row that replaced it. One entry per key is also the deduplication.
  const engineRows = new Map<string, number>()
  const updateKey = (installId: string, scope: string): string => `${installId}\u0000${scope}`

  for (const update of input.engine) {
    const parsed = input.parse(update.pluginId)
    if (parsed === null) {
      logLine(`plugin update ignored: the engine reported "${update.pluginId}", which has no plugin id to group it by`)
      continue
    }
    const key = updateKey(update.pluginId, update.scope)
    if (engineRows.has(key)) continue
    engineRows.set(key, updates.length)
    updates.push({
      pluginId: parsed.name,
      installId: update.pluginId,
      scope: update.scope,
      from: update.from,
      to: update.to,
      marketplace: parsed.marketplace,
      kind: 'in-place',
    })
  }

  const parsedRecords: ParsedRecord[] = []
  for (const record of input.installed) {
    const parsed = input.parse(record.installId)
    if (parsed === null) {
      logLine(`plugin install "${record.installId}" is not a name@marketplace handle; it is left out of the update check`)
      continue
    }
    parsedRecords.push({ record, pluginId: parsed.name, marketplace: parsed.marketplace })
  }

  // One row per `(plugin id, scope)`, the same grouping the list row uses: several records of one
  // plugin in one scope are one plugin to the user, and the scan answers for the record the list
  // would act on (the same tie-break).
  const groups = new Map<string, ParsedRecord[]>()
  for (const item of parsedRecords) {
    const key = `${item.pluginId}\u0000${item.record.scope}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [item])
    else group.push(item)
  }

  const candidates: PluginUpdateCandidates[] = []
  for (const group of groups.values()) {
    const ordered =
      group.length > 1
        ? [...group].sort((left, right) =>
            activeInstallFirst(
              { enabled: left.record.enabled, lastUpdated: left.record.lastUpdated, marketplace: left.marketplace, installId: left.record.installId },
              { enabled: right.record.enabled, lastUpdated: right.record.lastUpdated, marketplace: right.marketplace, installId: right.record.installId },
            ),
          )
        : group
    const active = ordered[0] as ParsedRecord
    // Sorted once and used for both answers: the candidate list the page shows and the scan, so the
    // two cannot disagree about which version comes from which marketplace.
    const versions = [...(input.catalog.get(active.pluginId) ?? [])].sort(
      (left, right) => compareText(left.marketplace, right.marketplace) || compareText(left.version, right.version),
    )
    candidates.push({ pluginId: active.pluginId, scope: active.record.scope, sources: sourceList(versions) })

    const best = bestCatalogVersion(versions)
    if (best === null) continue
    const key = updateKey(active.record.installId, active.record.scope)
    const engineIndex = engineRows.get(key)

    if (best.marketplace === active.marketplace) {
      // Same marketplace: the engine's row already describes this update, and a second row for one
      // install would make the page offer the same upgrade twice.
      if (engineIndex !== undefined || !isNewerVersion(best.version, active.record.version)) continue
      engineRows.set(key, updates.length)
      updates.push({
        pluginId: active.pluginId,
        installId: active.record.installId,
        scope: active.record.scope,
        from: active.record.version,
        to: best.version,
        marketplace: best.marketplace,
        kind: 'in-place',
      })
      continue
    }

    if (engineIndex !== undefined) {
      // Another marketplace has a newer version than the engine's own upgrade target: that is the
      // cross-market answer this scan exists for, so it replaces the in-place row instead of being
      // dropped. An equal or older one leaves the engine's row exactly as it was.
      const engineRow = updates[engineIndex] as PluginUpdate
      if (!isNewerVersion(best.version, engineRow.to)) continue
      updates[engineIndex] = {
        pluginId: active.pluginId,
        installId: active.record.installId,
        scope: active.record.scope,
        from: active.record.version,
        to: best.version,
        marketplace: best.marketplace,
        kind: 'switch-source',
      }
      continue
    }

    if (!isNewerVersion(best.version, active.record.version)) continue
    engineRows.set(key, updates.length)
    updates.push({
      pluginId: active.pluginId,
      installId: active.record.installId,
      scope: active.record.scope,
      from: active.record.version,
      to: best.version,
      marketplace: best.marketplace,
      kind: 'switch-source',
    })
  }

  updates.sort(
    (left, right) =>
      compareText(left.pluginId, right.pluginId) ||
      compareText(left.scope, right.scope) ||
      compareText(left.installId, right.installId),
  )
  // The same two orders for both lists, so a reread answers identically whatever order the engine's
  // registry happened to hold (`plugins_list` sorts its rows the same way).
  candidates.sort((left, right) => compareText(left.pluginId, right.pluginId) || compareText(left.scope, right.scope))
  return { updates, candidates }
}
