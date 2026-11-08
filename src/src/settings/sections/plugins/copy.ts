import type { PluginTemplate } from '@/api/plugins'
import type { Localized } from '@/lib/i18n'
import { PROCESS_COPY, type ProcessCopy } from '@/settings/sections/plugins/process-copy'
import { STORE_COPY, type PluginStoreCopy } from '@/settings/sections/plugins/store-copy'

/**
 * The plugin page's wording, in both languages.
 *
 * The Chinese is the desktop app's own (`src/components/settings/pluginsCopy.ts` and
 * `pluginStoreCopy.ts`), verbatim; the English is the same tables' English. Nothing here is invented
 * at a call site: a page that needs a sentence reads it from this record, so the two frontends read
 * the same in Chinese.
 *
 * A token the engine reports and this build cannot word (a permission, a consent reason, a source
 * kind) has no entry — the projection in `rows.ts` falls back to the engine's own spelling rather
 * than to a placeholder.
 */
export interface PluginsCopy extends PluginStoreCopy, ProcessCopy {
  loading: string
  loadFailed: string
  retry: string
  writeFailed: string
  writeBusy: string

  /** The line one running install draws; `stage` is already one of `taskStages`' words. */
  taskRunning: (stage: string) => string
  /** What each step of an install is doing, keyed by the host's own stage tokens. */
  taskStages: Readonly<Record<string, string>>
  taskCancel: string

  installedTitle: string
  installedEmptyTitle: string
  installedEmptyDescription: string
  refresh: string
  refreshing: string
  updateCheckAction: string
  updateChecking: string
  updatesNone: string
  updatesFound: (count: number) => string
  upgradeAllAction: string
  reloadAction: string
  reloadDone: (sessions: number) => string
  reloadFailed: (failed: number) => string
  addAction: string

  scopeUser: string
  scopeWorkspace: string
  searchLabel: string
  searchPlaceholderPlugins: string
  searchEmpty: string

  updateBadge: string
  consentRequiredBadge: string
  consentGrantedBadge: string
  shadowedBadge: string
  shadowedHint: string
  /** The badge and the disabled-control reason on a plugin this application ships with. */
  builtinBadge: string
  builtinHint: string
  noDescription: string
  sourceKinds: Readonly<Record<string, string>>
  /** The three states a row's own status can be in, as the engine's answer reads them. */
  statusLabels: Readonly<Record<'enabled' | 'disabled' | 'error', string>>
  scopeLabels: Readonly<Record<string, string>>

  toggleOn: (name: string) => string
  toggleOff: (name: string) => string
  toggleConfirmOn: (name: string) => string
  updateAction: string
  uninstallAction: string
  consentRevoke: string
  cancelAction: string
  closeAction: string
  backAction: string

  consentTitle: (name: string) => string
  consentBody: string
  consentExtensionNote: string
  consentReasonsTitle: string
  consentReasonLabels: Readonly<Record<string, string>>
  consentConfirm: string

  uninstallConfirmTitle: (name: string) => string
  uninstallConfirmBody: string
  uninstallConfirmDataTitle: string
  uninstallConfirmSettings: (count: number) => string
  uninstallConfirmCache: string
  uninstallConfirmAction: string

  installTitle: string
  installLabel: string
  installHint: string
  installPlaceholder: string
  installModeSource: string
  installModeFile: string
  installModeUrl: string
  choosePackageTitle: string
  choosePackageAction: string
  packageInspecting: string
  packagePreviewTitle: string
  packagePages: (count: number) => string
  packageExtensions: string
  packageChecksumOk: (count: number) => string
  packageChecksumMissing: string
  packageShaLabel: string
  urlLabel: string
  urlPlaceholder: string
  urlHint: string
  urlRequired: string
  sha256Label: string
  sha256Hint: string
  sha256Shape: string
  installModeTemplate: string
  templateLabel: string
  templateHint: string
  /** One label per authoring template this build ships (`api/plugins.ts::PLUGIN_TEMPLATES`). */
  templateNames: Readonly<Record<PluginTemplate, string>>
  chooseTargetAction: string
  scaffoldAction: string
  scaffolding: string
  scaffoldDone: (path: string) => string
  installScopeLabel: string
  installAction: string
  installing: string
  sourceRequired: string
  sourceTooLong: string
  installed: (name: string) => string
  uninstalled: (name: string) => string
  upgraded: (name: string) => string
  upgradedAll: string

  /** The update that moves a plugin to another marketplace; its card is the destructive one. */
  switchSourceAction: string
  switchSourceBadge: string
  switchSourceTitle: (name: string) => string
  /** `marketplace` and `current` are marketplace names, `version` the version being installed. */
  switchSourceBody: (marketplace: string, version: string, current: string) => string
  /**
   * What the card calls the installation it would roll back to when the row has no marketplace.
   *
   * A linked or npm install has no market to name, and such an installation can still be swapped for
   * a market one (the cross-market scan compares versions, not sources). Interpolating the empty
   * string there read "roll back to ." (2026-10-27).
   */
  switchSourcePreviousSource: string
  switchSourceGrantNote: string
  switchSourceContinue: string
  switchSourceConfirmTitle: (name: string) => string
  switchSourceConfirmBody: (marketplace: string, version: string, current: string) => string
  switchSourceConfirmHint: string
  switchSourceConfirmAction: string
  switchedSource: (name: string, marketplace: string, version: string) => string
  switchRolledBackTitle: string
  switchRolledBack: (marketplace: string) => string
  /** The overview's own marketplace line, and the list of every source in the detail view. */
  sourceMarketLabel: string
  sourcesTitle: string
  sourceInstalledBadge: string
  /** Stated when a row arrives without the engine handle its writes would need. */
  noInstallHandleHint: string

  detailTitle: string
  overviewTitle: string
  descriptionLabel: string
  versionLabel: string
  sourceLabel: string
  installTimeLabel: string
  updatedTimeLabel: string
  revisionLabel: string
  capabilitiesTitle: string
  capabilityLabels: {
    extensions: (count: number) => string
    baseTools: string
    baseHooks: string
    hooksDir: string
    toolsDir: string
    mcpConfig: string
    skillsDir: string
    commandsDir: string
    agentsDir: string
    rulesDir: string
    promptsDir: string
    lspConfig: string
    dapConfig: string
  }
  capabilitiesNone: string

  permissionsTitle: string
  /** The disclosure on the permissions block: it starts closed, and the count is the row's own. */
  permissionsShow: (count: number) => string
  permissionsHide: string
  permissionIntro: string
  permissionLabels: Readonly<Record<string, string>>
  permissionScopes: Readonly<Record<string, string>>
  permissionDomainsLabel: string
  /** The line that replaces the domain list for a block holding both halves of `net.anyHost`. */
  permissionAnyHostLabel: string
  permissionsNone: string

  diagnosticsTitle: string
  engineSdkVersionLabel: string
  engineProtocolVersionLabel: string
  toolchainLabel: string
  toolchainAvailable: string
  toolchainMissing: string
  engineInfoUnavailable: string
  desktopAbsent: string
  desktopValid: string
  desktopInvalid: string
  desktopReasonLabel: string
  desktopErrorLabel: string
  diagnosticsNone: string

  settingsTitle: string
  settingsHint: string
  settingsReadOnlyHint: string
  settingsNone: string
  settingDefaultBadge: string
  settingSecretHint: string
  settingShowSecret: string
  settingHideSecret: string
  settingSecretStored: string
  settingSecretUnset: string
  settingEnvHint: (env: string) => string
  settingSave: string
  settingSaving: string
  settingReset: string
  settingResetting: string
  settingNumberInvalid: string
  settingToggleOn: (label: string) => string
  settingToggleOff: (label: string) => string

  browseAction: string

  installUnavailableTitle: string
  installUnavailableTool: (tool: string) => string
  installUnavailableGeneric: string
  disableFailedMessage: string
}

export const COPY: Localized<PluginsCopy> = {
  en: {
    ...STORE_COPY.en,
    ...PROCESS_COPY.en,
    loading: 'Reading…',
    loadFailed: 'Could not read the plugins the engine reports.',
    retry: 'Retry',
    writeFailed: 'The host refused this change.',
    writeBusy: 'Saving…',

    taskRunning: (stage) => `Installing ${stage}…`,
    taskStages: {
      reading: 'the package',
      unpacking: 'the package contents',
      cataloguing: 'its catalogue',
      installing: 'it into the engine',
      updating: 'the existing installation',
    },
    taskCancel: 'Stop',

    installedTitle: 'Installed',
    installedEmptyTitle: 'No plugins installed',
    installedEmptyDescription: 'Browse and install plugins to add MCP servers, skills and more.',
    refresh: 'Refresh',
    refreshing: 'Refreshing...',
    updateCheckAction: 'Check for updates',
    updateChecking: 'Checking…',
    updatesNone: 'No plugin has a pending update.',
    updatesFound: (count) =>
      count === 1 ? '1 plugin has an update.' : `${count} plugins have updates.`,
    upgradeAllAction: 'Update all',
    reloadAction: 'Reload plugin state',
    reloadDone: (sessions) =>
      sessions === 1
        ? 'Plugin state reloaded for 1 live session.'
        : `Plugin state reloaded for ${sessions} live sessions.`,
    reloadFailed: (failed) =>
      failed === 1
        ? '1 open session could not reload its plugin state; reopen it to pick the change up.'
        : `${failed} open sessions could not reload their plugin state; reopen them to pick the change up.`,
    addAction: 'Add',

    scopeUser: 'User',
    scopeWorkspace: 'Workspace',
    searchLabel: 'Search plugins',
    searchPlaceholderPlugins: 'Search plugins…',
    searchEmpty: 'No plugins match your search',

    updateBadge: 'Update available',
    consentRequiredBadge: 'Needs confirmation',
    consentGrantedBadge: 'Confirmed',
    shadowedBadge: 'Shadowed',
    builtinBadge: 'Built-in',
    builtinHint:
      'This plugin ships with the application: it cannot be switched off or removed, and the skills it carries follow it.',
    shadowedHint:
      'A project-scope install with the same id takes precedence over this user-scope one.',
    noDescription: 'No description',
    sourceKinds: {
      marketplace: 'Marketplace',
      npm: 'npm package',
      link: 'Local directory',
    },
    statusLabels: {
      enabled: 'Enabled',
      disabled: 'Disabled',
      error: 'Needs attention',
    },
    scopeLabels: {
      user: 'User',
      project: 'Project',
    },

    toggleOn: (name) => `Enable ${name}`,
    toggleOff: (name) => `Disable ${name}`,
    toggleConfirmOn: (name) => `Confirm and enable ${name}`,
    updateAction: 'Update',
    uninstallAction: 'Uninstall',
    consentRevoke: 'Withdraw confirmation',
    cancelAction: 'Cancel',
    closeAction: 'Close',
    backAction: 'Back',

    consentTitle: (name) => `Enable ${name}?`,
    consentBody:
      'This plugin brings code that runs inside the agent process, with the same permissions the agent has. There is no sandbox around it: enabling it lets the parts listed below run, so continue only if you trust where this plugin came from.',
    consentExtensionNote:
      'It ships extension modules, which the host loads into its own process — the highest-risk part of this plugin.',
    consentReasonsTitle: 'What it brings',
    consentReasonLabels: {
      'extension-modules': 'Extension modules (`omp.extensions`) that load into the host process',
      'base-tools': 'Base tools (`omp.tools`) that run in the agent process',
      'base-hooks': 'Base hooks (`omp.hooks`) that run in the agent process',
      'hooks-dir': 'A `hooks/` directory the engine loads',
      'tools-dir': 'A `tools/` directory the engine loads',
      'mcp-config': 'A `.mcp.json`, or a manifest `mcpServers` block, that starts MCP servers',
      'lsp-config':
        'A `.lsp.json` that starts language servers (a marketplace entry’s `lspServers`, materialised by the engine)',
      'dap-config':
        'A `.dap.json` that starts debug adapters (its `dapAdapters`, materialised by the engine)',
      'process-main': 'Starts a resident plugin process',
      'renderer-module': 'Draws its interface inside this window',
      'manifest-unreadable':
        'Its manifest could not be read, so it is treated as if it may carry executable code',
    },
    consentConfirm: 'Confirm and enable',

    uninstallConfirmTitle: (name) => `Uninstall ${name}?`,
    uninstallConfirmBody: 'The plugin’s files and the data listed below are removed.',
    uninstallConfirmDataTitle: 'What is removed',
    uninstallConfirmSettings: (count) => {
      if (count === 0) {
        return 'Plugin settings (none stored)'
      }
      return count === 1 ? 'Plugin settings (1 stored key)' : `Plugin settings (${count} stored keys)`
    },
    uninstallConfirmCache: 'Plugin cache and its desktop panel data.',
    uninstallConfirmAction: 'Uninstall',

    installTitle: 'Install from a source',
    installLabel: 'Source',
    installHint:
      'Paste a local directory, an npm package, or a marketplace entry (`name@marketplace`). The engine decides which one it is; nothing is installed until it accepts it.',
    installPlaceholder: 'path/to/plugin, package-name, or name@marketplace',
    installModeSource: 'Source',
    installModeFile: 'Package file',
    installModeUrl: 'URL',
    choosePackageTitle: 'Choose a plugin package',
    choosePackageAction: 'Choose a file…',
    packageInspecting: 'Reading the package…',
    packagePreviewTitle: 'What this package brings',
    packagePages: (count) => (count === 1 ? '1 desktop page' : `${count} desktop pages`),
    packageExtensions: 'Declares extension modules that run in the agent process',
    packageChecksumOk: (count) =>
      count === 1 ? 'Matches the checksum it ships' : `Matches all ${count} checksums it ships`,
    packageChecksumMissing: 'No checksum: the package does not prove what it contains',
    packageShaLabel: 'SHA-256',
    urlLabel: 'Package URL',
    urlPlaceholder: 'https://example.test/plugin.zip',
    urlHint:
      'The package is downloaded by this application: https only, no credentials, 200 MiB ceiling, 120 s total time.',
    urlRequired: 'Enter a URL.',
    sha256Label: 'SHA-256',
    sha256Hint: 'Required for a URL: it is the only proof of what was downloaded.',
    sha256Shape: 'A SHA-256 is 64 lowercase hexadecimal characters.',
    installModeTemplate: 'Template',
    templateLabel: 'Template',
    templateHint:
      'Copies a starting tree into a folder you pick. Nothing is installed: edit the copy, then install from that folder.',
    templateNames: {
      'panel-basic': 'Panel (HTML page)',
      'agent-tool-basic': 'Agent tool (TypeScript)',
      'skill-pack': 'Skill pack',
      'renderer-slots-basic': 'Renderer slots (composer + fence)',
    },
    chooseTargetAction: 'Choose folder…',
    scaffoldAction: 'Create template',
    scaffolding: 'Writing the template…',
    scaffoldDone: (path) => `Wrote ${path}. Edit it, then install from that folder.`,
    installScopeLabel: 'Install for',
    installAction: 'Install',
    installing: 'Installing…',
    sourceRequired: 'Enter a source.',
    sourceTooLong: 'Keep the source under 512 characters.',
    installed: (name) => `Installed ${name}.`,
    uninstalled: (name) => `Removed ${name}.`,
    upgraded: (name) => `Updated ${name}.`,
    upgradedAll: 'Updated every plugin that had a pending update.',

    switchSourceAction: 'Switch source',
    switchSourceBadge: 'Source switch',
    switchSourceTitle: (name) => `Change where ${name} is installed from`,
    switchSourceBody: (marketplace, version, current) =>
      `The current installation is uninstalled first, then ${version} from ${marketplace} is installed. If that fails, this app tries to roll back to ${current}. The plugin is unavailable while this runs.`,
    switchSourcePreviousSource: 'the previous installation',
    switchSourceGrantNote:
      'Your recorded confirmation stays with the plugin itself, not with the source; it is asked again only if the new version widens its permissions.',
    switchSourceContinue: 'Continue',
    switchSourceConfirmTitle: (name) => `Confirm the source switch for ${name}`,
    switchSourceConfirmBody: (marketplace, version, current) =>
      `One more confirmation: the current installation is uninstalled first, then ${version} from ${marketplace} is installed. If that fails, this app tries to roll back to ${current}.`,
    switchSourceConfirmHint:
      'If the install fails and the rollback fails too, the plugin stays uninstalled: the recorded confirmation is kept and it can be installed again.',
    switchSourceConfirmAction: 'Uninstall and install',
    switchedSource: (name, marketplace, version) =>
      `${name} now comes from ${marketplace}, at ${version}.`,
    switchRolledBackTitle: 'The source switch did not go through.',
    switchRolledBack: (marketplace) =>
      `Nothing changed: the previous installation from ${marketplace} was restored.`,
    sourceMarketLabel: 'Marketplace',
    sourcesTitle: 'Also published by',
    sourceInstalledBadge: 'Installed',
    noInstallHandleHint:
      'The host reported no install handle (name@marketplace) for this installation, so it cannot be changed. Refresh the list and try again.',

    detailTitle: 'Details',
    overviewTitle: 'Overview',
    descriptionLabel: 'Description',
    versionLabel: 'Version',
    sourceLabel: 'Source',
    installTimeLabel: 'Installed',
    updatedTimeLabel: 'Last updated',
    revisionLabel: 'Commit',
    capabilitiesTitle: 'Capabilities',
    capabilityLabels: {
      extensions: (count) =>
        count === 1
          ? 'Loads 1 extension module into the agent process'
          : `Loads ${count} extension modules into the agent process`,
      baseTools: 'Provides base tools the engine loads',
      baseHooks: 'Provides base hooks the engine loads',
      hooksDir: 'Ships a `hooks/` directory the engine loads',
      toolsDir: 'Ships a `tools/` directory the engine loads',
      mcpConfig: 'Ships an `.mcp.json` that adds MCP servers',
      skillsDir: 'Ships a `skills/` directory the engine loads',
      commandsDir: 'Ships a `commands/` directory the engine loads',
      agentsDir: 'Ships an `agents/` directory the engine loads',
      rulesDir:
        'Ships `rules/`: the agent session reads these rules, and an always-apply rule enters its system prompt',
      promptsDir:
        'Ships `prompts/` templates: discovered by this engine, but this build provides no way to run one',
      lspConfig: 'Supplies an LSP configuration; the engine starts a language server from it',
      dapConfig: 'Supplies a debug-adapter configuration the engine starts a process for',
    },
    capabilitiesNone: 'This plugin brings no tools, hooks, skills, commands, agents, rules or prompts.',

    permissionsTitle: 'Permissions',
    permissionsShow: (count) => `Show the ${count} permission${count === 1 ? '' : 's'}`,
    permissionsHide: 'Hide permissions',
    permissionIntro:
      'Every permission is shown as a pair: what it allows, and where its scope is declared in the manifest.',
    permissionLabels: {
      'ui.theme': 'Contribute themes for this desktop’s appearance',
      'ui.theme.css': 'Inject a theme’s stylesheet and the assets it declares',
      'agent.extension': 'Load extension modules',
      'ui.panel': 'Open panels',
      'ui.view': 'Show work-panel views',
      'ui.settings': 'Add settings pages',
      'ui.tab': 'Add sidebar tabs',
      notify: 'Send notifications',
      'clipboard.read': 'Read the clipboard',
      'clipboard.write': 'Write to the clipboard',
      'fs.read': 'Read files',
      'fs.write': 'Write files',
      'fs.delete': 'Delete files',
      'fs.anyPath': 'Reach any path, not only the ones it declares',
      'fs.openDefault': 'Open a file with its system default program',
      'fs.reveal': 'Show a file or folder in your file manager',
      'net.fetch': 'Make network requests',
      'plugin.process': 'Run a resident process of its own',
      'command.register': 'Register commands this application can run',
      'renderer.extension': 'Draw interface inside this window',
      'session.read': 'Read your conversations',
      'session.write': 'Rename and delete your conversations',
      'usage.read': 'Read your token and cost accounting',
      'agent.complete': 'Call a model you pay for',
      'bus.publish': 'Publish messages other plugins can receive',
      'bus.subscribe': 'Receive messages other plugins publish',
      'net.websocket': 'Open WebSocket connections',
      'shell.openExternal': 'Open addresses in your system browser',
      'browser.use': 'Drive this app’s built-in browser',
      'net.anyHost': 'Reach any host, not only the ones it lists',
    },
    permissionScopes: {
      'ui.theme': 'Declared as `omp.desktop.themes`',
      'ui.theme.css':
        'Scope: the `css` and `assets` a theme declares under `omp.desktop.themes` — the stylesheet is sanitised before it is applied, and its assets are served by this application rather than the plugin’s own pages. A declared stylesheet this application refuses is not applied: the theme then paints its tokens only, and the appearance page marks it as unavailable.',
      'agent.extension':
        'Scope: the `omp.extensions` modules the manifest declares, which run with the agent’s own permissions.',
      'ui.panel': 'Scope: the `panels[]` entries the manifest declares.',
      'ui.view': 'Scope: the `views[]` and `workPanelTabs[]` entries the manifest declares.',
      'ui.settings': 'Scope: the `settingsDestinations[]` entries the manifest declares.',
      'ui.tab': 'Scope: the `sidebarTabs[]` entries the manifest declares.',
      notify: 'Scope: in-app and system notifications from this plugin.',
      'clipboard.read': 'Scope: the system clipboard, read access.',
      'clipboard.write': 'Scope: the system clipboard, write access.',
      'fs.read': 'Scope: the files the manifest lists under `fs.read.scope`.',
      'fs.write': 'Scope: the files the manifest lists under `fs.write.scope`.',
      'fs.delete': 'Scope: the files the manifest lists under `fs.delete.scope`.',
      'fs.anyPath':
        'Scope: every path on this machine, when it is declared beside `fs.read`, `fs.write` or `fs.delete` — alone it reaches nothing. It applies to the three together: the workspace root, the plugin’s own package, the credential reject table and any declared scope all stop applying.',
      'fs.openDefault':
        'Scope: one path this plugin names, handed to whatever your system opens that file type with. The reach is the read gate’s — the declared `fs.read.scope`, or your answer for a path outside it (a path inside it by declaration, or by `fs.anyPath`, runs without asking). Two families are refused whatever the manifest declares: the credential names this application never hands out, and program files — an extension the system would *run* rather than display (`.exe`, `.bat`, `.cmd`, `.ps1`, `.js`, `.jar`, `.sh` and the rest of the list).',
      'fs.reveal':
        'Scope: one path this plugin names, shown in your file manager — a folder opens as itself, a file opens where it lives. The same reach and the same two refusals as `fs.openDefault`, but nothing is launched except the file manager.',
      'net.fetch': 'Scope: the host names the manifest lists under `net.domains`.',
      'plugin.process':
        'Scope: the `omp.desktop.main` entry, run by this application as a child process with the plugin’s own code. Built-in plugins run without this permission; a third-party one must declare it.',
      'command.register':
        'Scope: the `omp.desktop.contributes.commands` entries the manifest declares, which this application can run through that process.',
      'renderer.extension':
        'Scope: the `omp.desktop.renderer` module. It draws interface inside your window: its components run beside the page you are reading and can read and change what that page holds. Stylesheets it injects may only use `data:` URLs and cannot `@import`.',
      'session.read':
        'Scope: the conversation list, one conversation’s metadata, and the messages of one conversation — read-only, paged, and a message body only as far as the caller asks for by name. Nothing it reads can be renamed, deleted or written.',
      'session.write':
        'Scope: the conversations you can see, changed for real — a title renamed, or a conversation deleted from disk. It reaches exactly what `session.read` lists and nothing else, and it is a separate permission from that read: a plugin that lists your conversations was not thereby granted the right to remove them. A rename goes through the conversation’s own open session, so one that is not open answers `not_found`; a delete refuses while the conversation is still working.',
      'usage.read':
        'Scope: the token and cost entries this application already computes from the engine’s own session files, one row per model call, inside a window of at most 365 days.',
      'agent.complete':
        'Scope: one completion on the models this application is configured with. High risk — this spends your money at the provider. Asked about the first time it is used, and held to 4 096 output tokens, 20 calls a minute and 2 at a time.',
      'bus.publish':
        'Scope: topics under `plugin:<this plugin>/`, at most 100 messages a second and 64 KiB each.',
      'bus.subscribe':
        'Scope: the topics it subscribes to, across plugins. A resident process only — a plugin page has no channel to receive on.',
      'net.websocket':
        'Scope: the host names the manifest lists under `net.domains`, up to 8 sockets, 256 KiB a frame. The host closes every socket it holds when the plugin is disabled, updated or stopped.',
      'shell.openExternal':
        'Scope: `http`/`https` addresses handed to your system’s own browser. The host name still has to be one the manifest lists under `net.domains`.',
      'browser.use':
        'Scope: this app’s own built-in browser, one page per plugin — never the tab you are reading and never another conversation’s. It can navigate (only to the hosts the manifest lists under `net.domains`), read the page’s accessibility tree, take a screenshot, evaluate an expression in it, read its console, and go back/forward/reload. It shares this app’s browser profile, so a page it opens is a page you are signed in to; there is no cookie, storage or DevTools access in this surface, and no raw protocol channel.',
      'net.anyHost':
        'Scope: every host. Honoured only together with `omp.desktop.net.anyHost: true` in the manifest — the permission without the flag reaches nothing.',
    },
    permissionDomainsLabel: 'Declared domains',
    permissionAnyHostLabel: 'Any host: this plugin does not restrict itself to the names it lists.',
    permissionsNone: 'This plugin declares no permission.',

    diagnosticsTitle: 'Diagnostics',
    engineSdkVersionLabel: 'Engine SDK version',
    engineProtocolVersionLabel: 'Engine protocol',
    toolchainLabel: 'Toolchain',
    toolchainAvailable: 'available',
    toolchainMissing: 'missing',
    engineInfoUnavailable: 'The engine’s own version report could not be read.',
    desktopAbsent: 'This plugin has no `omp.desktop` block; its engine part still loads.',
    desktopValid: 'The desktop manifest is valid.',
    desktopInvalid: 'The desktop manifest was rejected; the engine part still loads.',
    desktopReasonLabel: 'Reason',
    desktopErrorLabel: 'Manifest error',
    diagnosticsNone: 'Nothing to report.',

    settingsTitle: 'Plugin settings',
    settingsHint:
      'Written through the engine’s own settings store, so a value lands where the engine reads it. Nothing here is shown as saved until the engine answers with the value it now holds.',
    settingsReadOnlyHint: 'The plugin is disabled. Its settings are read-only; enable it to make changes.',
    settingsNone: 'This plugin declares no setting.',
    settingDefaultBadge: 'Default',
    settingSecretHint: 'The stored value is not shown; leave the box empty to keep it as it is.',
    settingShowSecret: 'Show',
    settingHideSecret: 'Hide',
    settingSecretStored: 'A value is stored · leave empty to keep it',
    settingSecretUnset: 'No value stored',
    settingEnvHint: (env) => `When unset, the engine falls back to the \`${env}\` environment variable.`,
    settingSave: 'Save',
    settingSaving: 'Saving…',
    settingReset: 'Reset',
    settingResetting: 'Resetting…',
    settingNumberInvalid: 'Enter a number.',
    settingToggleOn: (label) => `Turn on ${label}`,
    settingToggleOff: (label) => `Turn off ${label}`,

    browseAction: 'Browse plugins',

    installUnavailableTitle: 'The installer needs a tool this machine does not have.',
    installUnavailableTool: (tool) =>
      `Installing from this source needs \`${tool}\`, which this machine does not have. A local directory needs nothing extra.`,
    installUnavailableGeneric:
      'Installing from this source needs a tool this machine does not have. A local directory needs nothing extra.',
    disableFailedMessage:
      'The plugin could not be stopped, so nothing changed. Its code may still be running.',
  },
  zh: {
    ...STORE_COPY.zh,
    ...PROCESS_COPY.zh,
    loading: '正在读取…',
    loadFailed: '无法读取引擎报告的插件。',
    retry: '重试',
    writeFailed: '宿主拒绝了这次改动。',
    writeBusy: '保存中…',

    taskRunning: (stage) => `正在${stage}…`,
    taskStages: {
      reading: '读取包',
      unpacking: '解压包内容',
      cataloguing: '写入目录',
      installing: '安装到引擎',
      updating: '更新已有安装',
    },
    taskCancel: '停止',

    installedTitle: '已安装',
    installedEmptyTitle: '尚未安装插件',
    installedEmptyDescription: '浏览并安装插件，以添加 MCP、技能及更多能力。',
    refresh: '刷新',
    refreshing: '刷新中...',
    updateCheckAction: '检查更新',
    updateChecking: '检查中…',
    updatesNone: '没有插件有待更新版本。',
    updatesFound: (count) => `有 ${count} 个插件可以更新。`,
    upgradeAllAction: '全部更新',
    reloadAction: '重载插件状态',
    reloadDone: (sessions) => `插件状态已重载，${sessions} 个在线会话已刷新。`,
    reloadFailed: (failed) => `${failed} 个已打开会话未能重载插件状态，请重开这些会话后再试。`,
    addAction: '添加',

    scopeUser: '用户',
    scopeWorkspace: '工作区',
    searchLabel: '搜索插件',
    searchPlaceholderPlugins: '搜索插件…',
    searchEmpty: '没有匹配的插件',

    updateBadge: '可更新',
    consentRequiredBadge: '待确认',
    consentGrantedBadge: '已确认',
    shadowedBadge: '已被遮蔽',
    builtinBadge: '内置',
    builtinHint: '这个插件随应用一起提供：不能关闭或卸载，它带的技能随插件状态。',
    shadowedHint: '项目作用域安装了同 ID 的插件，项目级优先，这一条用户级不会生效。',
    noDescription: '暂无描述',
    sourceKinds: {
      marketplace: '市场',
      npm: 'npm 包',
      link: '本地目录',
    },
    statusLabels: {
      enabled: '已启用',
      disabled: '已禁用',
      error: '需要处理',
    },
    scopeLabels: {
      user: '用户级',
      project: '项目级',
    },

    toggleOn: (name) => `启用「${name}」`,
    toggleOff: (name) => `禁用「${name}」`,
    toggleConfirmOn: (name) => `确认并启用「${name}」`,
    updateAction: '更新',
    uninstallAction: '卸载',
    consentRevoke: '撤销确认',
    cancelAction: '取消',
    closeAction: '关闭',
    backAction: '返回',

    consentTitle: (name) => `启用「${name}」？`,
    consentBody:
      '该插件会带进在 agent 进程内运行的代码，权限与 agent 相同，没有沙箱：确认后会运行下面列出的部分。请只在信任该插件来源时继续。',
    consentExtensionNote: '它带扩展模块，会被宿主直接装载进自己的进程——这是该插件风险最高的部分。',
    consentReasonsTitle: '它带进来的东西',
    consentReasonLabels: {
      'extension-modules': '扩展模块（`omp.extensions`），装载进 host 进程',
      'base-tools': '基础工具（`omp.tools`），在 agent 进程中运行',
      'base-hooks': '基础钩子（`omp.hooks`），在 agent 进程中运行',
      'hooks-dir': '引擎会加载的 `hooks/` 目录',
      'tools-dir': '引擎会加载的 `tools/` 目录',
      'mcp-config': '会启动 MCP 服务器的 `.mcp.json`，或插件清单里的 `mcpServers`',
      'lsp-config': '会启动语言服务器的 `.lsp.json`（市场条目里的 `lspServers` 由引擎物化）',
      'dap-config': '会启动调试适配器的 `.dap.json`（市场条目里的 `dapAdapters` 由引擎物化）',
      'process-main': '启动常驻插件进程',
      'renderer-module': '在你的窗口里画界面',
      'manifest-unreadable': '无法读取它的清单，因此按可能带可执行代码处理',
    },
    consentConfirm: '确认并启用',

    uninstallConfirmTitle: (name) => `卸载「${name}」？`,
    uninstallConfirmBody: '将删除该插件的文件，以及下面列出的数据。',
    uninstallConfirmDataTitle: '会删除的数据',
    uninstallConfirmSettings: (count) =>
      count === 0 ? '插件设置（当前没有存储值）' : `插件设置（${count} 个已存的键）`,
    uninstallConfirmCache: '插件缓存与它的桌面面板数据。',
    uninstallConfirmAction: '卸载',

    installTitle: '从来源安装',
    installLabel: '来源',
    installHint:
      '可以粘贴本地目录、npm 包名，或市场条目（`name@marketplace`）。由引擎判断它属于哪一种；引擎接受之前不会安装任何东西。',
    installPlaceholder: '插件目录路径、包名，或 name@marketplace',
    installModeSource: '来源',
    installModeFile: '包文件',
    installModeUrl: 'URL',
    choosePackageTitle: '选择插件包',
    choosePackageAction: '选择文件…',
    packageInspecting: '正在读取包…',
    packagePreviewTitle: '这个包带来什么',
    packagePages: (count) => `${count} 个桌面页面`,
    packageExtensions: '声明了在 agent 进程内运行的扩展模块',
    packageChecksumOk: (count) =>
      count === 1 ? '与包内自带的校验和一致' : `与包内全部 ${count} 个校验和一致`,
    packageChecksumMissing: '没有校验和：这个包无法证明自己的内容',
    packageShaLabel: 'SHA-256',
    urlLabel: '包地址',
    urlPlaceholder: 'https://example.test/plugin.zip',
    urlHint: '由本应用下载：只用 https、不带凭据、上限 200 MiB、总超时 120 秒。',
    urlRequired: '请填写地址。',
    sha256Label: 'SHA-256',
    sha256Hint: 'URL 来源必填：它是下载内容的唯一证明。',
    sha256Shape: 'SHA-256 是 64 位小写十六进制字符。',
    installModeTemplate: '模板',
    templateLabel: '模板',
    templateHint: '把一个起点目录复制到你选的文件夹。不会安装任何东西：改完再从该目录安装。',
    templateNames: {
      'panel-basic': '面板（HTML 页面）',
      'agent-tool-basic': 'agent 工具（TypeScript）',
      'skill-pack': '技能包',
      'renderer-slots-basic': '插槽模块（输入框 + 围栏块）',
    },
    chooseTargetAction: '选择文件夹…',
    scaffoldAction: '生成模板',
    scaffolding: '正在写入模板…',
    scaffoldDone: (path) => `已写入 ${path}。改完后从该目录安装。`,
    installScopeLabel: '安装到',
    installAction: '安装',
    installing: '安装中…',
    sourceRequired: '请填写来源。',
    sourceTooLong: '来源请控制在 512 个字符以内。',
    installed: (name) => `已安装「${name}」。`,
    uninstalled: (name) => `已卸载「${name}」。`,
    upgraded: (name) => `「${name}」已更新。`,
    upgradedAll: '所有有待更新版本的插件都已更新。',

    switchSourceAction: '换源更新',
    switchSourceBadge: '换源',
    switchSourceTitle: (name) => `更换「${name}」的安装来源`,
    switchSourceBody: (marketplace, version, current) =>
      `会先卸载当前安装，再安装 ${marketplace} 上的 ${version}；失败时尝试回滚到 ${current}。安装期间该插件不可用。`,
    switchSourcePreviousSource: '原来的安装',
    switchSourceGrantNote:
      '已记录的确认跟着插件本身，不跟着来源走；只有新版本权限变宽时才会重新确认。',
    switchSourceContinue: '继续',
    switchSourceConfirmTitle: (name) => `确认更换「${name}」的来源`,
    switchSourceConfirmBody: (marketplace, version, current) =>
      `再确认一次：会先卸载当前安装，再安装 ${marketplace} 上的 ${version}；失败时尝试回滚到 ${current}。`,
    switchSourceConfirmHint:
      '如果安装失败且回滚也失败，插件会留在已卸载状态：确认记录保留，可以重新安装。',
    switchSourceConfirmAction: '卸载并安装',
    switchedSource: (name, marketplace, version) =>
      `「${name}」已换源：现在来自 ${marketplace} 的 ${version}。`,
    switchRolledBackTitle: '换源没有完成。',
    switchRolledBack: (marketplace) => `没有任何改动：已恢复原先来自 ${marketplace} 的安装。`,
    sourceMarketLabel: '来源市场',
    sourcesTitle: '也在这些市场提供',
    sourceInstalledBadge: '当前安装',
    noInstallHandleHint:
      '宿主没有报告这次安装的安装句柄（name@marketplace），因此无法修改它。请刷新列表后重试。',

    detailTitle: '详情',
    overviewTitle: '概览',
    descriptionLabel: '描述',
    versionLabel: '版本',
    sourceLabel: '来源',
    installTimeLabel: '安装时间',
    updatedTimeLabel: '最近更新',
    revisionLabel: '提交',
    capabilitiesTitle: '能力清单',
    capabilityLabels: {
      extensions: (count) => `向 agent 进程提供 ${count} 个扩展模块`,
      baseTools: '向 agent 提供基础工具（引擎加载）',
      baseHooks: '向 agent 提供基础钩子（引擎加载）',
      hooksDir: '带一个 `hooks/` 目录，由引擎加载',
      toolsDir: '带一个 `tools/` 目录，由引擎加载',
      mcpConfig: '带一个 `.mcp.json`，会添加 MCP 服务器',
      skillsDir: '带一个 `skills/` 目录，由引擎加载',
      commandsDir: '带一个 `commands/` 目录，由引擎加载',
      agentsDir: '带一个 `agents/` 目录，由引擎加载',
      rulesDir:
        '带 `rules/`：会话会读取这些规则，标为 always-apply 的规则会进入系统提示词',
      promptsDir:
        '带 `prompts/` 提示词模板：本引擎能发现，但本 build 没有调用它的路径',
      lspConfig: '提供 LSP 配置，引擎据此启动语言服务器',
      dapConfig: '提供调试适配器配置，引擎据此启动进程',
    },
    capabilitiesNone: '该插件没有带任何工具、钩子、技能、命令、子代理、规则或提示词。',

    permissionsTitle: '权限',
    permissionsShow: (count) => `展开这 ${count} 项权限`,
    permissionsHide: '收起权限',
    permissionIntro: '每项权限都成对显示：它允许做什么，以及范围写在清单的哪里。',
    permissionLabels: {
      'ui.theme': '为桌面外观贡献主题',
      'ui.theme.css': '注入主题的样式表与它声明的资产',
      'agent.extension': '装载扩展模块',
      'ui.panel': '打开面板',
      'ui.view': '显示工作区视图',
      'ui.settings': '添加设置页',
      'ui.tab': '添加侧栏标签',
      notify: '发送通知',
      'clipboard.read': '读取剪贴板',
      'clipboard.write': '写入剪贴板',
      'fs.read': '读取文件',
      'fs.write': '写入文件',
      'fs.delete': '删除文件',
      'fs.anyPath': '访问任意路径，而不只是它声明的',
      'fs.openDefault': '用系统默认程序打开文件',
      'fs.reveal': '在文件管理器里指出文件或目录',
      'net.fetch': '发起网络请求',
      'plugin.process': '运行自己的常驻进程',
      'command.register': '注册可供本应用运行的命令',
      'renderer.extension': '在本应用的窗口里画界面',
      'session.read': '读取你的会话',
      'session.write': '重命名与删除你的会话',
      'usage.read': '读取你的 token 与费用统计',
      'agent.complete': '调用由你付费的模型',
      'bus.publish': '发布其它插件可以收到的消息',
      'bus.subscribe': '接收其它插件发布的消息',
      'net.websocket': '建立 WebSocket 连接',
      'shell.openExternal': '在系统浏览器里打开地址',
      'browser.use': '驱动本应用内置的浏览器',
      'net.anyHost': '访问任意主机，而不只是它列出的',
    },
    permissionScopes: {
      'ui.theme': '由 `omp.desktop.themes` 声明',
      'ui.theme.css':
        '范围：`omp.desktop.themes` 里各主题声明的 `css` 与 `assets`——样式表在应用前会被清洗，资产由本应用自己的来源服务，不走插件页面。本应用拒绝的样式表不会应用：该主题只画令牌，外观页会标注它的样式表不可用。',
      'agent.extension': '范围：清单里 `omp.extensions` 声明的模块，与 agent 同权运行。',
      'ui.panel': '范围：清单里 `panels[]` 声明的面板。',
      'ui.view': '范围：清单里 `views[]` 与 `workPanelTabs[]` 声明的视图与页签。',
      'ui.settings': '范围：清单里 `settingsDestinations[]` 声明的设置页。',
      'ui.tab': '范围：清单里 `sidebarTabs[]` 声明的侧栏标签。',
      notify: '范围：该插件的应用内与系统通知。',
      'clipboard.read': '范围：系统剪贴板（读取）。',
      'clipboard.write': '范围：系统剪贴板（写入）。',
      'fs.read': '范围：清单 `fs.read.scope` 里列出的文件。',
      'fs.write': '范围：清单 `fs.write.scope` 里列出的文件。',
      'fs.delete': '范围：清单 `fs.delete.scope` 里列出的文件。',
      'fs.anyPath':
        '范围：与 `fs.read`、`fs.write`、`fs.delete` 之一同时声明时，本机上的任意路径——单独声明则什么也访问不到。它对三种模式一并生效：工作区根、插件自身的包、凭据拒绝表以及已声明的 scope 都不再适用。',
      'fs.openDefault':
        '范围：该插件指定的一个路径，交给系统“打开该类型文件”的默认程序。可达范围就是读取闸门：清单 `fs.read.scope` 之内的，或用 `fs.anyPath` 声明的，直接执行；之外的会先问你。有两类文件名无论声明什么权限都会被拒：本应用从不交出的凭据类名字，以及程序文件——系统会“运行”而不是显示的那些扩展名（`.exe`、`.bat`、`.cmd`、`.ps1`、`.js`、`.jar`、`.sh` 等）。',
      'fs.reveal':
        '范围：该插件指定的一个路径，在文件管理器里指出它——目录就打开它自己，文件就打开它所在的目录。可达范围与两类拒绝都与 `fs.openDefault` 相同，但除了文件管理器之外不会启动任何东西。',
      'net.fetch': '范围：清单 `net.domains` 里列出的主机名。',
      'plugin.process':
        '范围：`omp.desktop.main` 指向的入口，由本应用以子进程运行插件自己的代码。内置插件不需要这项权限；第三方插件必须声明。',
      'command.register':
        '范围：清单在 `omp.desktop.contributes.commands` 里声明的命令，本应用可以通过该进程运行它们。',
      'renderer.extension':
        '范围：`omp.desktop.renderer` 指向的模块。它会在你的窗口里画界面：组件就在你正在看的页面里运行，可以读写页面内容。它注入的样式表只能用 `data:` 地址，不能用 `@import`。',
      'session.read':
        '范围：会话列表、单个会话的元数据、以及某个会话的消息——只读、分页，消息正文只在调用方显式指定长度时才返回。它读到的内容既不能改名、删除，也不能写入。',
      'session.write':
        '范围：你能看到的那些会话，改动是真实的——改名，或者把会话从磁盘上删掉。它的可达范围与 `session.read` 列出的完全一致，不多不少；而它是独立的一项权限：能列出你的会话，并不等于被允许删掉它们。重命名走该会话自己的打开实例，所以没有打开的会话会返回 `not_found`；删除则在该会话仍在工作时被拒。',
      'usage.read':
        '范围：本应用已经从引擎自己的会话文件算出的 token 与费用条目，一次模型调用一行，时间窗最大 365 天。',
      'agent.complete':
        '范围：用本应用已配置的模型完成一次补全。高风险——这会花你的钱。首次使用时确认，并限制为每次 4096 输出 token、每分钟 20 次、同时 2 个。',
      'bus.publish': '范围：`plugin:<本插件>/` 下的话题，每秒最多 100 条、每条 64 KiB。',
      'bus.subscribe': '范围：它订阅的话题，可以跨插件。仅限常驻进程——插件页面没有接收通道。',
      'net.websocket':
        '范围：清单 `net.domains` 里列出的主机名，最多 8 条连接、单帧 256 KiB。插件被停用、升级或停止时，宿主会关闭它持有的全部连接。',
      'shell.openExternal':
        '范围：交给系统自带浏览器的 `http`/`https` 地址。主机名仍然必须是清单 `net.domains` 里列出的。',
      'browser.use':
        '范围：本应用内置的浏览器，每个插件一个页面——绝不是你正在看的那一页，也不是别的会话的。它可以导航（只能去清单 `net.domains` 列出的主机）、读页面的无障碍树、截图、在页面里求值、读它的 console，以及前进/后退/刷新。它与本应用共用同一个浏览器配置，所以它打开的页面可能是你已经登录的页面；这个能力面里没有 cookie、storage 或 DevTools 访问，也没有任何原始协议通道。',
      'net.anyHost':
        '范围：任意主机。只有清单里同时写了 `omp.desktop.net.anyHost: true` 才生效——只声明权限而没有这个字段，什么也访问不到。',
    },
    permissionDomainsLabel: '声明的域名',
    permissionAnyHostLabel: '任意主机：该插件不把自己限制在它列出的域名里。',
    permissionsNone: '该插件没有声明任何权限。',

    diagnosticsTitle: '诊断',
    engineSdkVersionLabel: '引擎 SDK 版本',
    engineProtocolVersionLabel: '引擎协议版本',
    toolchainLabel: '工具链',
    toolchainAvailable: '可用',
    toolchainMissing: '缺失',
    engineInfoUnavailable: '无法读取引擎自身的版本报告。',
    desktopAbsent: '该插件没有 `omp.desktop` 块；引擎部分照常加载。',
    desktopValid: '桌面清单校验通过。',
    desktopInvalid: '桌面清单被拒绝；引擎部分照常加载。',
    desktopReasonLabel: '原因',
    desktopErrorLabel: '清单错误',
    diagnosticsNone: '没有需要报告的内容。',

    settingsTitle: '插件设置',
    settingsHint:
      '通过引擎自己的设置存储写入，值落在引擎读取的位置。引擎返回它当前持有的值之前，这里不会把任何内容显示成已保存。',
    settingsReadOnlyHint: '插件当前已禁用，设置只读；启用后即可修改。',
    settingsNone: '该插件没有声明任何设置项。',
    settingDefaultBadge: '默认',
    settingSecretHint: '不回显已保存的值；留空表示保持原值不变。',
    settingShowSecret: '显示',
    settingHideSecret: '隐藏',
    settingSecretStored: '已保存值 · 留空即保持不变',
    settingSecretUnset: '尚未保存值',
    settingEnvHint: (env) => `未显式设置时，引擎回退读取 \`${env}\` 环境变量。`,
    settingSave: '保存',
    settingSaving: '保存中…',
    settingReset: '重置',
    settingResetting: '重置中…',
    settingNumberInvalid: '请填写数字。',
    settingToggleOn: (label) => `打开 ${label}`,
    settingToggleOff: (label) => `关闭 ${label}`,

    browseAction: '浏览插件',

    installUnavailableTitle: '安装所需的工具在本机不可用。',
    installUnavailableTool: (tool) => `该来源需要 \`${tool}\`，本机没有可用的 ${tool}。本地目录安装不受影响。`,
    installUnavailableGeneric: '该来源需要本机没有的安装工具。本地目录安装不受影响。',
    disableFailedMessage: '插件未能停止，本次操作没有生效；它的代码可能仍在运行。',
  },
}
