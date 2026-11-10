/**
 * Wire types for the plugin surfaces, mirroring `src-tauri/src/models/plugins.rs`.
 *
 * Names are the Rust types' serialized names verbatim (`rename_all = "camelCase"` plus every
 * explicit `rename`). The one field the host drops before the row crosses into a frontend is
 * `rootPath` — a machine-local path is host material — so it has no place here either.
 *
 * The `omp.desktop` block and a plugin's settings schema stay loosely typed (`JsonObject`): both are
 * the plugin author's own vocabulary, and a page that renders them must not need a change here for
 * a keyword it has never seen. What this side does judge is the permission set, which is closed and
 * lives in `PLUGIN_PERMISSIONS` below.
 */

/** A JSON object as the host carries it: the plugin author's own shape. */
export type JsonObject = Record<string, unknown>

/** Where a plugin came from. */
export interface EnginePluginSource {
  /** `marketplace` | `npm` | `link`. */
  kind: string
  /** What the page shows: `name@marketplace`, or the npm spec / linked path. */
  label: string
  gitCommitSha: string | null
  /** The marketplace this installation came from; null for an npm package or a linked directory. */
  marketplace: string | null
  /**
   * The handle the engine's own commands address this installation by: `name@marketplace`, or null
   * for an npm package or a linked directory. A row's `id` is the plugin, never this.
   */
  installId: string | null
  /** True for the row's own source; `sources[]` carries the candidates that are not installed. */
  installed: boolean
}

/**
 * One source a plugin id is available from: a registered marketplace, the version it publishes, and
 * whether the installation in hand came from it.
 */
export interface EnginePluginSourceOption {
  marketplace: string
  version: string
  /** The marketplace's own readable label, as the host derived it. */
  sourceLabel: string
  installed: boolean
}

/** What a plugin can do inside the agent's process, as the host's factual reading. */
export interface EnginePluginConsent {
  /** True when enabling the plugin means running its code with the agent's own privileges. */
  required: boolean
  /** Tokens (`extension-modules`, `hooks-dir`, …), never sentences: the wording lives here. */
  reasons: string[]
}

/** What a plugin ships that the engine loads. */
export interface EnginePluginCode {
  extensions: number
  baseTools: boolean
  baseHooks: boolean
  hooksDir: boolean
  toolsDir: boolean
  mcpConfig: boolean
  skillsDir: boolean
  commandsDir: boolean
  agentsDir: boolean
  /** The plugin ships `rules/`; the engine can put those rules into the system prompt. */
  rulesDir: boolean
  /** The plugin ships `prompts/`; discovered by the engine, with no dispatch path in this build. */
  promptsDir: boolean
  /** The plugin supplies an LSP configuration; the engine spawns a language server from it. */
  lspConfig: boolean
  /** The same for a debug adapter. */
  dapConfig: boolean
}

/** One plugin's settings as the list summarises them. */
export interface EnginePluginSettingsSummary {
  keys: string[]
  hasSecret: boolean
}

/** One page a plugin contributes: a panel window, a view, a settings destination or a sidebar tab. */
export interface EngineDesktopPage {
  id: string
  /** The page's own title per locale, as the manifest wrote it. */
  title: JsonObject | null
  /** The entry file, `/`-separated and relative to the plugin root. */
  entry: string
  order: number
  width: number | null
  height: number | null
  resizable: boolean | null
  icon: string | null
  /** Where the page is loaded from, or null when it may not be loaded at all. */
  url: string | null
}

/** One work-panel tab a plugin contributes: a tab drawn by one of this application's renderers. */
export interface EngineWorkPanelTab {
  id: string
  title: JsonObject | null
  order: number
  icon: string | null
  /** The renderer token the entry asked for. */
  renderer: string
}

/** The standing reach a plugin declares for each file mode. */
export interface EngineFsScopes {
  read: string[]
  write: string[]
  delete: string[]
}

/** One theme a plugin contributes. */
export interface EnginePluginTheme {
  id: string
  /** Locale → label, as the manifest wrote it. */
  label: JsonObject | null
  /** Whether the plugin says the theme belongs to the dark base theme. */
  dark: boolean | null
  /** Token name → value; every name has passed the host's own validator. */
  tokens: Record<string, string>
  /**
   * The theme's stylesheet, already sanitised and with its `url()` references rewritten by the Rust
   * boundary; null when the theme declares none. Untrusted text: it belongs in a `<style>` text node.
   */
  css: string | null
  /**
   * The theme's declared assets as absolute `omp-plugin://` URLs (on Windows the host form of the
   * same scheme). Display-only: the stylesheet already references them by their rewritten URLs.
   */
  assets: string[]
  /**
   * `theme_css_invalid` when the theme declared a stylesheet (or assets) the Rust boundary refused
   * to read, sanitise or serve; null when nothing it declared failed. Additive: a row from a build
   * that predates it has no field at all, which reads as "no refusal".
   */
  cssError?: string | null
}

/**
 * One command a plugin's resident process contributes (`omp.desktop.contributes.commands`).
 *
 * `id` is both the palette's key and the worker's registry key, so it is what
 * `engine_plugin_command_run` names; the title is a locale → label map the page resolves (a missing
 * translation falls back to the id), and the keywords are search terms, never sentences.
 */
export interface EnginePluginProcessCommand {
  id?: string
  title?: JsonObject | null
  keywords?: string[]
}

/**
 * The resident-process half of the `omp.desktop` block, as the row projects it.
 *
 * Two of these fields are the host's shape only and two are the desktop's own verdict: `available`
 * and `reason` are added by the Rust supervisor, because whether an installation may run a process
 * at all depends on facts (a built-in's verification, a third-party's `plugin.process` grant) that
 * live there. Every field is optional on read: a host build that predates this block must leave the
 * page working rather than fail it, and a row simply has nothing to show.
 */
export interface EnginePluginProcessView {
  /** The package-relative entry (`desktop/main.js`), or null when the plugin declares none. */
  main?: string | null
  /** `onStartup`, `onCommand:<id>`, `onView:<entryId>` — the events this build implements. */
  activationEvents?: string[]
  /** False when the manifest turned the supervisor's crash restarts off; missing reads as true. */
  autoRestart?: boolean
  commands?: EnginePluginProcessCommand[]
  /** False when this installation may not run a process; missing reads as true. */
  available?: boolean
  /**
   * The supervisor's refusal token when `available` is false:
   * `plugin_process_permission_missing` | `plugin_process_builtin_unverified`.
   */
  reason?: string | null
}

/**
 * The renderer module an installation ships (`omp.desktop.renderer` + its two whitelists), as the
 * page receives it.
 *
 * The host projects the manifest's own shape — `path` (package-relative, exactly as written),
 * `actions` and `callMethods`; the Rust boundary resolves that path against the row's root, serves
 * the file from the fixed slot host and adds `url`, `available` and `reason`. `path` being present
 * says nothing about loadability: only `url` does, and `available: false` is the boundary saying
 * this installation may not load a module at all (`reason` is its token, never a sentence). A
 * pre-T3 row carries no `renderer` at all, which reads as `null`: nothing to load, not a failure.
 */
export interface EnginePluginRenderer {
  /** The package-relative entry as the host projected it; diagnostics only, never fetched. */
  path?: string | null
  /** Where the module is fetched from, or null when the boundary could not serve it. */
  url: string | null
  /** The dispatch whitelist, drawn from the closed action vocabulary. */
  actions: string[]
  /** The method names `plugin.call` may reach. */
  callMethods: string[]
  /** False when this build may not load the module; a missing flag reads as true. */
  available: boolean
  /** The refusal token when `available` is false. */
  reason: string | null
}

/** What one `engine_plugin_renderer_call` answered: the worker's own result, verbatim. */
export interface EnginePluginRendererCallResult {
  ok: boolean
  value: unknown
  code: string | null
  message: string | null
}

/** The `omp.desktop` block a plugin declares. */
export interface EngineDesktopBlock {
  schemaVersion: number
  valid: boolean
  reason: string | null
  panels: EngineDesktopPage[]
  views: EngineDesktopPage[]
  settingsDestinations: EngineDesktopPage[]
  sidebarTabs: EngineDesktopPage[]
  workPanelTabs: EngineWorkPanelTab[]
  permissions: string[]
  netDomains: string[]
  /**
   * `omp.desktop.net.anyHost`: the second key beside `netDomains` (API 0.2.0).
   *
   * Additive: a host build from before the field reports none, which reads as "the plugin declared
   * no widening". It is shown as one line under the permission rather than as a list of hosts,
   * because there is no list - that is the whole of what the flag means.
   */
  netAnyHost?: boolean
  fsScopes: EngineFsScopes
  themes: EnginePluginTheme[]
  enginesOmpDesktop: string | null
  i18n: JsonObject | null
  /** Additive: missing on a host build that predates plugin processes. */
  process?: EnginePluginProcessView | null
  /** Additive: missing on a host build that predates renderer slots. */
  renderer?: EnginePluginRenderer | null
}

/** One plugin row as the page receives it: the host's row without `rootPath`. */
export interface PluginRow {
  /**
   * The plugin's own id — the identity every page key and every consent grant is built on. A
   * marketplace install reports the package name, not `name@marketplace`.
   */
  id: string
  /**
   * The handle the engine's commands address this installation by: `name@marketplace` for a
   * marketplace install, null for an npm package or a linked directory (whose `id` is the handle).
   * Null on a marketplace row is a contract violation, not an ordinary state.
   */
  installId: string | null
  name: string
  description: string | null
  /** The manifest's version, or null when it carries none. */
  version: string | null
  /** `user` | `project`. */
  scope: string
  enabled: boolean
  /** True for the plugin this application ships with, verified as such. */
  builtin: boolean
  /** Set when a project install shadows a user install of the same plugin. */
  shadowedBy: string | null
  source: EnginePluginSource
  /** Every source this plugin id is available from, the installed one included. */
  sources: EnginePluginSourceOption[]
  installedAt: string | null
  lastUpdated: string | null
  consent: EnginePluginConsent
  code: EnginePluginCode
  settings: EnginePluginSettingsSummary
  desktop: EngineDesktopBlock | null
  desktopError: string | null
}

/** The plugin list, and the answer to every plugin write. */
export interface PluginsView {
  plugins: PluginRow[]
}

/** One plugin's settings, as the read and every write answer them. */
export interface EnginePluginSettings {
  id: string
  /** The plugin's declared settings, key by key. Empty for a plugin that declares none. */
  schema: JsonObject
  /** Only the keys set explicitly; a key absent here runs on its schema's default. */
  values: JsonObject
  /** `Object.keys(values)`: the keys that carry a value of their own. */
  explicit: string[]
}

/** One plugin's settings schema entry, as the author declared it. */
export interface PluginSettingSchema {
  /** `string` | `number` | `boolean` | `enum`. */
  type: string
  description?: string
  /** The value must never be echoed back to the page. */
  secret?: boolean
  /** The environment variable the engine exposes it as. */
  env?: string
  default?: unknown
  min?: number
  max?: number
  step?: number
  /** An `enum`'s values. */
  values?: string[]
}

/* ------------------------------------------------------------ marketplaces */

export interface EngineMarketplaceRow {
  name: string
  /** What the registry stores as the source: `owner/repo`, or the URL it was added by. */
  sourceUri: string
  /** Host-derived: false when a local source's directory no longer exists; null means unknown. */
  available?: boolean | null
}

export interface EngineMarketplacesView {
  marketplaces: EngineMarketplaceRow[]
}

/**
 * One package file as the host read it before anything is installed.
 *
 * The archive is unpacked into a throwaway directory, bounded and guarded the way an import is, and
 * read for the facts the confirm card states: what the manifest declares, which pages it opens,
 * which hosts it may reach, and whether the package proved itself against its own `checksums.json`.
 * `checksumVerified` false is ordinary for a hand-built package and is stated rather than hidden.
 */
export interface InspectPackageView {
  name: string
  version: string | null
  description: string | null
  /** The permissions this build serves, in the manifest's own order. */
  permissions: string[]
  /** The hosts the manifest declares, as the egress gate reads them. */
  netDomains: string[]
  /** How many pages the `omp.desktop` block declares, across its four lists. */
  pageCount: number
  hasExtensions: boolean
  checksumVerified: boolean
  checksumCount: number
  /** The archive's own digest: what a URL install's `sha256` has to match. */
  sha256: string
}

/**
 * Where a template was written.
 *
 * One directory rather than a file: a template is a whole tree (a manifest, a page, a skill), and
 * what the reader does next is open that directory and edit it. The host refuses a target that is
 * not absolute, sits inside this application's data root, or already holds a directory of the
 * template's name, so nothing here can overwrite work in progress.
 */
export interface PluginScaffoldView {
  /** The directory the template was copied to (`<targetDir>/<template>`). */
  path: string
}

/** One catalogue entry a registered marketplace offers. Everything but the name is optional. */
export interface MarketplacePluginRow {
  name: string
  /** The marketplace the entry was read from. */
  marketplace: string
  description: string | null
  version: string | null
  author: string | null
  homepage: string | null
  repository: string | null
  license: string | null
  category: string | null
  tags: string[]
  /** The install source as one readable label the host derived. */
  source: string
}

export interface MarketplacePluginsView {
  plugins: MarketplacePluginRow[]
}

/* --------------------------------------------------------------- lifecycle */

/** How an update reaches the new version: the engine's own reinstall, or a change of source. */
export type PluginUpdateKind = 'in-place' | 'switch-source'

/**
 * One pending update.
 *
 * `pluginId` is the plugin's identity (what a row's `id` is); `installId` is the engine's handle for
 * the installation the update starts from, which is what the engine's own upgrade takes. A
 * `switch-source` update cannot be applied by that command at all — the engine only upgrades within
 * one `name@marketplace` — so it is a two-step uninstall-and-install instead.
 */
export interface EnginePluginUpdate {
  pluginId: string
  installId: string | null
  /** `user` | `project`: which installation of the plugin the update applies to. */
  scope: string
  from: string
  to: string
  /** The marketplace the new version comes from; null only on a row the host could not resolve. */
  marketplace: string | null
  kind: PluginUpdateKind
}

/**
 * One plugin id the cross-marketplace scan found on several sources, with the version each one
 * publishes.
 *
 * This is the scan's own reading, carried so the answer is complete; what the page draws is the
 * row's `sources[]`, which the list read reports for the same question and keeps beside the
 * installation it belongs to.
 */
export interface EnginePluginUpdateCandidate {
  pluginId: string
  scope: string
  sources: { marketplace: string; version: string }[]
}

export interface EnginePluginUpdatesView {
  updates: EnginePluginUpdate[]
  candidates: EnginePluginUpdateCandidate[]
}

/** What a source switch did, as the host reports it after undoing or completing the two steps. */
export interface EnginePluginSwitchedSource {
  from: string
  to: string
  marketplace: string
  /** True when the install from `marketplace` failed and the previous installation was restored. */
  rolledBack: boolean
}

/** The list as it stands after a source switch, and which switch it was. */
export interface EnginePluginSwitchView {
  plugins: PluginRow[]
  switched: EnginePluginSwitchedSource
}

/** Which external executables the host found, one flag per tool an install may need. */
export interface EnginePluginToolchain {
  bun: boolean
  git: boolean
  npm: boolean
}

/** The engine build this host runs, and the external tools it found on this machine. */
export interface EnginePluginEngineInfo {
  sdkVersion: string
  protocol: number
  toolchain: EnginePluginToolchain
}

/** The host's own report of the rebuild it just ran over the live sessions. */
export interface EnginePluginReloadResult {
  /** True only when every session converged. */
  reloaded: boolean
  sessions: number
  failed: number
}

/* ------------------------------------------------------------ plugin processes */

/** The states the supervisor reports for one installation's resident process. */
export type PluginProcessState = 'stopped' | 'starting' | 'running' | 'crashed'

/**
 * One installation's resident process, as the supervisor holds it.
 *
 * The identity is `(pluginId, scope)`: an id is only unique within its registry, and the same
 * plugin can be installed at both scopes. `reason` is a machine token (a crash class, a protocol
 * mismatch, a budget timeout), never a sentence — the wording lives in `process-rows.ts` and
 * `copy.ts`, and a token this build cannot word is shown as it arrived.
 */
export interface ProcessRow {
  pluginId: string
  /** `user` | `project`. */
  scope: string
  state: PluginProcessState
  /** How many times the supervisor has restarted it after a crash. */
  restarts: number
  pid: number | null
  reason: string | null
  lastExitAt: string | null
}

/** The answer to every process read and every restart: the supervisor's whole table. */
export interface PluginProcessesView {
  processes: ProcessRow[]
}

/**
 * What one contributed command answered.
 *
 * `ok` false is a refusal by the worker or by the gate in front of it, with a stable `code` and a
 * redacted `message`; `ok` true carries whatever the plugin returned (`value`), which this page
 * only ever displays.
 */
export interface EnginePluginCommandRunResult {
  ok: boolean
  value: unknown
  code: string | null
  message: string | null
}

/** One remembered consent grant: an installation's id together with the scope it lives at. */
export interface PluginGrantRow {
  pluginId: string
  /** `user` | `project`. */
  scope: string
  grantedAt: string
}

export interface PluginGrantsView {
  grants: PluginGrantRow[]
}

/* ------------------------------------------------------------- the events */

/** A plugin asking for something outside its standing reach, or for a user decision. */
export interface PluginPromptEvent {
  id: number
  pluginId: string
  pluginName: string
  scope: string
  kind: string
  target: string
}

/** A plugin's own notification, already worded by the plugin. */
export interface PluginNoticeEvent {
  pluginId: string
  pluginName: string
  title: string
  body: string
}

/** One long install's progress, as the desktop reports it while the work runs. */
export interface PluginTaskEvent {
  taskId: string
  label: string
  kind: 'started' | 'progress' | 'finished' | 'failed' | 'cancelled'
  /** `reading` | `unpacking` | `cataloguing` | `installing` | `updating`, or null. */
  stage: string | null
  code: string | null
}
