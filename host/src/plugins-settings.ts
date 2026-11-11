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
import * as fs from 'node:fs/promises'

import { requireText, resolveCwd } from './capabilities.ts'
import { PLUGIN_ID_MAX, PLUGIN_KEY_MAX, PLUGIN_SETTING_TEXT_MAX } from './constants.ts'
import type { HostPaths } from './env.ts'
import { ERROR_CODES, HostError, invalidInput } from './protocol/errors.ts'
import { pluginEngineError, pluginManagers } from './plugins-market.ts'
import type { PluginIdParser } from './plugins-rows.ts'
import type {
  InstalledPlugin,
  InstalledPluginSummary,
  PluginSettingSchema,
  SdkBundle,
} from './sdk.ts'

/**
 * The plugin a settings command addresses, and the key the engine stores it under.
 *
 * The two are not always the same string: a marketplace plugin is listed as `name@marketplace`
 * while its runtime state - settings included - is keyed by the package name inside the cached
 * install (`PluginManager.setPluginSetting(name, …)`). The id the caller used is kept so the answer
 * can be matched to the row it came from.
 *
 * `plugin` is null when the installation exists but carries no `package.json` - a Claude-format
 * catalogue entry ships `.claude-plugin/plugin.json` instead, which this engine's `PluginManager`
 * does not read. Such a plugin declares no engine settings; the settings commands answer an empty
 * schema rather than reporting the installation as missing, because the registry entry is the fact
 * that it is installed. The key is then the catalogue's name segment, the only name the entry has.
 */
interface ConfigTarget {
  readonly id: string
  readonly key: string
  readonly plugin: InstalledPlugin | null
}

/** The manager methods a settings command uses, named so a test can stand in for the engine. */
interface SettingsManager {
  getPlugin(name: string, options?: { path?: string }): Promise<InstalledPlugin | undefined>
  getPluginSettings(name: string): Promise<Record<string, unknown>>
  setPluginSetting(name: string, key: string, value: unknown): Promise<void>
  deletePluginSetting(name: string, key: string): Promise<void>
}

/** The registry read a settings command uses, named for the same reason. */
interface SettingsMarket {
  listInstalledPlugins(): Promise<InstalledPluginSummary[]>
}

/** Whether one registry entry still names a directory on disk. */
async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory()
  } catch (error) {
    // Only an absent path means "this record is stale". A path that exists but cannot be inspected
    // is a different answer - the installation may be fine - and swallowing it would report a
    // plugin it cannot read as one that is not installed.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Resolves the plugin a settings frame names.
 *
 * Resolution follows the engine's own `omp plugin config validate`: a plugin the user-scope manager
 * knows is taken as-is, and a `name@marketplace` id is resolved through its registry entry's install
 * path, which is the only trusted place a marketplace plugin's package.json lives. A bare name that
 * belongs to an installed marketplace plugin resolves by the same path, because the marketplace
 * entry is where the package name comes from.
 *
 * A registry entry whose install path holds no `package.json` is still an installation: the engine
 * lists Claude-format catalogue entries from their registry record, while this engine's manager
 * cannot load them (`manager.getPlugin` answers undefined). Answering `plugin_not_found` there
 * told every such plugin's page it was missing and left its settings unreadable; the target is
 * finished with a null plugin instead, which the settings view reads as "declares no settings".
 */
export async function resolveConfigTarget(
  parse: PluginIdParser,
  manager: SettingsManager,
  market: SettingsMarket,
  id: string,
): Promise<ConfigTarget> {
  const direct = await manager.getPlugin(id)
  if (direct !== undefined) return { id, key: direct.name, plugin: direct }

  const summaries = await market.listInstalledPlugins()
  const parsed = parse(id)
  const wanted = parsed === null ? id : parsed.name
  const summary = summaries.find(candidate => candidate.id === id)
    ?? summaries.find(candidate => candidate.id.slice(0, candidate.id.lastIndexOf('@')) === wanted)
  const entry = summary?.entries[0]
  if (summary !== undefined && entry !== undefined) {
    const resolved = await manager.getPlugin(wanted, { path: entry.installPath })
    if (resolved !== undefined) return { id, key: resolved.name, plugin: resolved }
    if (await isDirectory(entry.installPath)) return { id, key: wanted, plugin: null }
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
export async function configView(
  manager: SettingsManager,
  target: ConfigTarget,
): Promise<ConfigView> {
  const values = await manager.getPluginSettings(target.key)
  const schema =
    target.plugin === null
      ? {}
      : ((target.plugin.manifest.settings ?? {}) as Record<string, PluginSettingSchema>)
  return { id: target.id, schema, values, explicit: Object.keys(values) }
}

/**
 * The schema a write checks one value against, or the refusal that write earns.
 *
 * A target with no package declares no settings, so no key can be written; the message says that
 * rather than naming a missing key on a plugin that has none. Kept apart from the command so the
 * refusal is assertable without an engine.
 */
export function settingSchemaFor(target: ConfigTarget, key: string): PluginSettingSchema {
  if (target.plugin === null) {
    throw invalidInput(`Plugin "${target.id}" declares no engine settings.`)
  }
  const schema = target.plugin.manifest.settings?.[key]
  if (schema === undefined) {
    throw invalidInput(`Plugin "${target.id}" has no setting named "${key}".`)
  }
  return schema
}

/**
 * The keys one reset deletes.
 *
 * A target with no package declares no settings, so a reset has nothing of its own to clear. It
 * must not fall back to the name-keyed store either: settings are global per plugin name, and a
 * bare catalogue name can belong to another installation's namespace. Deleting nothing is the
 * only answer that cannot touch somebody else's values.
 */
export function resetKeysFor(
  target: ConfigTarget,
  requested: string,
  values: Record<string, unknown>,
): string[] {
  if (target.plugin === null) return []
  return requested !== '' ? [requested] : Object.keys(values)
}

/** The manager pair, the resolved target and the cwd every settings frame starts from. */
async function settingsContext(
  paths: HostPaths,
  sdk: SdkBundle,
  frame: Record<string, unknown>,
): Promise<{ manager: SettingsManager; target: ConfigTarget }> {
  const cwd = resolveCwd(paths, frame.cwd)
  const { manager, market } = await pluginManagers(sdk, cwd)
  const id = requireText(frame.targetId, 'targetId', PLUGIN_ID_MAX).trim()
  try {
    return { manager, target: await resolveConfigTarget(sdk.parsePluginId, manager, market, id) }
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
  const schema = settingSchemaFor(target, key)
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
  // The values are read before the writes, because the writes are what change the set.
  const values = await manager.getPluginSettings(target.key)
  const attempted = resetKeysFor(target, requested, values)
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
