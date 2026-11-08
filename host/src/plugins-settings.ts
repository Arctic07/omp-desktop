/**
 * `plugins_config_list` / `plugins_config_set` / `plugins_config_reset`: one plugin's settings.
 *
 * The schema is the engine's (`manifest.settings`, as its loader parsed it) and so is the value
 * check (`validatePluginSetting`, the rule `omp plugin config validate` runs), so a value this
 * module accepts is a value the engine's tools and hooks will parse. Values are the engine's merged
 * answer too: `getPluginSettings` folds the lock file and the project overrides, which is why
 * `explicit` is exactly the key set of the values returned, and why a reset deletes the keys that
 * are actually set instead of a list this host keeps.
 */

import type { BootServices } from './boot.ts'
import { requireText, resolveCwd } from './capabilities.ts'
import { PLUGIN_ID_MAX, PLUGIN_KEY_MAX, PLUGIN_SETTING_TEXT_MAX } from './constants.ts'
import type { HostPaths } from './env.ts'
import { ERROR_CODES, HostError, invalidInput } from './protocol/errors.ts'
import { pluginEngineError, pluginManagers } from './plugins-market.ts'
import type { InstalledPlugin, MarketplaceManager, PluginManager, PluginSettingSchema, SdkBundle } from './sdk.ts'

/**
 * The plugin a settings command addresses, and the key the engine stores it under.
 *
 * The two are not always the same string: a marketplace plugin is listed as `name@marketplace`
 * while its runtime state - settings included - is keyed by the package name inside the cached
 * install (`PluginManager.setPluginSetting(name, …)`). The id the caller used is kept so the answer
 * can be matched to the row it came from.
 */
interface ConfigTarget {
  readonly id: string
  readonly key: string
  readonly plugin: InstalledPlugin
}

/**
 * Resolves the plugin a settings frame names.
 *
 * Resolution follows the engine's own `omp plugin config validate`: a plugin the user-scope manager
 * knows is taken as-is, and a `name@marketplace` id is resolved through its registry entry's install
 * path, which is the only trusted place a marketplace plugin's package.json lives. A bare name that
 * belongs to an installed marketplace plugin resolves by the same path, because the marketplace
 * entry is where the package name comes from.
 */
async function resolveConfigTarget(
  sdk: SdkBundle,
  manager: PluginManager,
  market: MarketplaceManager,
  id: string,
): Promise<ConfigTarget> {
  const direct = await manager.getPlugin(id)
  if (direct !== undefined) return { id, key: direct.name, plugin: direct }

  const summaries = await market.listInstalledPlugins()
  const parsed = sdk.parsePluginId(id)
  const wanted = parsed === null ? id : parsed.name
  const summary = summaries.find(candidate => candidate.id === id)
    ?? summaries.find(candidate => candidate.id.slice(0, candidate.id.lastIndexOf('@')) === wanted)
  const entry = summary?.entries[0]
  if (summary !== undefined && entry !== undefined) {
    const resolved = await manager.getPlugin(parsed?.name ?? wanted, { path: entry.installPath })
    if (resolved !== undefined) return { id, key: resolved.name, plugin: resolved }
  }
  throw new HostError(ERROR_CODES.plugin_not_found, `No plugin is installed as "${id}".`)
}

/**
 * One plugin's settings as the three config commands answer with them.
 *
 * The intersection with `Record<string, unknown>` keeps the wire shape this module returns while
 * naming `explicit` as the string list it is: the reset path has to read it back (D3).
 */
type ConfigView = Record<string, unknown> & {
  readonly id: string
  readonly schema: Record<string, PluginSettingSchema>
  readonly values: Record<string, unknown>
  /** The keys the engine reports as explicitly set, i.e. the set a reset works from. */
  readonly explicit: string[]
}

/**
 * The settings payload: the schema, the values the engine would hand a tool, and which of them are
 * set.
 *
 * `schema` is passed through as the manifest holds it rather than re-shaped here: the desktop's
 * form and the validator read the same object, so a setting type the engine adds later reaches the
 * page without a second table in this host.
 */
async function configView(manager: PluginManager, target: ConfigTarget): Promise<ConfigView> {
  const values = await manager.getPluginSettings(target.key)
  const schema = (target.plugin.manifest.settings ?? {}) as Record<string, PluginSettingSchema>
  return { id: target.id, schema, values, explicit: Object.keys(values) }
}

/** The manager pair, the resolved target and the cwd every settings frame starts from. */
async function settingsContext(
  paths: HostPaths,
  sdk: SdkBundle,
  frame: Record<string, unknown>,
): Promise<{ manager: PluginManager; target: ConfigTarget }> {
  const cwd = resolveCwd(paths, frame.cwd)
  const { manager, market } = await pluginManagers(sdk, cwd)
  const id = requireText(frame.targetId, 'targetId', PLUGIN_ID_MAX).trim()
  try {
    return { manager, target: await resolveConfigTarget(sdk, manager, market, id) }
  } catch (error) {
    if (error instanceof HostError) throw error
    throw pluginEngineError(`resolve plugin "${id}"`, error)
  }
}

/** `plugins_config_list`: the schema and the current values of one plugin's settings. */
export async function readPluginConfig(
  paths: HostPaths,
  _services: BootServices,
  sdk: SdkBundle,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { manager, target } = await settingsContext(paths, sdk, frame)
  try {
    return await configView(manager, target)
  } catch (error) {
    throw pluginEngineError(`read the settings of "${target.id}"`, error)
  }
}

/**
 * `plugins_config_set`: one value, checked against its own schema before it is written.
 *
 * The check runs here as well as in the desktop because the desktop is not the only caller and a
 * value the schema refuses would otherwise be stored and then ignored by every tool that reads it
 * - a switch that reports success and does nothing.
 */
export async function writePluginConfig(
  paths: HostPaths,
  services: BootServices,
  sdk: SdkBundle,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { manager, target } = await settingsContext(paths, sdk, frame)
  const key = requireText(frame.key, 'key', PLUGIN_KEY_MAX).trim()
  const schema = target.plugin.manifest.settings?.[key]
  if (schema === undefined) {
    throw invalidInput(`Plugin "${target.id}" has no setting named "${key}".`)
  }
  if (frame.value === undefined || frame.value === null) throw invalidInput(`Setting "${key}" requires a value.`)
  if (typeof frame.value === 'string' && frame.value.length > PLUGIN_SETTING_TEXT_MAX) {
    throw invalidInput(`Setting "${key}" is longer than ${String(PLUGIN_SETTING_TEXT_MAX)} characters.`)
  }
  const verdict = sdk.validatePluginSetting(frame.value, schema)
  if (!verdict.valid) throw invalidInput(`Setting "${key}" would not be accepted: ${verdict.error ?? 'invalid value'}`)
  try {
    await manager.setPluginSetting(target.key, key, frame.value)
  } catch (error) {
    throw pluginEngineError(`write "${key}"`, error)
  }
  // The shared settings instance can hold a pending save to the agent directory from an earlier
  // command in this process; a caller that re-reads right after this answer must not race it.
  await services.settings.flush()
  return await configView(manager, target)
}

/**
 * `plugins_config_reset`: drop one setting, or every setting the plugin has.
 *
 * The engine has no "clear every setting" call, and it must not need one: the keys to delete are
 * the keys `getPluginSettings` just reported, and `deletePluginSetting` prunes the plugin's entry
 * when the last key goes. A key that is not set is not an error - deleting it changes nothing, and
 * the answer is the settings that remain.
 *
 * What the engine merges can be wider than what `deletePluginSetting` can delete (spec §5.4): a key
 * that survives the reset is still in effect, so the answer names it in `retained` instead of
 * showing a shorter list with no explanation (D3). `retained` is empty on every reset that really
 * took.
 */
export async function resetPluginConfig(
  paths: HostPaths,
  services: BootServices,
  sdk: SdkBundle,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { manager, target } = await settingsContext(paths, sdk, frame)
  const requested = frame.key === undefined || frame.key === null ? '' : requireText(frame.key, 'key', PLUGIN_KEY_MAX).trim()
  // The keys this reset is asked to drop: the one the frame names, or every key the engine reports
  // as set. Read before the writes, because the writes are what change the set.
  const attempted = requested !== '' ? [requested] : Object.keys(await manager.getPluginSettings(target.key))
  try {
    for (const key of attempted) {
      await manager.deletePluginSetting(target.key, key)
    }
  } catch (error) {
    throw pluginEngineError(requested === '' ? 'clear the settings' : `reset "${requested}"`, error)
  }
  await services.settings.flush()
  const view = await configView(manager, target)
  const retained = attempted.filter(key => view.explicit.includes(key))
  return { ...view, retained }
}
