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
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { getProjectPluginOverridesPath } from '@oh-my-pi/pi-utils'

import { requireBoolean, requireText, resolveCwd } from './capabilities.ts'
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
  scope: 'user' | 'project' | null = null,
): Promise<ConfigTarget> {
  // The manager's direct read is the copy active at runtime, which is the user-scope one unless a
  // project install shadows it. A caller that named `project` must not be answered with it: the
  // same plugin can be installed in both scopes, and the write has to address the one it named.
  if (scope !== 'project') {
    const direct = await manager.getPlugin(id)
    if (direct !== undefined) return { id, key: direct.name, plugin: direct }
  }

  const summaries = await market.listInstalledPlugins()
  const parsed = parse(id)
  const wanted = parsed === null ? id : parsed.name
  const byId = summaries.filter(candidate => candidate.id === id)
  const candidates = byId.length > 0
    ? byId
    : summaries.filter(candidate => candidate.id.slice(0, candidate.id.lastIndexOf('@')) === wanted)
  // A scope the caller named is never traded for another one: falling back to the first entry would
  // answer a project-scope write with the user-scope copy (or the reverse), and the write would land
  // on an installation the caller did not name. The scope is a property of an *entry*, not of the
  // summary: one summary merges both registries, so its own `scope` says nothing about which copies
  // its `entries` hold.
  const entry =
    scope === null
      ? candidates.find(candidate => candidate.entries[0] !== undefined)?.entries[0]
      : candidates.flatMap(candidate => candidate.entries).find(candidate => candidate.scope === scope)
  if (entry !== undefined) {
    const resolved = await manager.getPlugin(wanted, { path: entry.installPath })
    if (resolved !== undefined) return { id, key: resolved.name, plugin: resolved }
    if (await isDirectory(entry.installPath)) return { id, key: wanted, plugin: null }
  }
  throw new HostError(
    ERROR_CODES.plugin_not_found,
    scope === null
      ? `No plugin is installed as "${id}".`
      : `No plugin is installed as "${id}" at the ${scope} scope.`,
  )
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
): Promise<{ manager: SettingsManager; target: ConfigTarget; cwd: string }> {
  const cwd = resolveCwd(paths, frame.cwd)
  const { manager, market } = await pluginManagers(sdk, cwd)
  const id = requireText(frame.targetId, 'targetId', PLUGIN_ID_MAX).trim()
  try {
    return { manager, target: await resolveConfigTarget(sdk.parsePluginId, manager, market, id), cwd }
  } catch (error) {
    if (error instanceof HostError) throw error
    throw pluginEngineError(`resolve plugin "${id}"`, error)
  }
}

/**
 * The project plugin-overrides document (`<workspace>/.omp/plugin-overrides.json`).
 *
 * The engine reads this file for project-scope settings, features and disabled plugins
 * (`PluginManager.#loadProjectOverrides`) but exposes no writer for it, so the host writes it here
 * for `omp plugin config -l` parity: shape-preserving, one key at a time, with the unknown fields
 * left exactly as the user's file had them. A malformed document is refused rather than
 * overwritten: it is the user's file, and repairing it silently would discard what it held.
 */
type ProjectOverrides = Record<string, unknown> & {
  settings?: Record<string, unknown>
}

async function readProjectOverrides(cwd: string): Promise<ProjectOverrides> {
  const file = getProjectPluginOverridesPath(cwd)
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {}
    throw pluginEngineError('read the project plugin overrides', error)
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw invalidInput('The project plugin overrides file is not a JSON object.')
    }
    return parsed as ProjectOverrides
  } catch (error) {
    if (error instanceof HostError) throw error
    throw invalidInput('The project plugin overrides file is not valid JSON; edit it by hand first.')
  }
}

/**
 * Write the overrides document atomically; the engine reads it while a session may be running.
 *
 * Two things are checked before anything is written, and both are the same rule: this host does not
 * follow a link that decides where the document lands.
 *
 * - The `.omp` directory itself: a checkout that ships it as a symbolic link would otherwise redirect
 *   the write into whatever it points at. A parent that is not a directory is refused rather than
 *   created over.
 * - The temporary file: its name is predictable, and a project's own code runs in this process (a
 *   plugin's slot module, a hook), so a link planted at that exact name would be followed by
 *   `writeFile` and then published by `rename` - an arbitrary overwrite outside the workspace. The
 *   descriptor is opened with `O_EXCL|O_NOFOLLOW` (`'wx'`), which refuses both an existing file and a
 *   link in one step, and the name carries a random suffix so a planted one is not even hit.
 */
async function writeProjectOverrides(cwd: string, overrides: ProjectOverrides): Promise<void> {
  const file = getProjectPluginOverridesPath(cwd)
  const parent = path.dirname(file)
  try {
    const stats = await fs.lstat(parent)
    if (stats.isSymbolicLink()) {
      throw invalidInput(`"${parent}" is a symbolic link; this write refuses to follow it.`)
    }
    if (!stats.isDirectory()) throw invalidInput(`"${parent}" is not a directory.`)
  } catch (error) {
    if (error instanceof HostError) throw error
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw pluginEngineError('inspect the project plugin overrides directory', error)
    }
    await fs.mkdir(parent, { recursive: true })
  }
  const temporary = `${file}.tmp-${String(process.pid)}-${randomUUID()}`
  try {
    // `wx` is the refusal: it fails on an existing path, so a symlink planted at this name is not
    // followed, and `rename` below publishes only a file this call created.
    await fs.writeFile(temporary, `${JSON.stringify(overrides, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    throw pluginEngineError('create the project plugin overrides file', error)
  }
  try {
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw pluginEngineError('publish the project plugin overrides file', error)
  }
}

/** The per-plugin settings block of the overrides document, without trusting its shape. */
function overridesSettings(overrides: ProjectOverrides): Record<string, unknown> {
  return typeof overrides.settings === 'object' && overrides.settings !== null && !Array.isArray(overrides.settings)
    ? overrides.settings
    : {}
}

/** One plugin's project override block, copied so a write never mutates the read document. */
function pluginOverrideBlock(
  overrides: ProjectOverrides,
  name: string,
): { settings: Record<string, unknown>; next: Record<string, unknown> } {
  const all = overridesSettings(overrides)
  const block = typeof all[name] === 'object' && all[name] !== null && !Array.isArray(all[name])
    ? { ...(all[name] as Record<string, unknown>) }
    : {}
  return { settings: { ...all }, next: block }
}

/** Stores one value in the project override block for a plugin. */
async function setLocalSetting(cwd: string, name: string, key: string, value: unknown): Promise<void> {
  const overrides = await readProjectOverrides(cwd)
  const { settings, next } = pluginOverrideBlock(overrides, name)
  next[key] = value
  settings[name] = next
  await writeProjectOverrides(cwd, { ...overrides, settings })
}

/** Removes the named keys from a plugin's project override block. */
async function deleteLocalSetting(cwd: string, name: string, keys: readonly string[]): Promise<void> {
  const overrides = await readProjectOverrides(cwd)
  const { settings, next } = pluginOverrideBlock(overrides, name)
  if (Object.keys(next).length === 0) return
  for (const key of keys) delete next[key]
  if (Object.keys(next).length === 0) delete settings[name]
  else settings[name] = next
  if (Object.keys(settings).length === 0) delete overrides.settings
  else overrides.settings = settings
  await writeProjectOverrides(cwd, overrides)
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
  const { manager, target, cwd } = await settingsContext(paths, sdk, frame)
  const key = requireText(frame.key, 'key', PLUGIN_KEY_MAX).trim()
  const local = frame.local === undefined ? false : requireBoolean(frame.local, 'local')
  const schema = settingSchemaFor(target, key)
  if (frame.value === undefined || frame.value === null) throw invalidInput(`Setting "${key}" requires a value.`)
  if (typeof frame.value === 'string' && frame.value.length > PLUGIN_SETTING_TEXT_MAX) {
    throw invalidInput(`Setting "${key}" is longer than ${String(PLUGIN_SETTING_TEXT_MAX)} characters.`)
  }
  const verdict = sdk.validatePluginSetting(frame.value, schema)
  if (!verdict.valid) throw invalidInput(`Setting "${key}" would not be accepted: ${verdict.error ?? 'invalid value'}`)
  try {
    if (local) await setLocalSetting(cwd, target.key, key, frame.value)
    else await manager.setPluginSetting(target.key, key, frame.value)
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
  const { manager, target, cwd } = await settingsContext(paths, sdk, frame)
  const requested = frame.key === undefined || frame.key === null ? '' : requireText(frame.key, 'key', PLUGIN_KEY_MAX).trim()
  const local = frame.local === undefined ? false : requireBoolean(frame.local, 'local')
  // The values are read before the writes, because the writes are what change the set.
  const values = await manager.getPluginSettings(target.key)
  const attempted = resetKeysFor(target, requested, values)
  try {
    if (local) await deleteLocalSetting(cwd, target.key, attempted)
    else {
      for (const key of attempted) {
        await manager.deletePluginSetting(target.key, key)
      }
    }
  } catch (error) {
    throw pluginEngineError(requested === '' ? 'clear the settings' : `reset "${requested}"`, error)
  }
  await services.settings.flush()
  const view = await configView(manager, target)
  const retained = attempted.filter(key => view.explicit.includes(key))
  return { ...view, retained }
}
