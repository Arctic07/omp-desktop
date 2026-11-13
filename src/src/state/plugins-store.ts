/**
 * The plugins a workspace sees, the consent this application remembers, the marketplaces they came
 * from, and one plugin's own settings.
 *
 * Five reads, because the host answers them separately and they change for different reasons: the
 * installation list is per workspace, the consent grants are per workspace, the marketplace registry
 * and the catalogue are process-wide, and one plugin's settings are per installation. Each is a
 * resource of its own, so a write to one does not invalidate the others.
 *
 * Every list write answers with the whole refreshed view — never an acknowledgement — because a
 * write changes what the page shows in more than one place. A caller adopts that answer.
 *
 * The long installs report progress on their own event channel rather than in a command's answer,
 * because an install outlives the request that started it; that is what `pluginTaskStore` holds, and
 * `startPluginWiring` is what subscribes to it — once for the process, like the session wiring.
 */

import { subscribe } from '@/api/client'
import { toApiError, type ApiError } from '@/api/client'
import {
  PLUGIN_EVENTS,
  addMarketplace,
  cancelPluginTask,
  checkPluginUpdates,
  enginePlugins,
  inspectPluginPackage,
  installPluginPackage,
  installPluginSource,
  installPluginUrl,
  previewPluginInstallSource,
  marketplacePlugins,
  marketplaces,
  pluginConfig,
  pluginEngineInfo,
  pluginGrants,
  reloadPlugins,
  removeMarketplace,
  resetPluginConfig,
  scaffoldPlugin,
  setPluginConfigValue,
  setPluginEnabled,
  setPluginFeature,
  setPluginGrant,
  uninstallPlugin,
  updateMarketplace,
  updatePluginSwitch,
  upgradePlugin,
} from '@/api/plugins'
import type { PluginTemplate } from '@/api/plugins'
import type {
  EngineMarketplaceRow,
  EngineMarketplacesView,
  EnginePluginEngineInfo,
  EnginePluginReloadResult,
  EnginePluginSettings,
  EnginePluginSwitchedSource,
  EnginePluginUpdate,
  InspectPackageView,
  JsonObject,
  MarketplacePluginRow,
  PluginGrantRow,
  PluginInstallPreview,
  PluginNoticeEvent,
  PluginProcessesView,
  PluginPromptEvent,
  PluginRow,
  PluginTaskEvent,
  PluginsView,
} from '@/api/plugins-types'
import { BUILTIN_MARKETPLACE_SOURCE, isBuiltinMarketplace } from '@/lib/plugin-market'
import { pluginSettingsKey, pluginSettingsTarget } from '@/lib/plugin-settings-key'
import {
  installationsToConfirm,
  installationGranted,
  pluginRowKey,
} from '@/state/plugin-grant-rules'
import { createKeyedResource, createResource, createWorkspaceResource } from '@/state/resource'
import { createStore } from '@/state/store'
import { applyPluginProcessEvent, retainActivatedViews } from '@/state/plugin-process'
import { reconcileSlots } from '@/state/plugin-slots'
import { showPluginNotice } from '@/state/plugin-notice'
import { showPluginPrompt } from '@/state/plugin-prompt'
import { workspaceStore } from '@/state/workspace-store'

/* ------------------------------------------------------------- installations */

/**
 * The installation list, read once per workspace - **with one retry**.
 *
 * The first read of a process can lose its transport without the read being wrong: the application's
 * IPC is a custom protocol that falls back to `postMessage` when a fetch fails, and a reload leaves
 * the old callbacks behind for a moment (`Couldn't find callback id …`). A resource keeps its last
 * value on failure, but a *first* failure has nothing to keep, and the projection then holds no pages
 * - which is what removed 终端 from the "+" menu for the rest of the run (2026-10-29, user
 * report). One retry after a beat turns that into a read that simply took two attempts.
 */
async function fetchPlugins(workspaceId: number | null): Promise<PluginsView> {
  try {
    return await enginePlugins(workspaceId)
  } catch {
    await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_MS))
    return await enginePlugins(workspaceId)
  }
}

/** How long the second attempt waits: long enough for a reload's IPC bridge to settle. */
const RETRY_AFTER_MS = 250

/** What the shell (rail, menu, plugin pages) reads: the conversation's active workspace. */
export const pluginsResource = createWorkspaceResource<PluginsView>(fetchPlugins)

/**
 * What plugin management and the marketplace read: their own scope picker.
 *
 * They must not share the shell's resource. Choosing workspace B in settings is not a statement that
 * the conversation moved to B, yet a shared read would recompute the rail's plugin pages and prune
 * A's open tabs. One resource per surface keeps the shell on its conversation while each page
 * answers for the directory it displays.
 */
export const settingsPluginsResource = createWorkspaceResource<PluginsView>(fetchPlugins)
export const marketPluginsResource = createWorkspaceResource<PluginsView>(fetchPlugins)

export function readPlugins(workspaceId: number | null, force = false): Promise<void> {
  return pluginsResource.read(workspaceId, { force })
}

export function readSettingsPlugins(workspaceId: number | null, force = false): Promise<void> {
  return settingsPluginsResource.read(workspaceId, { force })
}

export function readMarketPlugins(workspaceId: number | null, force = false): Promise<void> {
  return marketPluginsResource.read(workspaceId, { force })
}

/**
 * Re-read the shell's registry after a write that names the machine-wide scope.
 *
 * The shell reads the rail's active workspace, not the picker, and the keyed resource refuses a
 * write whose key differs. A user-scope installation is active in every workspace, so the shell's
 * own key must be asked again; a project-scope write already reaches the shell when the two keys
 * agree, and must not touch it otherwise.
 */
function refreshShellAfterUserWrite(workspaceId: number | null): void {
  if (workspaceId !== null) return
  const active = workspaceStore.get().activeId
  if (active !== null) void readPlugins(active, true)
}

/**
 * One list write: adopt the host's own answer, or hand back the refusal.
 *
 * The answer belongs to the workspace the write named. The keyed resource drops an answer that
 * arrived after the page moved to another scope, so the rows on screen always belong to the scope
 * the reader is looking at.
 */
async function writePlugins(
  workspaceId: number | null,
  run: () => Promise<PluginsView>,
): Promise<ApiError | null> {
  try {
    const view = await run()
    // A write belongs to every surface currently showing that key; the keyed resource drops it for
    // a surface that has moved elsewhere. This write owns no MCP handle: the MCP page re-reads its
    // own workspace when it is shown (`McpSection`), so a plugin change cannot retarget a page
    // that was looking at another scope.
    settingsPluginsResource.adopt(view, workspaceId)
    marketPluginsResource.adopt(view, workspaceId)
    pluginsResource.adopt(view, workspaceId)
    refreshShellAfterUserWrite(workspaceId)
    return null
  } catch (error) {
    return toApiError(error)
  }
}

/**
 * Turn one installation on or off.
 *
 * `targetId` is the engine's own handle for the installation (`row.installId` for a marketplace
 * install, the package name otherwise), never the plugin id a row is keyed by — the page reads it
 * from `pluginTargetId`.
 */
export function writePluginEnabled(
  workspaceId: number | null,
  targetId: string,
  enabled: boolean,
  scope: string,
): Promise<ApiError | null> {
  return writePlugins(workspaceId, () => setPluginEnabled(workspaceId, targetId, enabled, scope))
}

/** Remove one installation, addressed by the same engine handle. */
export function writePluginUninstall(
  workspaceId: number | null,
  targetId: string,
  scope: string,
): Promise<ApiError | null> {
  return writePlugins(workspaceId, () => uninstallPlugin(workspaceId, targetId, scope))
}

/** Toggle one optional feature of an installation; the host writes the engine's enabled list. */
export function writePluginFeature(
  workspaceId: number | null,
  targetId: string,
  feature: string,
  enabled: boolean,
  scope: string,
): Promise<ApiError | null> {
  return writePlugins(workspaceId, () =>
    setPluginFeature(workspaceId, targetId, feature, enabled, scope),
  )
}

/**
 * One install-shaped write: the list write, then the grant for what it added.
 *
 * The snapshot is taken before the call because "what did this write add" is a set difference on
 * the rows, and after it the answer is already adopted over the old list.
 */
async function writeInstalling(
  workspaceId: number | null,
  run: () => Promise<PluginsView>,
): Promise<ApiError | null> {
  const before = await currentRowKeys(workspaceId)
  const error = await writePlugins(workspaceId, run)
  if (error === null && before !== null) await grantAdded(workspaceId, before)
  return error
}

/** Upgrade one installation by its engine handle, or every one when `targetId` is null. */
export function writePluginUpgrade(
  workspaceId: number | null,
  targetId: string | null,
  scope: string | null,
): Promise<ApiError | null> {
  return writeInstalling(workspaceId, () => upgradePlugin(workspaceId, targetId, scope))
}

export function writePluginInstallSource(
  workspaceId: number | null,
  source: string,
  scope: string,
  force = false,
): Promise<ApiError | null> {
  return writeInstalling(workspaceId, () => installPluginSource(workspaceId, source, scope, force))
}

/** What a source install would do, without doing it; null when the host refused the source. */
export async function previewPluginInstallFile(
  workspaceId: number | null,
  source: string,
  scope: string,
  force: boolean,
): Promise<{ preview: PluginInstallPreview | null; error: ApiError | null }> {
  try {
    return { preview: await previewPluginInstallSource(workspaceId, source, scope, force), error: null }
  } catch (error) {
    return { preview: null, error: toApiError(error) }
  }
}

/** Install or upgrade from a package file; the host reports the unpacking as a task event. */
export function writePluginInstallPackage(
  workspaceId: number | null,
  path: string,
  scope: string,
): Promise<ApiError | null> {
  return writeInstalling(workspaceId, () => installPluginPackage(workspaceId, path, scope))
}

/** Install or upgrade from a URL; a malformed or missing digest is refused before any download. */
export function writePluginInstallUrl(
  workspaceId: number | null,
  url: string,
  sha256: string,
  scope: string,
): Promise<ApiError | null> {
  return writeInstalling(workspaceId, () => installPluginUrl(workspaceId, url, sha256, scope))
}

/** What a source switch left behind, as the page states it. */
export interface PluginSwitchOutcome {
  /** The host's own account of the switch; null when the write was refused. */
  switched: EnginePluginSwitchedSource | null
  error: ApiError | null
}

/**
 * Move one installation to another marketplace's version.
 *
 * The write takes the plugin id, not the install handle: the host resolves the current installation
 * itself, because the two steps it runs (uninstall, then install `pluginId@marketplace`) have
 * different addresses. The answer carries the list as it stands afterwards, and whether a failed
 * install was rolled back to the source it came from.
 */
export async function writePluginSwitch(
  workspaceId: number | null,
  pluginId: string,
  scope: string,
  targetMarketplace: string,
): Promise<PluginSwitchOutcome> {
  const before = await currentRowKeys(workspaceId)
  try {
    const view = await updatePluginSwitch(workspaceId, pluginId, scope, targetMarketplace)
    const list = { plugins: view.plugins }
    settingsPluginsResource.adopt(list, workspaceId)
    marketPluginsResource.adopt(list, workspaceId)
    pluginsResource.adopt(list, workspaceId)
    refreshShellAfterUserWrite(workspaceId)
    if (before !== null) await grantAdded(workspaceId, before)
    return { switched: view.switched, error: null }
  } catch (error) {
    return { switched: null, error: toApiError(error) }
  }
}

/**
 * Read a package file without installing it.
 *
 * Not a resource: the answer belongs to the path the reader picked in this interaction, and nothing
 * else in the page reads it, so caching it under one key would only keep a stale card alive.
 */
export async function inspectPluginPackageFile(
  path: string,
): Promise<{ inspection: InspectPackageView | null; error: ApiError | null }> {
  try {
    return { inspection: await inspectPluginPackage(path), error: null }
  } catch (error) {
    return { inspection: null, error: toApiError(error) }
  }
}

/**
 * Write one authoring template into a folder the reader picked.
 *
 * A template is files on disk and nothing else: it is not an installation, so there is no list to
 * adopt and no consent to record. The answer is the directory the reader opens next.
 */
export async function scaffoldPluginTemplate(
  template: PluginTemplate,
  targetDir: string,
): Promise<{ path: string | null; error: ApiError | null }> {
  try {
    return { path: (await scaffoldPlugin(template, targetDir)).path, error: null }
  } catch (error) {
    return { path: null, error: toApiError(error) }
  }
}

/** Rebuild every live session's plugin state; the host's own report of what it touched. */
export async function reloadPluginState(
  workspaceId: number | null,
): Promise<{ result: EnginePluginReloadResult | null; error: ApiError | null }> {
  try {
    return { result: await reloadPlugins(workspaceId), error: null }
  } catch (error) {
    return { result: null, error: toApiError(error) }
  }
}

/* ------------------------------------------------------------ consent grants */

async function fetchGrants(workspaceId: number | null): Promise<PluginGrantRow[]> {
  return pluginGrants(workspaceId).then((view) => view.grants)
}

/** Plugin management's own grants: same reason as the installation list. */
export const settingsGrantsResource = createWorkspaceResource<PluginGrantRow[]>(fetchGrants)
/** The marketplace's own grants: same reason as the installation list. */
export const marketGrantsResource = createWorkspaceResource<PluginGrantRow[]>(fetchGrants)

export function readSettingsGrants(workspaceId: number | null, force = false): Promise<void> {
  return settingsGrantsResource.read(workspaceId, { force })
}

export function readMarketGrants(workspaceId: number | null, force = false): Promise<void> {
  return marketGrantsResource.read(workspaceId, { force })
}

/** Record or revoke the agreement to run one installation's code. */
export async function writeGrant(
  workspaceId: number | null,
  pluginId: string,
  granted: boolean,
  scope: string,
): Promise<ApiError | null> {
  try {
    const view = await setPluginGrant(workspaceId, pluginId, granted, scope)
    // Same rule as a list write: a grant belongs to the workspace it was recorded in, and each
    // surface that is showing that workspace adopts it.
    settingsGrantsResource.adopt(view.grants, workspaceId)
    marketGrantsResource.adopt(view.grants, workspaceId)
    return null
  } catch (error) {
    return toApiError(error)
  }
}

/** Whether this installation's code has been agreed to, keyed the way the host keys a grant. */
export const isGranted = installationGranted

/**
 * Record one installation's confirmation and switch it on: the two writes the dialog used to make.
 *
 * The order is the host's: `set_grant` is what answers the enable gate, so enabling first would be
 * refused. The grant is written even for a row the host left enabled, because the audit reads it.
 * One function for the two surfaces that used to carry their own copy (`PluginsSection`,
 * `PluginMarketPage`).
 *
 * `targetId` is the caller's `pluginTargetId(row)`: the engine handle for a marketplace row, the
 * package name for an npm or linked one. It is passed in rather than derived here because the rule
 * is the rows module's, and `state/` must not depend on a settings section.
 */
export async function writeConsent(
  workspaceId: number | null,
  row: Pick<PluginRow, 'id' | 'scope'>,
  targetId: string,
): Promise<ApiError | null> {
  const grantError = await writeGrant(workspaceId, row.id, true, row.scope)
  if (grantError !== null) return grantError
  return writePluginEnabled(workspaceId, targetId, true, row.scope)
}

/** A plugin's own key in the page's maps: an id is only unique within its scope. */
export const pluginKey = pluginRowKey

/**
 * The rows the workspace held before a write, read from the host rather than from a page's cache.
 *
 * A page's resource answers for the key it is showing, which is not necessarily the key being
 * written; a snapshot taken from it could diff against another workspace's rows. `null` means the
 * read failed, and the caller then grants nothing: an install whose "before" list is unknown must
 * not be allowed to look like "everything is new".
 */
async function currentRowKeys(workspaceId: number | null): Promise<Set<string> | null> {
  try {
    return new Set((await enginePlugins(workspaceId)).plugins.map((row) => pluginKey(row)))
  } catch (error) {
    console.error('the plugin list could not be read before a write', toApiError(error))
    return null
  }
}

/**
 * Grants and enables the installations one write *added*, and nothing else.
 *
 * The CLI has no consent step and this application no longer asks either, so a fresh install is
 * left running the way `omp plugin install` leaves it: the grant row is written (the host's enable
 * gate and its audit read it) and a row the host quarantined is switched back on.
 *
 * The scope is the write's own additions. An earlier version swept every unconfirmed row in the
 * workspace, which re-granted and re-enabled installations the user had deliberately withdrawn
 * (`set_grant(false)` disables and forgets), and reversed the host's own widening reconciliation
 * after an upgrade. A withdrawal is a decision, not a gap for the next install to fill.
 *
 * Best-effort by design: the install already happened, so a failed grant is a row left disabled
 * with its switch on screen - not an install to report as failed.
 */
async function grantAdded(workspaceId: number | null, before: Set<string>): Promise<void> {
  try {
    const [view, grants] = await Promise.all([enginePlugins(workspaceId), pluginGrants(workspaceId)])
    for (const row of installationsToConfirm(view.plugins, grants.grants, before)) {
      await setPluginGrant(workspaceId, row.id, true, row.scope)
      if (!row.enabled) await setPluginEnabled(workspaceId, row.installId ?? row.id, true, row.scope)
    }
    const final = await enginePlugins(workspaceId)
    settingsPluginsResource.adopt(final, workspaceId)
    marketPluginsResource.adopt(final, workspaceId)
    pluginsResource.adopt(final, workspaceId)
    refreshShellAfterUserWrite(workspaceId)
  } catch (error) {
    console.error('a plugin was installed but its grant could not be recorded', toApiError(error))
  }
}

/* --------------------------------------------------------------- marketplaces */

export const marketplacesResource = createResource<EngineMarketplaceRow[]>(() =>
  marketplaces().then((view: EngineMarketplacesView) => view.marketplaces),
)

export const catalogueResource = createResource<MarketplacePluginRow[]>(() =>
  marketplacePlugins(null).then((view) => view.plugins),
)

export function readMarketplaces(force = false): Promise<void> {
  return marketplacesResource.read({ force })
}

export function readCatalogue(force = false): Promise<void> {
  return catalogueResource.read({ force })
}

export async function writeMarketplaceAdd(source: string): Promise<ApiError | null> {
  try {
    marketplacesResource.adopt((await addMarketplace(source)).marketplaces)
    return null
  } catch (error) {
    return toApiError(error)
  }
}

/**
 * The one marketplace this build registers without being asked.
 *
 * The registry is the engine's, so the seed is an ordinary `marketplaces_add` — the engine's own
 * classifier resolves the shorthand and fetches the catalogue. One in-flight promise per process:
 * the market page mounts once, but a reload or a second mount must not add the same source twice.
 * A source the reader already removed is added again on the next visit: the built-in marketplace is
 * part of what the page promises, and its own remove control is not drawn.
 */
let builtinMarketplaceSeed: Promise<ApiError | null> | null = null

export function ensureBuiltinMarketplace(): Promise<ApiError | null> {
  builtinMarketplaceSeed ??= (async () => {
    try {
      const current = await marketplaces()
      marketplacesResource.adopt(current.marketplaces)
      if (current.marketplaces.some(isBuiltinMarketplace)) return null
      marketplacesResource.adopt((await addMarketplace(BUILTIN_MARKETPLACE_SOURCE)).marketplaces)
      return null
    } catch (error) {
      return toApiError(error)
    }
  })().finally(() => {
    builtinMarketplaceSeed = null
  })
  return builtinMarketplaceSeed
}

export async function writeMarketplaceRemove(name: string): Promise<ApiError | null> {
  try {
    marketplacesResource.adopt((await removeMarketplace(name)).marketplaces)
    return null
  } catch (error) {
    return toApiError(error)
  }
}

export async function writeMarketplaceUpdate(name: string | null): Promise<ApiError | null> {
  try {
    marketplacesResource.adopt((await updateMarketplace(name)).marketplaces)
    return null
  } catch (error) {
    return toApiError(error)
  }
}

/* --------------------------------------------------------- the engine's report */

export const engineInfoResource = createResource<EnginePluginEngineInfo>(() => pluginEngineInfo())

/* ------------------------------------------------------------- available updates */

interface UpdatesState {
  status: 'idle' | 'checking' | 'ready' | 'error'
  error: ApiError | null
  updates: EnginePluginUpdate[]
}

export const updatesStore = createStore<UpdatesState>({ status: 'idle', error: null, updates: [] })

/** Read what an upgrade-all would move, without changing anything. */
export async function checkUpdates(workspaceId: number | null): Promise<void> {
  updatesStore.set({ status: 'checking', error: null, updates: [] })
  try {
    // The check belongs to a workspace: a project-scope installation is only visible from the
    // registry of the workspace it lives in.
    const view = await checkPluginUpdates(workspaceId)
    updatesStore.set({ status: 'ready', error: null, updates: view.updates })
  } catch (error) {
    updatesStore.set({ status: 'error', error: toApiError(error), updates: [] })
  }
}

/** Drop a check's answer once the upgrades it named have been applied. */
export function clearUpdates(): void {
  updatesStore.set({ status: 'idle', error: null, updates: [] })
}

/* ------------------------------------------------------------ one plugin's settings */

/** Keyed by workspace *and* plugin: an installation is a plugin id at one scope in one project. */
export const pluginSettingsResource = createKeyedResource<string, EnginePluginSettings>((key) => {
  const { workspaceId, id } = pluginSettingsTarget(key)
  return pluginConfig(workspaceId, id)
})

export function readPluginSettings(
  workspaceId: number | null,
  id: string,
  force = false,
): Promise<void> {
  return pluginSettingsResource.read(pluginSettingsKey(workspaceId, id), { force })
}

export async function writePluginSetting(
  workspaceId: number | null,
  id: string,
  key: string,
  value: JsonObject | string | number | boolean | null,
  local = false,
): Promise<ApiError | null> {
  try {
    pluginSettingsResource.adopt(await setPluginConfigValue(workspaceId, id, key, value, local))
    return null
  } catch (error) {
    return toApiError(error)
  }
}

export async function resetPluginSetting(
  workspaceId: number | null,
  id: string,
  key: string | null,
  local = false,
): Promise<ApiError | null> {
  try {
    pluginSettingsResource.adopt(await resetPluginConfig(workspaceId, id, key, local))
    return null
  } catch (error) {
    return toApiError(error)
  }
}

/* ------------------------------------------------------------- long installs */

/**
 * The long operations this process is running, newest first.
 *
 * Bounded like every other long-lived map here: `MAX_TRACKED_TASKS` entries, and a finished task is
 * dropped when the next one arrives. An install is minutes of work, not a stream, so a handful is
 * all a page can be showing.
 */
const MAX_TRACKED_TASKS = 4

export interface TrackedPluginTask {
  taskId: string
  label: string
  kind: PluginTaskEvent['kind']
  stage: string | null
  code: string | null
}

export const pluginTaskStore = createStore<readonly TrackedPluginTask[]>([])

function trackTask(event: PluginTaskEvent): void {
  pluginTaskStore.set((previous) => {
    const settled = event.kind === 'finished' || event.kind === 'failed' || event.kind === 'cancelled'
    const without = previous.filter((task) => task.taskId !== event.taskId)
    if (settled) return without
    const next: TrackedPluginTask = {
      taskId: event.taskId,
      label: event.label,
      kind: event.kind,
      stage: event.stage,
      code: event.code,
    }
    return [next, ...without].slice(0, MAX_TRACKED_TASKS)
  })
}

/** Stop one long install, answering whether it was still in flight. */
export function stopPluginTask(taskId: string): Promise<boolean> {
  return cancelPluginTask(taskId)
}

/* ------------------------------------------------------------- the two events */

let wired = false

/**
 * Subscribe to the plugin channels, once for the process.
 *
 * Registered from the shell rather than by the settings page, because a long install keeps reporting
 * after the page that started it is gone — and a notice a plugin raises while the page is closed is
 * still a notice the reader should see.
 */
export function startPluginWiring(): void {
  if (wired) return
  wired = true
  void subscribe<PluginTaskEvent>(PLUGIN_EVENTS.task, trackTask)
  void subscribe<PluginNoticeEvent>(PLUGIN_EVENTS.notice, showPluginNotice)
  void subscribe<PluginPromptEvent>(PLUGIN_EVENTS.prompt, showPluginPrompt)
  void subscribe<PluginProcessesView>(PLUGIN_EVENTS.process, applyPluginProcessEvent)
  // The list is also the slot lifecycle's input: every answer (a read, or a write's own refreshed
  // view) starts the renderer modules it now serves and ends the ones it stopped serving. The
  // reconcile is idempotent, so a plain refresh changes nothing — and the initial call covers a
  // wiring that starts after the list was already read.
  const syncSlots = () => {
    const rows = pluginsResource.store.get().value?.plugins ?? []
    reconcileSlots(rows)
    retainActivatedViews(rows)
  }
  pluginsResource.store.subscribe(syncSlots)
  syncSlots()
}

/** The workspace a plugin write belongs to, as the shell's own selection. */
export function activeWorkspaceId(): number | null {
  return workspaceStore.get().activeId
}
