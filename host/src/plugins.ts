/**
 * The plugin commands: the installed set, the writes that change it, and the state each write
 * leaves behind.
 *
 * The rows a caller renders are projected in `plugins-facts.ts` from the engine's own registries
 * (`PluginManager.list()` and `MarketplaceManager.listInstalledPlugins()`); the writes here
 * are the manager calls the `omp plugin` CLI makes, and the install classification is the
 * engine's `classifyInstallTarget` - so a source pasted into the desktop resolves exactly as
 * `omp plugin install` resolves it. What this module adds is the request bounds and the answer a
 * caller can branch on when the engine refuses.
 *
 * A write is never answered with the state the caller asked for: it calls
 * `registry.reloadPlugins()` first and then re-reads the list, because the engine's plugin roots
 * are cached per process and a session that was not reloaded still runs on the old set.
 *
 * Every plugin id travels under `targetId`, never under `id`: `id` is the envelope's
 * request-response correlation key and the desktop's Rust host overwrites it on the way out, so a
 * plugin the caller addressed as `id` would be addressed as `h7` instead (contract §2.3,
 * ruling C14). A frame that addresses a plugin and carries no `targetId` is refused rather than
 * falling back to `id`, because the fallback would address the caller's own request key
 * (contract §2.1). `plugins_upgrade` is the one frame where the field is optional, and its
 * absence is a meaning of its own: upgrade every stale plugin.
 */

import { realpathSync } from 'node:fs'
import * as path from 'node:path'

import type { BootServices } from './boot.ts'
import { enumField, requireBoolean, requireText, resolveCwd } from './capabilities.ts'
import { PLUGIN_ID_MAX } from './constants.ts'
import type { HostPaths } from './env.ts'
import { logLine, sanitizeMessage } from './log.ts'
import { pluginRows } from './plugins-facts.ts'
import { probePluginToolchain } from './plugins-engine.ts'
import { pathIsDirectory } from './plugins-manifest.ts'
import { classifyPluginUpdates } from './plugins-updates.ts'
import type { InstalledMarketRecord } from './plugins-updates.ts'
import { ERROR_CODES, HostError, invalidInput } from './protocol/errors.ts'
import {
  assertSourceScheme,
  pluginEngineError,
  pluginManagers,
  pluginSourceField,
  pluginTargetField,
  pluginToolchainRefusal,
  readPluginCatalog,
} from './plugins-market.ts'
import type { SessionRegistry } from './sessions.ts'
import type { SdkBundle } from './sdk.ts'

export {
  addMarketplace,
  listMarketplacePlugins,
  listMarketplaces,
  removeMarketplace,
  updateMarketplace,
} from './plugins-market.ts'
export { readPluginConfig, resetPluginConfig, writePluginConfig } from './plugins-settings.ts'

/** Scopes a plugin write may address, in the engine's own vocabulary. */
const PLUGIN_SCOPES = ['user', 'project'] as const

/** The scope a write addresses; absent means "the engine's default for this plugin". */
function scopeField(value: unknown): 'user' | 'project' | null {
  if (value === undefined || value === null) return null
  return enumField(value, PLUGIN_SCOPES, 'scope')
}

/** Runs engine work, answering its result or the `HostError` that classifies its failure. */
async function callEngine<T>(work: () => Promise<T>, action: string): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof HostError) throw error
    throw pluginEngineError(action, error)
  }
}

/**
 * The list a write answers with: the reload first, then a fresh read.
 *
 * The engine writes its registries, but a session that has already loaded its plugin roots keeps
 * serving the old set until they are dropped, so the change is applied to every live conversation
 * before the answer is built. The list is then read again - the page renders what the sessions
 * actually run on, and never an optimistic guess.
 */
async function reloadAndList(registry: SessionRegistry, sdk: SdkBundle, cwd: string): Promise<Record<string, unknown>> {
  const { reloaded, failed } = await registry.reloadPlugins()
  logLine(`plugin change applied: ${String(reloaded)} session(s) reloaded`)
  // The four write paths answer with the plugin list, which has nowhere to carry this; the log is
  // the one place a caller can still learn that the set did not converge everywhere (M4's residual).
  if (failed > 0) logLine(`plugin change was not applied to ${String(failed)} session(s)`)
  return { plugins: await pluginRows(sdk, cwd) }
}

/** `plugins_list`: every installed plugin, with the facts a settings page shows. */
export async function listPlugins(
  paths: HostPaths,
  _services: BootServices,
  sdk: SdkBundle,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const cwd = resolveCwd(paths, frame.cwd)
  try {
    return { plugins: await pluginRows(sdk, cwd) }
  } catch (error) {
    if (error instanceof HostError) throw error
    throw pluginEngineError('list the installed plugins', error)
  }
}

/**
 * `plugins_install`: one source string, routed by the engine's own classifier.
 *
 * A local path is linked, an npm spec is installed, and a `name@marketplace` reference is installed
 * from that catalog - which is exactly what `omp plugin install` does with the same string. The
 * local path is required to exist first: the engine would happily link a path that is not there and
 * leave a broken symlink behind, and "the source is not a directory" is the answer a caller can act
 * on while "the plugin did not load" is not.
 */
export async function installPlugin(
  paths: HostPaths,
  _services: BootServices,
  sdk: SdkBundle,
  frame: Record<string, unknown>,
  registry: SessionRegistry,
): Promise<Record<string, unknown>> {
  const source = pluginSourceField(frame.source)
  const scope = scopeField(frame.scope)
  const cwd = resolveCwd(paths, frame.cwd)
  const { manager, market } = await pluginManagers(sdk, cwd)
  const known = new Set((await market.listMarketplaces()).map(entry => entry.name))
  const target = sdk.classifyInstallTarget(source, known)

  // The preflight (spec §15.1-6): an npm spec - a package name, a version range or a git shorthand,
  // which the engine installs with `bun install` - cannot be installed without `bun`, and finding
  // that out from a spawn error deep inside the engine tells the caller the plugin is broken instead
  // of telling it the machine is. `local` is left alone: it links, and its failures are about the
  // path and the platform's symlink permission, which the engine reports itself.
  if (target.type === 'npm' && !probePluginToolchain().bun) {
    throw pluginToolchainRefusal(`install "${target.spec}"`, 'bun')
  }

  if (target.type === 'marketplace') {
    // A catalogue entry names its own package source, and the engine's fetch of that source is the
    // same network call a pasted address would make - so the scheme rule is applied to the address
    // the entry declares, not only to the string the reader typed.
    const entries = await callEngine(
      () => market.listAvailablePlugins(target.marketplace),
      `read "${target.marketplace}"`,
    )
    const declared = entries.find(entry => entry.name === target.name)?.source
    const declaredUrl =
      typeof declared === 'object' && declared !== null && 'url' in declared && typeof declared.url === 'string'
        ? declared.url
        : ''
    if (declaredUrl !== '') assertSourceScheme(declaredUrl)
    const install = () =>
      callEngine(
        () => market.installPlugin(target.name, target.marketplace, scope === null ? {} : { scope }),
        `install ${source}`,
      )
    try {
      await install()
    } catch (error) {
      // A write that failed half way leaves the engine's *runtime* registry (the plugins lock and
      // its `node_modules` link) naming a package the plugin list no longer holds - and the next
      // install of that name is refused as a conflict ("Runtime package name … conflicts with
      // installed package …"). That is a leftover, not a live plugin: the list is what this
      // application shows as installed, so a name it does not hold is one nothing is running.
      // Removing it once and retrying is the repair; a second failure is the engine's own answer.
      const removed = await removeLeftoverRuntime(manager, market, target.name)
      if (removed === null) throw error
      logLine(`a plugin install repaired a leftover runtime package: ${removed}`)
      try {
        await install()
      } catch (retryError) {
        logLine(`the install of ${source} still failed after the repair: ${sanitizeMessage(String(retryError))}`)
        throw retryError
      }
    }
  } else {
    // `PluginManager` has one plugin directory, so these two have no project form to write to.
    if (scope === 'project') {
      throw new HostError(
        ERROR_CODES.plugin_scope_mismatch,
        `A ${target.type} install has no project scope; install it for the user instead.`,
      )
    }
    if (target.type === 'local') {
      const resolved = path.resolve(cwd, target.path)
      if (!pathIsDirectory(resolved)) {
        throw invalidInput(`The install source is not a directory: ${sanitizeMessage(resolved)}`)
      }
      await callEngine(() => manager.link(resolved), `link "${resolved}"`)
    } else {
      await callEngine(() => manager.install(target.spec), `install "${target.spec}"`)
    }
  }
  return await reloadAndList(registry, sdk, cwd)
}

/**
 * Removes one runtime package no installation row holds, and answers its name when it did.
 *
 * The state this heals: a marketplace write that removed its registry record but could not unlink
 * the package (a running worker's `cwd` was the package - `EBUSY` on Windows; the supervisor now
 * stops it first, but a process killed mid-write can still leave this behind). The engine's installer
 * then refuses every later install of that name as a conflict, and nothing in the UI shows the
 * package any more, so the reader has no way to clear it.
 *
 * **The list decides, not the caller**: the name is only removed when no row holds it, which is
 * exactly "no installation this application knows about". A linked or npm plugin is a row, so a
 * live one is never touched. `null` means nothing was removed - either the package is not there or
 * it is live - and the caller re-throws its own error then.
 */
async function removeLeftoverRuntime(
  manager: Awaited<ReturnType<typeof pluginManagers>>['manager'],
  market: Awaited<ReturnType<typeof pluginManagers>>['market'],
  name: string,
): Promise<string | null> {
  // A marketplace install still on record owns its runtime link; nothing here touches it.
  const installed = await market.listInstalledPlugins().catch(() => [])
  if (installed.some(summary => summary.id.split('@')[0] === name)) return null
  const runtime = await manager.list().catch(() => [])
  const entry = runtime.find(plugin => plugin.name === name)
  logLine(
    `a plugin install looked for a leftover "${name}": marketplace=${String(installed.length)} runtime=${String(runtime.length)} match=${entry === undefined ? 'none' : entry.path}`,
  )
  if (entry === undefined) {
    // A lock row with no runtime package behind it. That is not a link the reader could be using -
    // the app's own list is built from `list()`, so a plugin missing there is one nothing runs - and
    // the lock row is exactly what the installer's conflict check reads. `npm uninstall` of a name
    // that is not installed exits 0, so this only ever clears the row.
    try {
      await manager.uninstall(name)
      return `${name} (lock row, no runtime package)`
    } catch (error) {
      logLine(`the leftover lock row for ${name} could not be removed: ${sanitizeMessage(String(error))}`)
      return null
    }
  }
  // A runtime package: the discriminator is where it points. A leftover of a failed marketplace
  // uninstall points into the engine's own cache (the directory that uninstall was deleting); a real
  // linked install points at the author's directory and is the reader's working copy - the engine
  // refusing a market install over it is a conflict to resolve, not something to repair silently.
  const cache = `${path.sep}cache${path.sep}plugins${path.sep}`
  // `list()` reports the runtime root (`node_modules/<name>`), which is a link into the cache for a
  // marketplace install: the resolution is what tells a cache leftover from a real link.
  let resolved = path.resolve(entry.path)
  try {
    resolved = realpathSync(resolved)
  } catch {
    // A link whose target is gone is the strongest leftover there is; the raw path decides then.
  }
  if (!resolved.includes(cache)) {
    logLine(`a plugin install left the runtime package "${name}" alone: it points outside the cache`)
    return null
  }
  try {
    await manager.uninstall(name)
    return `${name} (marketplace cache)`
  } catch (error) {
    logLine(`the leftover cache package for ${name} could not be removed: ${sanitizeMessage(String(error))}`)
    return null
  }
}

/**
 * `plugins_uninstall`: remove one plugin, whichever registry holds it.
 *
 * `targetId` is the row's install handle for a marketplace row and the package name for an npm or
 * linked one (plan §4.1); `plugins-market.ts::pluginTargetField` is the one classifier, so a bare
 * name is never guessed into a marketplace install. The npm/link path is guarded by the engine's own
 * list first: `bun uninstall` exits 0 for a package that was never a dependency, so without the
 * check this command would report a removal that took nothing away.
 */
export async function uninstallPlugin(
  paths: HostPaths,
  _services: BootServices,
  sdk: SdkBundle,
  frame: Record<string, unknown>,
  registry: SessionRegistry,
): Promise<Record<string, unknown>> {
  const scope = scopeField(frame.scope)
  const cwd = resolveCwd(paths, frame.cwd)
  const { manager, market } = await pluginManagers(sdk, cwd)
  const installed = await market.listInstalledPlugins()
  const target = pluginTargetField(frame.targetId, installed.map(summary => summary.id))

  if (target.kind === 'marketplace') {
    await callEngine(
      () => market.uninstallPlugin(target.installId, scope === null ? undefined : scope),
      `uninstall "${target.installId}"`,
    )
  } else {
    const plugins = await manager.list()
    if (!plugins.some(plugin => plugin.name === target.name)) {
      throw new HostError(ERROR_CODES.plugin_not_found, `No plugin is installed as "${target.name}".`)
    }
    await callEngine(() => manager.uninstall(target.name), `uninstall "${target.name}"`)
  }
  return await reloadAndList(registry, sdk, cwd)
}

/**
 * `plugins_set_enabled`: turn one plugin on or off.
 *
 * The toggle is the engine's in both registries: a marketplace install carries `enabled` in its
 * registry entry and a runtime flag beside it, while npm and linked plugins carry it in the plugins
 * lock file. Nothing here decides what "enabled" means - a plugin that the engine cannot enable
 * (no runtime record, a broken link) refuses instead of being reported as toggled. The target is the
 * row's install handle or its package name, classified by shape (plan §4.1).
 */
export async function setPluginEnabled(
  paths: HostPaths,
  _services: BootServices,
  sdk: SdkBundle,
  frame: Record<string, unknown>,
  registry: SessionRegistry,
): Promise<Record<string, unknown>> {
  const enabled = requireBoolean(frame.enabled, 'enabled')
  const scope = scopeField(frame.scope)
  const cwd = resolveCwd(paths, frame.cwd)
  const { manager, market } = await pluginManagers(sdk, cwd)
  const installed = await market.listInstalledPlugins()
  const target = pluginTargetField(frame.targetId, installed.map(summary => summary.id))

  if (target.kind === 'marketplace') {
    await callEngine(
      () => market.setPluginEnabled(target.installId, enabled, scope === null ? undefined : scope),
      `set "${target.installId}" enabled=${String(enabled)}`,
    )
  } else {
    const plugin = await manager.getPlugin(target.name)
    if (plugin === undefined) {
      throw new HostError(ERROR_CODES.plugin_not_found, `No plugin is installed as "${target.name}".`)
    }
    await callEngine(() => manager.setEnabled(plugin.name, enabled), `set "${target.name}" enabled=${String(enabled)}`)
  }
  return await reloadAndList(registry, sdk, cwd)
}

/**
 * `plugins_upgrade`: reinstall one plugin at its catalog version, or every stale one.
 *
 * `upgraded` is the engine's own answer, passed through as it came: `upgradeAllPlugins()` reports
 * the `{ pluginId, scope, from, to }` rows it applied, a single `upgradePlugin()` reports the
 * install entry it wrote. The target is the row's install handle (plan §4.1) - a bare name must not
 * be guessed into one - and a handle the engine does not record is `plugin_not_found` before any
 * work runs. An npm or linked plugin keeps the engine's own answer for it: `upgradePlugin` addresses
 * a marketplace install, so the package name reaches the engine and its refusal is classified, never
 * turned into a removal or a silent no-op.
 */
export async function upgradePlugins(
  paths: HostPaths,
  _services: BootServices,
  sdk: SdkBundle,
  frame: Record<string, unknown>,
  registry: SessionRegistry,
): Promise<Record<string, unknown>> {
  const requestedId = frame.targetId
  const requested = requestedId === undefined || requestedId === null ? '' : requireText(requestedId, 'targetId', PLUGIN_ID_MAX).trim()
  const scope = scopeField(frame.scope)
  const cwd = resolveCwd(paths, frame.cwd)
  const { market } = await pluginManagers(sdk, cwd)
  const target =
    requested === ''
      ? null
      : pluginTargetField(
          requested,
          (await market.listInstalledPlugins()).map(summary => summary.id),
        )
  const upgraded: unknown =
    target === null
      ? await callEngine(() => market.upgradeAllPlugins(), 'upgrade every stale plugin')
      : await callEngine(
          () => market.upgradePlugin(target.kind === 'marketplace' ? target.installId : target.name, scope === null ? undefined : scope),
          `upgrade "${requested}"`,
        )
  const view = await reloadAndList(registry, sdk, cwd)
  return { ...view, upgraded }
}

/**
 * `plugins_check_updates`: which installed plugins have a newer version, and where.
 *
 * The engine compares an install only with its own marketplace's catalog, so its answer is one half
 * of the truth (plan §4.2): `plugins-updates.ts` renames its rows into the plugin identity and adds
 * the cross-market scan, using the engine's own comparison rule and the catalogues read in one pass
 * here. The scan's newer-in-another-marketplace rows are `switch-source`, because the engine's
 * `upgradePlugin` cannot move a plugin between marketplaces and the desktop has to run two steps.
 */
export async function checkPluginUpdates(
  paths: HostPaths,
  _services: BootServices,
  sdk: SdkBundle,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const cwd = resolveCwd(paths, frame.cwd)
  const { market } = await pluginManagers(sdk, cwd)
  const [engine, installed, catalog] = await Promise.all([
    callEngine(() => market.checkForUpdates(), 'check for plugin updates'),
    callEngine(() => market.listInstalledPlugins(), 'read the installed plugins'),
    callEngine(() => readPluginCatalog(market), 'read the marketplaces'),
  ])
  const records: InstalledMarketRecord[] = []
  for (const summary of installed) {
    const entry = summary.entries[0]
    if (entry === undefined) continue
    records.push({
      installId: summary.id,
      scope: summary.scope,
      version: entry.version,
      enabled: entry.enabled !== false,
      lastUpdated: entry.lastUpdated ?? null,
    })
  }
  const answer = classifyPluginUpdates({ parse: sdk.parsePluginId, engine, installed: records, catalog })
  return { updates: answer.updates, candidates: answer.candidates }
}

/**
 * `plugins_reload`: rebuild every live session's plugin-derived state.
 *
 * The command the desktop calls after something outside this host changed the plugins on disk (a
 * file edit, a git checkout, another process's install): the engine's roots and the sessions'
 * skills are cached per process, so without it the change is invisible until a restart.
 *
 * Three facts, not one: `sessions` is how many conversations were actually reloaded, `failed` how
 * many could not be (a broken session must not deny the new state to the healthy ones), and
 * `reloaded` is whether *every* live conversation converged - `failed === 0`, not a constant. A
 * caller that read only `sessions` would take a partial reload for a whole one.
 */
export async function reloadPlugins(registry: SessionRegistry): Promise<Record<string, unknown>> {
  const { reloaded, failed } = await registry.reloadPlugins()
  logLine(`plugin state reloaded for ${String(reloaded)} session(s)${failed > 0 ? `; ${String(failed)} failed` : ''}`)
  return { reloaded: failed === 0, sessions: reloaded, failed }
}
