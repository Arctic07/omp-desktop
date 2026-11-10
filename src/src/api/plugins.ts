/**
 * The plugin commands: the installations a workspace sees, the marketplaces they came from, one
 * plugin's settings, the consent this application remembers, and the long installs' progress.
 *
 * Every list write answers with the whole refreshed view — never an acknowledgement — because a
 * write changes what the page shows in more than one place (a just-disabled plugin stops being
 * served in the same answer, and a shadowing project install changes two rows at once). A caller
 * renders the answer rather than patching its own copy.
 */

import { call } from '@/api/client'
import {
  COMMANDS,
  PLUGIN_NOTICE_EVENT,
  PLUGIN_PROCESS_EVENT,
  PLUGIN_PROMPT_EVENT,
  PLUGIN_TASK_EVENT,
} from '@/api/types'
import type {
  EngineMarketplacesView,
  EnginePluginCommandRunResult,
  EnginePluginEngineInfo,
  EnginePluginReloadResult,
  EnginePluginRendererCallResult,
  EnginePluginSettings,
  EnginePluginSwitchView,
  EnginePluginUpdatesView,
  InspectPackageView,
  JsonObject,
  MarketplacePluginsView,
  PluginGrantsView,
  PluginNoticeEvent,
  PluginProcessesView,
  PluginPromptEvent,
  PluginScaffoldView,
  PluginTaskEvent,
  PluginsView,
} from '@/api/plugins-types'

export type { PluginRow, PluginSettingSchema } from '@/api/plugins-types'

/** The four channels a plugin surface listens on. */
export const PLUGIN_EVENTS = {
  task: PLUGIN_TASK_EVENT,
  notice: PLUGIN_NOTICE_EVENT,
  prompt: PLUGIN_PROMPT_EVENT,
  process: PLUGIN_PROCESS_EVENT,
} as const

export type { PluginNoticeEvent, PluginPromptEvent, PluginTaskEvent }

/* ------------------------------------------------------------------ the list */

export function enginePlugins(workspaceId: number | null): Promise<PluginsView> {
  return call(COMMANDS.enginePlugins, { workspaceId })
}

/** Installs from a source string: a local directory, an npm package, or `name@marketplace`. */
export function installPluginSource(
  workspaceId: number | null,
  source: string,
  scope: string,
): Promise<PluginsView> {
  return call(COMMANDS.enginePluginInstall, { workspaceId, source, scope })
}

/**
 * Installs or upgrades one plugin from a package file the reader picked.
 *
 * The file is unpacked in this process and installed through the engine's marketplace channel, so
 * the answer is the list as it stands afterwards — including a plugin the import refused to
 * upgrade, which stays on the version it had.
 */
export function installPluginPackage(
  workspaceId: number | null,
  path: string,
  scope: string,
): Promise<PluginsView> {
  return call(COMMANDS.enginePluginInstallPackage, { workspaceId, path, scope })
}

/**
 * Installs or upgrades one plugin from a URL with a mandatory `sha256`.
 *
 * A URL source has no local `checksums.json` to fall back on, so the digest is the whole proof of
 * what arrived; the host refuses the call without a well-formed one instead of downloading first.
 */
export function installPluginUrl(
  workspaceId: number | null,
  url: string,
  sha256: string,
  scope: string,
): Promise<PluginsView> {
  return call(COMMANDS.enginePluginInstallUrl, { workspaceId, url, sha256, scope })
}

/** Reads a package file without installing it: the facts the confirm card states. */
export function inspectPluginPackage(path: string): Promise<InspectPackageView> {
  return call(COMMANDS.enginePluginInspectPackage, { path })
}

/**
 * The authoring templates this build ships.
 *
 * The vocabulary is the Rust side's (`services::plugins::scaffold::TEMPLATES`, which refuses any
 * name not in its list), restated here so a picker can be checked against it instead of spelling
 * one branch per name. Adding a template is a change in both places plus its picker label.
 */
export const PLUGIN_TEMPLATES = [
  'panel-basic',
  'agent-tool-basic',
  'skill-pack',
  'renderer-slots-basic',
] as const

export type PluginTemplate = (typeof PLUGIN_TEMPLATES)[number]

/** Copies one authoring template into a folder the reader picked; nothing is installed. */
export function scaffoldPlugin(template: PluginTemplate, targetDir: string): Promise<PluginScaffoldView> {
  return call(COMMANDS.enginePluginScaffold, { template, targetDir })
}

/**
 * Removes one installation.
 *
 * The id is the engine's own handle for the installation — `row.installId` for a marketplace
 * install, the package name for an npm package or a linked directory — never the plugin id a row is
 * keyed by. `pluginTargetId` in `settings/sections/plugins/rows.ts` is the one place that decides it.
 */
export function uninstallPlugin(
  workspaceId: number | null,
  targetId: string,
  scope: string,
): Promise<PluginsView> {
  return call(COMMANDS.enginePluginUninstall, { workspaceId, id: targetId, scope })
}

/** Turns one installation on or off; the id is the same engine handle `uninstallPlugin` takes. */
export function setPluginEnabled(
  workspaceId: number | null,
  targetId: string,
  enabled: boolean,
  scope: string,
): Promise<PluginsView> {
  return call(COMMANDS.enginePluginSetEnabled, { workspaceId, id: targetId, enabled, scope })
}

/** Upgrades one installation by its engine handle, or every one when the id is null. */
export function upgradePlugin(
  workspaceId: number | null,
  targetId: string | null,
  scope: string | null,
): Promise<PluginsView> {
  return call(COMMANDS.enginePluginUpgrade, { workspaceId, id: targetId, scope })
}

/**
 * Moves one installation to another marketplace's version, as two steps the host runs in order.
 *
 * The engine only upgrades within one `name@marketplace`, and one runtime name cannot be installed
 * twice, so the host uninstalls the current installation and installs `<pluginId>@<marketplace>`
 * instead; a failed install is rolled back to the marketplace the installation came from. The answer
 * says whether that rollback happened, so the page can state what is actually on disk.
 */
export function updatePluginSwitch(
  workspaceId: number | null,
  pluginId: string,
  scope: string,
  targetMarketplace: string,
): Promise<EnginePluginSwitchView> {
  return call(COMMANDS.enginePluginUpdateSwitch, {
    workspaceId,
    pluginId,
    scope,
    targetMarketplace,
  })
}

/** Reads what an upgrade-all would move, without changing anything. */
export function checkPluginUpdates(
  workspaceId: number | null,
): Promise<EnginePluginUpdatesView> {
  return call(COMMANDS.enginePluginCheckUpdates, { workspaceId })
}

/** The engine build this host runs, and the external tools it found on this machine. */
export function pluginEngineInfo(): Promise<EnginePluginEngineInfo> {
  return call(COMMANDS.enginePluginEngineInfo)
}

/** Rebuilds every live session's plugin state. */
export function reloadPlugins(workspaceId: number | null): Promise<EnginePluginReloadResult> {
  return call(COMMANDS.enginePluginReload, { workspaceId })
}

/** Stops one long install, answering whether it was still in flight. */
export function cancelPluginTask(taskId: string): Promise<boolean> {
  return call(COMMANDS.pluginTaskCancel, { taskId })
}

/* ------------------------------------------------------------- plugin processes */

/**
 * Every resident plugin process the supervisor holds.
 *
 * The read is per workspace because a project-scope installation is only addressable from the
 * project it lives in; the answer itself is the supervisor's whole table, keyed by
 * `(pluginId, scope)`, not a per-workspace subset.
 */
export function pluginProcesses(workspaceId: number | null): Promise<PluginProcessesView> {
  return call(COMMANDS.enginePluginProcess, { workspaceId })
}

/** Stops one installation's process and starts it again, with the answer's fresh table. */
export function restartPluginProcess(
  workspaceId: number | null,
  pluginId: string,
  scope: string,
): Promise<PluginProcessesView> {
  return call(COMMANDS.enginePluginProcessRestart, { workspaceId, pluginId, scope })
}

/** Activates one plugin event and returns the supervisor's fresh process table. */
export function activatePlugin(
  workspaceId: number | null,
  pluginId: string,
  scope: string,
  event: string,
): Promise<PluginProcessesView> {
  return call(COMMANDS.enginePluginActivate, { workspaceId, pluginId, scope, event })
}

/**
 * Runs one command the manifest contributes, through the installation's resident process.
 *
 * A refusal is not a transport error: the worker answers `ok: false` with its own stable `code`, so
 * the call resolves and the caller states the code beside the row it came from.
 */
export function runPluginCommand(
  workspaceId: number | null,
  pluginId: string,
  scope: string,
  commandId: string,
): Promise<EnginePluginCommandRunResult> {
  return call(COMMANDS.enginePluginCommandRun, { workspaceId, pluginId, scope, commandId })
}

/**
 * One `plugin.call` from a renderer slot component, through the installation's resident process.
 *
 * The method name has already been checked against the row's `callMethods` by the slot host; this
 * is the crossing. A refusal is the worker's own answer (`ok: false` with a stable `code`), so the
 * call resolves and the component states the code rather than failing the slot.
 */
export function callPluginRenderer(
  workspaceId: number | null,
  pluginId: string,
  scope: string,
  method: string,
  params: unknown,
): Promise<EnginePluginRendererCallResult> {
  return call(COMMANDS.enginePluginRendererCall, { workspaceId, pluginId, scope, method, params })
}

/* ------------------------------------------------------------- consent grants */

export function pluginGrants(workspaceId: number | null): Promise<PluginGrantsView> {
  return call(COMMANDS.enginePluginGrants, { workspaceId })
}

/** Records or revokes the user's agreement to run one installation's code. */
export function setPluginGrant(
  workspaceId: number | null,
  pluginId: string,
  granted: boolean,
  scope: string,
): Promise<PluginGrantsView> {
  return call(COMMANDS.enginePluginGrantSet, { workspaceId, pluginId, granted, scope })
}

/* ------------------------------------------------------------- plugin settings */

export function pluginConfig(
  workspaceId: number | null,
  id: string,
): Promise<EnginePluginSettings> {
  return call(COMMANDS.enginePluginConfig, { workspaceId, id })
}

export function setPluginConfigValue(
  workspaceId: number | null,
  id: string,
  key: string,
  value: JsonObject | string | number | boolean | null,
): Promise<EnginePluginSettings> {
  return call(COMMANDS.enginePluginConfigSet, { workspaceId, id, key, value })
}

/** Resets one key, or every key when `key` is null. */
export function resetPluginConfig(
  workspaceId: number | null,
  id: string,
  key: string | null,
): Promise<EnginePluginSettings> {
  return call(COMMANDS.enginePluginConfigReset, { workspaceId, id, key })
}

/* ------------------------------------------------------------------- pages */

/**
 * Opens one panel a plugin declares as a window of its own.
 *
 * The window's size, title and resizability come from the manifest, and the page it loads is served
 * by this application's own protocol; a panel of an installation the desktop is not serving is
 * refused rather than opened.
 */
export function openPluginPanel(
  pluginId: string,
  scope: string,
  panelId: string,
  title: string | null,
): Promise<void> {
  return call(COMMANDS.enginePluginPanelOpen, { pluginId, scope, panelId, title })
}

/**
 * Tells the desktop which workspace the shell is showing, so a plugin page's file reads resolve
 * against it before falling back to the plugin's own package.
 */
export function setPluginWorkspace(workspaceId: number | null): Promise<void> {
  return call(COMMANDS.enginePluginWorkspaceSet, { workspaceId })
}

/**
 * Answers one question a plugin page's call raised; `false` means the question was no longer open
 * (its caller gave up, or the installation was re-published under it), which is an ordinary denial.
 */
export function answerPluginPrompt(id: number, answer: 'deny' | 'once' | 'session'): Promise<boolean> {
  return call(COMMANDS.pluginPromptAnswer, { id, answer })
}

/* --------------------------------------------------------------- marketplaces */

export function marketplaces(): Promise<EngineMarketplacesView> {
  return call(COMMANDS.engineMarketplaces)
}

export function addMarketplace(source: string): Promise<EngineMarketplacesView> {
  return call(COMMANDS.engineMarketplaceAdd, { source })
}

export function removeMarketplace(name: string): Promise<EngineMarketplacesView> {
  return call(COMMANDS.engineMarketplaceRemove, { name })
}

/** Updates one marketplace's catalogue, or every one when `name` is null. */
export function updateMarketplace(name: string | null): Promise<EngineMarketplacesView> {
  return call(COMMANDS.engineMarketplaceUpdate, { name })
}

/** The catalogue entries the store lists, across every marketplace or from one of them. */
export function marketplacePlugins(marketplace: string | null): Promise<MarketplacePluginsView> {
  return call(COMMANDS.engineMarketplacePlugins, { marketplace })
}
