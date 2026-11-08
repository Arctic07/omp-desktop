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
  marketplacePlugins,
  marketplaces,
  pluginConfig,
  pluginEngineInfo,
  pluginGrants,
  refreshMarketplaces,
  reloadPlugins,
  removeMarketplace,
  resetPluginConfig,
  scaffoldPlugin,
  setPluginConfigValue,
  setPluginEnabled,
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
  PluginNoticeEvent,
  PluginProcessesView,
  PluginPromptEvent,
  PluginRow,
  PluginTaskEvent,
  PluginsView,
} from '@/api/plugins-types'
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
export const pluginsResource = createWorkspaceResource<PluginsView>(async (workspaceId) => {
  try {
    return await enginePlugins(workspaceId)
  } catch {
    await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_MS))
    return await enginePlugins(workspaceId)
  }
})

/** How long the second attempt waits: long enough for a reload's IPC bridge to settle. */
const RETRY_AFTER_MS = 250

export function readPlugins(workspaceId: number | null, force = false): Promise<void> {
  return pluginsResource.read(workspaceId, { force })
}

/**
 * One list write: adopt the host's own answer, or hand back the refusal.
 *
 * The answer belongs to the workspace the write named. A write can outlive the reader's switch to
 * another workspace, and adopting it then would put the old workspace's installations on screen
 * under the new one - where every button would speak about rows that are not there.
 */
function stillOnWorkspace(workspaceId: number | null): boolean {
  return workspaceStore.get().activeId === workspaceId
}

async function writePlugins(
  workspaceId: number | null,
  run: () => Promise<PluginsView>,
): Promise<ApiError | null> {
  try {
    const view = await run()
    if (stillOnWorkspace(workspaceId)) pluginsResource.adopt(view)
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

/** Upgrade one installation by its engine handle, or every one when `targetId` is null. */
export function writePluginUpgrade(
  workspaceId: number | null,
  targetId: string | null,
  scope: string | null,
): Promise<ApiError | null> {
  return writePlugins(workspaceId, () => upgradePlugin(workspaceId, targetId, scope))
}

export function writePluginInstallSource(
  workspaceId: number | null,
  source: string,
  scope: string,
): Promise<ApiError | null> {
  return writePlugins(workspaceId, () => installPluginSource(workspaceId, source, scope))
}

/** Install or upgrade from a package file; the host reports the unpacking as a task event. */
export function writePluginInstallPackage(
  workspaceId: number | null,
  path: string,
  scope: string,
): Promise<ApiError | null> {
  return writePlugins(workspaceId, () => installPluginPackage(workspaceId, path, scope))
}

/** Install or upgrade from a URL; a malformed or missing digest is refused before any download. */
export function writePluginInstallUrl(
  workspaceId: number | null,
  url: string,
  sha256: string,
  scope: string,
): Promise<ApiError | null> {
  return writePlugins(workspaceId, () => installPluginUrl(workspaceId, url, sha256, scope))
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
  try {
    const view = await updatePluginSwitch(workspaceId, pluginId, scope, targetMarketplace)
    if (stillOnWorkspace(workspaceId)) pluginsResource.adopt({ plugins: view.plugins })
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

export const grantsResource = createWorkspaceResource<PluginGrantRow[]>((workspaceId) =>
  pluginGrants(workspaceId).then((view) => view.grants),
)

export function readGrants(workspaceId: number | null, force = false): Promise<void> {
  return grantsResource.read(workspaceId, { force })
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
    // Same rule as a list write: a grant belongs to the workspace it was recorded in.
    if (stillOnWorkspace(workspaceId)) grantsResource.adopt(view.grants)
    return null
  } catch (error) {
    return toApiError(error)
  }
}

/** Whether this installation's code has been agreed to, keyed the way the host keys a grant. */
export function isGranted(
  grants: readonly PluginGrantRow[],
  pluginId: string,
  scope: string,
): boolean {
  return grants.some((grant) => grant.pluginId === pluginId && grant.scope === scope)
}

/** A plugin's own key in the page's maps: an id is only unique within its scope. */
export function pluginKey(plugin: Pick<PluginRow, 'id' | 'scope'>): string {
  return `${plugin.id}\u0000${plugin.scope}`
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

/** Re-read every marketplace. `throttled` is the host's honest half of the answer. */
export async function refreshMarketplaceCatalogue(): Promise<{
  throttled: boolean
  error: ApiError | null
}> {
  try {
    const answer = await refreshMarketplaces()
    marketplacesResource.adopt(answer.marketplaces)
    await readCatalogue(true)
    return { throttled: answer.throttled, error: null }
  } catch (error) {
    return { throttled: false, error: toApiError(error) }
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
  const separator = key.indexOf('\u0000')
  const workspaceId = Number(key.slice(0, separator))
  const id = key.slice(separator + 1)
  return pluginConfig(workspaceId, id)
})

function settingsKey(workspaceId: number | null, id: string): string {
  return `${workspaceId ?? ''}\u0000${id}`
}

export function readPluginSettings(
  workspaceId: number | null,
  id: string,
  force = false,
): Promise<void> {
  return pluginSettingsResource.read(settingsKey(workspaceId, id), { force })
}

export async function writePluginSetting(
  workspaceId: number | null,
  id: string,
  key: string,
  value: JsonObject | string | number | boolean | null,
): Promise<ApiError | null> {
  try {
    pluginSettingsResource.adopt(await setPluginConfigValue(workspaceId, id, key, value))
    return null
  } catch (error) {
    return toApiError(error)
  }
}

export async function resetPluginSetting(
  workspaceId: number | null,
  id: string,
  key: string | null,
): Promise<ApiError | null> {
  try {
    pluginSettingsResource.adopt(await resetPluginConfig(workspaceId, id, key))
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
