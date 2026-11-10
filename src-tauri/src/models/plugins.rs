//! The DTOs of the plugin-management payloads: the plugins a workspace sees, the marketplaces they
//! came from, the upgrades available for them, one plugin's settings, what a reload touched, and the
//! consent grants this application remembers.
//!
//! Two shapes exist for a plugin row, and the difference between them is one field. The host reports
//! where a plugin actually lives on this machine (`rootPath`) because that path is what the desktop
//! would open or copy; the page has no use for it, and an absolute path out of the user's home is
//! not something a renderer should hold. So [`PluginRowView`] is what crosses into the frontend and
//! the conversion drops exactly that field - every other value travels as the host wrote it, which
//! is what keeps one vocabulary between the three sides of the IPC contract.
//!
//! The conversion makes one judgement of its own, because it is where the row crosses the trust
//! boundary: the permissions a plugin declares in its `omp.desktop` block are re-checked against the
//! P1 set ([`recheck_desktop`]). The host parses the manifest and decides what the page reads, and
//! this side independently refuses a block that names a permission the desktop does not serve - so
//! an out-of-set permission cannot reach a later capability gateway through a host that validated
//! less strictly. Everything else about the block (`panels`, `views`, `netDomains`, the host's own
//! verdict text) is carried unchanged: refusing is this layer's whole contribution.
//!
//! The rows arrive from the host's own reading of the plugin directory: which files it holds, what
//! its manifest declares, whether its `omp.desktop` block parses. None of that is re-derived here.
//! This module holds field names, the one boundary check above, and nothing that decides what a
//! plugin is.

use serde::{Deserialize, Serialize};
use serde_json::Value;

// The desktop block's own re-check moved to its own file (`rules.md#single-file-line-limit`). The name below is its
// contract with the rest of this module, re-exported here so every existing caller keeps naming it
// through `models::plugins`: this is a module split, not a forwarding layer.
mod desktop;
// The identity rule (`plugin_id` vs. `install_spec`, plan D0) and the update surface (§4.2, §4.3)
// are splits of the same kind: their names are the contract with the rest of the crate.
pub(crate) mod identity;
mod updates;

pub(crate) use desktop::recheck_desktop;
pub(crate) use updates::{EnginePluginUpdatesView, PluginUpdateSwitch, PluginUpdateSwitchView};

// ---- the plugin list ----

/// One installed plugin, as the host reports it.
///
/// `rootPath` is the host-to-desktop field the page never sees (see [`PluginRowView`]). Everything
/// else is the host's own reading of the plugin directory, and this layer only carries it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnginePluginRow {
    /// The plugin's own id - the identity every desktop surface keys by (plan D0). For a
    /// marketplace row this is the name segment of the engine's handle; for an npm or link install
    /// it is the package name itself. [`plugin_id`] is the only reader of that distinction.
    #[serde(default)]
    pub(crate) id: String,
    /// `package.json#omp.name ?? package.json.name`.
    #[serde(default)]
    pub(crate) name: String,
    /// `package.json#omp.description ?? package.json.description`, `null` when it declares neither.
    #[serde(default)]
    pub(crate) description: Option<String>,
    /// `package.json.version`, the authority on what is installed. `null` when the manifest carries
    /// none, which the page renders as no version rather than as a made-up one.
    #[serde(default)]
    pub(crate) version: Option<String>,
    /// `user` | `project`.
    #[serde(default)]
    pub(crate) scope: String,
    #[serde(default)]
    pub(crate) enabled: bool,
    /// Set when a project install shadows a user install of the same plugin; `"project"` or `null`.
    #[serde(default)]
    pub(crate) shadowed_by: Option<String>,
    /// The engine's installation handle (`name@marketplace`), which is what the write commands
    /// address; `null` for an npm or link install, whose package name is the handle already. It is
    /// never an identity: [`plugin_id`] is.
    #[serde(default)]
    pub(crate) install_id: Option<String>,
    #[serde(default)]
    pub(crate) source: EnginePluginSource,
    /// Every marketplace that records or lists this plugin, including the one the row runs from.
    /// Absent from a host that predates the field, which reads as no source list.
    #[serde(default)]
    pub(crate) sources: Vec<EnginePluginSourceOption>,
    /// `null` for an npm/link install: the engine records install timestamps only in the registry a
    /// marketplace install goes through, and inventing one from a file's mtime would be a different
    /// fact reported as the same.
    #[serde(default)]
    pub(crate) installed_at: Option<String>,
    #[serde(default)]
    pub(crate) last_updated: Option<String>,
    /// Where the plugin's files are. Dropped before the row reaches the page.
    #[serde(default)]
    pub(crate) root_path: Option<String>,
    #[serde(default)]
    pub(crate) consent: EnginePluginConsent,
    #[serde(default)]
    pub(crate) code: EnginePluginCode,
    #[serde(default)]
    pub(crate) settings: EnginePluginSettingsSummary,
    /// The plugin's `omp.desktop` block, or `null` when it has none - or when it has one this build
    /// could not read, which is what `desktop_error` then explains.
    #[serde(default)]
    pub(crate) desktop: Option<EngineDesktopBlock>,
    /// Why the `omp.desktop` block could not be read, in the host's own (redacted) words.
    #[serde(default)]
    pub(crate) desktop_error: Option<String>,
    /// Whether this row is one of the built-in plugin installations *and* the marketplace it came
    /// from was verified to be the bundle this application shipped with.
    ///
    /// It is this side's own fact, not the host's, so it never crosses the pipe: the host has no way
    /// to know which marketplace a row's id was written from (its `source` carries a kind and a
    /// label, not a path), and an id is a string a package can choose. Only
    /// `services::plugins::builtin` sets it, and only after it has read the reserved marketplace's
    /// source itself; everything that trusts a built-in plugin - the bridge's first-party answer,
    /// the DTO's `builtin` flag - reads this mark and nothing else.
    #[serde(skip)]
    pub(crate) builtin: bool,
}

/// Where a plugin came from.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnginePluginSource {
    /// `marketplace` | `npm` | `link`.
    #[serde(default)]
    pub(crate) kind: String,
    /// What the page shows for the source: `name@marketplace`, or the npm spec / linked path.
    #[serde(default)]
    pub(crate) label: String,
    /// The marketplace entry's recorded commit, when the install has one.
    #[serde(default)]
    pub(crate) git_commit_sha: Option<String>,
    /// The marketplace this installation came from, for a marketplace install: the *fact* the
    /// built-in protection and the import recycling judge by (plan §4.4). `null` for npm or link,
    /// and absent from a host that predates the field.
    #[serde(default)]
    pub(crate) marketplace: Option<String>,
    /// The engine handle of this installation; the same value as the row's `installId`, kept here
    /// because a source row is what a caller reads when it asks "how is this one acted on".
    #[serde(default)]
    pub(crate) install_id: Option<String>,
    /// Whether this is the installation the row runs from. Always `true` on the row's own source;
    /// the field exists so a source can be read without knowing which list it came from.
    #[serde(default)]
    pub(crate) installed: bool,
}

/// One place a plugin is recorded or listed, as the update/detail surfaces show it (plan §4.1).
///
/// `marketplace` is the source's name, `version` what it declares, `sourceLabel` the handle an
/// installation from it would be recorded under (`<plugin id>@<marketplace>`), and `installed`
/// whether that is the marketplace the row currently runs from. A catalogue that declares no version
/// carries an empty one, which the page renders as no version.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnginePluginSourceOption {
    #[serde(default)]
    pub(crate) marketplace: String,
    #[serde(default)]
    pub(crate) version: String,
    #[serde(default)]
    pub(crate) source_label: String,
    #[serde(default)]
    pub(crate) installed: bool,
}

/// What a plugin can do inside the agent's process, as the host's factual reading of the plugin
/// directory.
///
/// `reasons` holds tokens (`extension-modules`, `hooks-dir`, `mcp-config`, ...), never sentences:
/// the wording lives in the frontend, so a reason can be translated and so this layer never has to
/// interpret the engine's rules to say what one means.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnginePluginConsent {
    /// True when enabling the plugin means running its code with the agent's own privileges.
    #[serde(default)]
    pub(crate) required: bool,
    #[serde(default)]
    pub(crate) reasons: Vec<String>,
}

/// What a plugin ships that the engine loads: the extension modules it declares, and the
/// directories discovery picks up from its root.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnginePluginCode {
    /// How many `omp.extensions` entries the manifest declares.
    #[serde(default)]
    pub(crate) extensions: usize,
    /// The manifest declares `omp.tools` / `omp.hooks` of its own.
    #[serde(default)]
    pub(crate) base_tools: bool,
    #[serde(default)]
    pub(crate) base_hooks: bool,
    /// The plugin root holds a `hooks/`, `tools/`, `skills/`, `commands/`, `agents/`, `rules/` or
    /// `prompts/` directory, or a `.mcp.json`.
    #[serde(default)]
    pub(crate) hooks_dir: bool,
    #[serde(default)]
    pub(crate) tools_dir: bool,
    #[serde(default)]
    pub(crate) mcp_config: bool,
    #[serde(default)]
    pub(crate) skills_dir: bool,
    #[serde(default)]
    pub(crate) commands_dir: bool,
    #[serde(default)]
    pub(crate) agents_dir: bool,
    /// The plugin ships `rules/`: text the engine can place in the session's system prompt.
    #[serde(default)]
    pub(crate) rules_dir: bool,
    /// The plugin ships `prompts/`: templates the engine discovers but this SDK line does not
    /// dispatch. Reported, never promised to run.
    #[serde(default)]
    pub(crate) prompts_dir: bool,
    /// The plugin (or its catalogue entry) supplies an LSP configuration, which the engine turns
    /// into a language-server process. Also a consent reason.
    #[serde(default)]
    pub(crate) lsp_config: bool,
    /// The same for a debug adapter (`.dap.json` / `dapAdapters`).
    #[serde(default)]
    pub(crate) dap_config: bool,
}

/// One plugin's settings as the list summarises them: which keys it declares, and whether any of
/// them is a secret - which is what makes the page mask the value.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnginePluginSettingsSummary {
    #[serde(default)]
    pub(crate) keys: Vec<String>,
    #[serde(default)]
    pub(crate) has_secret: bool,
}

/// One page a plugin contributes: a panel window, a work-panel view, a settings destination or a
/// sidebar tab (spec §3.2, §4.2).
///
/// The host validated the entry against the filesystem and refused the block when it did not hold;
/// this layer re-checks the *shape* every field has to have before it becomes a URL or a filesystem
/// lookup, and builds the URL the page is loaded from - which is why `url` is the one field here
/// that the host never sends: it carries an origin only this process can derive
/// (`services::plugins::pages`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EngineDesktopPage {
    #[serde(default)]
    pub(crate) id: String,
    /// The page's own title per locale, as the manifest wrote it; `null` when it wrote none.
    #[serde(default)]
    pub(crate) title: Option<std::collections::BTreeMap<String, String>>,
    /// The entry file, `/`-separated and relative to the plugin root.
    #[serde(default)]
    pub(crate) entry: String,
    /// Where it sorts among its own list. Only the page renders by it; nothing here orders.
    #[serde(default)]
    pub(crate) order: i64,
    /// A panel's window size, when it asked for one.
    #[serde(default)]
    pub(crate) width: Option<u32>,
    #[serde(default)]
    pub(crate) height: Option<u32>,
    /// Whether a panel's window may be resized; `null` when the manifest says nothing.
    #[serde(default)]
    pub(crate) resizable: Option<bool>,
    /// The page's icon token, as the manifest wrote it; `null` when it wrote none. Only the token's
    /// shape is re-checked here ([`validate_icon_token`]), never the name it stands for.
    #[serde(default)]
    pub(crate) icon: Option<String>,
    /// Where this page is loaded from, or `None` when it may not be loaded at all: a refused block,
    /// a disabled installation, or an entry this layer will not turn into a URL.
    #[serde(default)]
    pub(crate) url: Option<String>,
}

/// One work-panel tab a plugin contributes (`omp.desktop.workPanelTabs`, spec §3.2).
///
/// Unlike a page entry it carries no `entry` and no `url`: the surface is this application's own -
/// the built-in terminal needs a pty and a character grid a plugin page's document cannot reach - so
/// the manifest declares where the tab sits and which renderer draws it, and this layer carries both
/// through. `renderer` is a token of the *page's* vocabulary, so only its shape is checked here, the
/// way an icon token's is: a name this build does not serve is dropped where it is drawn rather than
/// refused here.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EngineWorkPanelTab {
    #[serde(default)]
    pub(crate) id: String,
    /// The tab's own title per locale, as the manifest wrote it; `null` when it wrote none.
    #[serde(default)]
    pub(crate) title: Option<std::collections::BTreeMap<String, String>>,
    /// Where it sorts among the work panel's own tabs. Only the page renders by it.
    #[serde(default)]
    pub(crate) order: i64,
    /// The tab's icon token, as the manifest wrote it; `null` when it wrote none.
    #[serde(default)]
    pub(crate) icon: Option<String>,
    /// The renderer token the entry asked for, as the manifest wrote it.
    #[serde(default)]
    pub(crate) renderer: String,
}

/// One command a plugin's resident process contributes (`omp.desktop.contributes.commands`, plan
/// §6.1).
///
/// The id is the palette's key *and* the worker's registry key, so it travels exactly as the
/// manifest wrote it - the host has already checked its shape. The title is a locale → label map the
/// page resolves, and the keywords are the palette's search terms, never sentences.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnginePluginProcessCommand {
    #[serde(default)]
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) title: Option<std::collections::BTreeMap<String, String>>,
    #[serde(default)]
    pub(crate) keywords: Vec<String>,
}

/// The default for `omp.desktop.autoRestart`: absent means the supervisor's own behaviour.
///
/// A `bool`'s own `Default` is `false`, which here would invert the field's meaning: a manifest that
/// says nothing would be read as asking for no restarts. The default is spelled out rather than
/// derived so the two readers of this shape (serde, and the page) cannot disagree about silence.
fn auto_restart_default() -> bool {
    true
}

/// The resident-process half of the `omp.desktop` block (`omp.desktop.main`, plan §6.1).
///
/// `main`, `activationEvents` and `commands` are the host's shape and travel unchanged; `available`
/// and `reason` are this side's verdict and the host never sends them. They are filled where the
/// authority over that question lives - the row a list read publishes
/// (`commands::plugin_pages::publish_pages` -> `services::plugins::process::availability`) - because
/// a built-in may run without the permission while a third-party installation needs both the
/// declaration and the user's confirmation, and a page must not decide that for itself.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EngineDesktopProcess {
    /// The package-relative entry the worker evaluates, or `None` when the block declares none.
    #[serde(default)]
    pub(crate) main: Option<String>,
    #[serde(default)]
    pub(crate) activation_events: Vec<String>,
    /// Whether the supervisor may restart this process after a crash (`omp.desktop.autoRestart`).
    ///
    /// Absent means `true`: the default is the supervisor's own behaviour, so a manifest that says
    /// nothing is not asking for anything new. `false` goes straight to `crashed` on the first
    /// unexpected exit, which is what a plugin holding a lock wants. The field is a *manifest* one
    /// and travels unchanged, like `main`.
    #[serde(default = "auto_restart_default")]
    pub(crate) auto_restart: bool,
    #[serde(default)]
    pub(crate) commands: Vec<EnginePluginProcessCommand>,
    /// Whether this installation may run a process at all. `false` on a row no list read has
    /// annotated yet, which is the fail-closed reading: nothing starts from a row this side has not
    /// judged.
    #[serde(default)]
    pub(crate) available: bool,
    /// The refusal token when [`Self::available`] is false (`plugin_process_permission_missing`,
    /// `plugin_process_builtin_unverified`); never a sentence, because the wording is the page's.
    #[serde(default)]
    pub(crate) reason: Option<String>,
}

/// The slot module an installation ships (`omp.desktop.renderer` + its two whitelists, plan §7.1).
///
/// The host projects the manifest's own shape - `path`, `actions`, `callMethods`; this side adds the
/// address the module is fetched from, whether it may be loaded at all, and the token that says why
/// not. `path` being present says nothing about loadability: only `url` does, and `available: false`
/// is this boundary saying the installation may not load a module (`reason` is its token, never a
/// sentence).
///
/// The `url` is the fixed slot host's (`services::plugins::renderer`, plan D2), not a URL derived
/// from `path`: the handler serves exactly one file per installation under one fixed name, so the
/// address a page imports cannot spell a package path and the platform's CSP needs two fixed
/// sources rather than a wildcard.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnginePluginRenderer {
    /// The package-relative module entry, as the host projected it; diagnostics only, never fetched.
    #[serde(default)]
    pub(crate) path: Option<String>,
    /// The dispatch whitelist, drawn from the closed action vocabulary.
    #[serde(default)]
    pub(crate) actions: Vec<String>,
    /// The method names `plugin.call` may reach.
    #[serde(default)]
    pub(crate) call_methods: Vec<String>,
    /// Where the module is fetched from, or `None` when this boundary will not serve it.
    #[serde(default)]
    pub(crate) url: Option<String>,
    /// Whether this installation may load the module at all.
    #[serde(default)]
    pub(crate) available: bool,
    /// The refusal token when [`Self::available`] is false
    /// (`renderer_module_missing` / `renderer_module_unavailable`); never a sentence.
    #[serde(default)]
    pub(crate) reason: Option<String>,
}

/// The `omp.desktop` block a plugin declares: the panels, views and settings destinations it wants
/// the desktop to host, the permissions it asks for, and the network domains it says it reaches.
///
/// `valid`/`reason` are the host's verdict on the block itself, and the page shows the reason
/// verbatim when it was refused: a plugin describing a desktop this build cannot serve is still a
/// plugin the user installed, so the row reports the refusal instead of dropping the plugin.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EngineDesktopBlock {
    /// The block's own version, so a future shape can be told from this one.
    #[serde(default)]
    pub(crate) schema_version: u32,
    #[serde(default)]
    pub(crate) valid: bool,
    #[serde(default)]
    pub(crate) reason: Option<String>,
    #[serde(default)]
    pub(crate) panels: Vec<EngineDesktopPage>,
    #[serde(default)]
    pub(crate) views: Vec<EngineDesktopPage>,
    #[serde(default)]
    pub(crate) settings_destinations: Vec<EngineDesktopPage>,
    /// `omp.desktop.sidebarTabs`: the pages the sidebar offers as its own entries (spec §4.2).
    #[serde(default)]
    pub(crate) sidebar_tabs: Vec<EngineDesktopPage>,
    /// `omp.desktop.workPanelTabs`: tabs the work panel draws with one of this application's own
    /// renderers rather than with a page it loads (spec §4.2).
    #[serde(default)]
    pub(crate) work_panel_tabs: Vec<EngineWorkPanelTab>,
    /// `omp.desktop.main` / `activationEvents` / `contributes.commands` (plan §6.1): the resident
    /// process the plugin asks for, or `None` when it declares no entry. The host validates only the
    /// shape; whether it may run is this side's verdict ([`EngineDesktopProcess::available`]).
    #[serde(default)]
    pub(crate) process: Option<EngineDesktopProcess>,
    /// `omp.desktop.renderer` / `rendererActions` / `rendererCallMethods` (plan §7.1): the slot
    /// module whose code runs in this application's document, and the two dispatch whitelists.
    ///
    /// The host projects `path`, `actions` and `callMethods`; this side re-checks them and adds the
    /// address the module is loaded from (`services::plugins::renderer`), the verdict and its reason.
    /// `None` for a block that declares none.
    #[serde(default)]
    pub(crate) renderer: Option<EnginePluginRenderer>,
    #[serde(default)]
    pub(crate) permissions: Vec<String>,
    #[serde(default)]
    pub(crate) net_domains: Vec<String>,
    /// `omp.desktop.net.anyHost`: the second key beside [`Self::net_domains`] (API 0.2.0).
    ///
    /// Reported by the host and re-checked here against the `net.anyHost` permission, because the two
    /// keys are one declaration: a block that sets the flag without declaring the permission is
    /// refused whole (`recheck_block`), so a `true` this side ever acts on is a reach the manifest
    /// asked for twice. The egress decision itself is `services::plugins::net::NetPolicy`'s - no
    /// bridge method reads this field to decide anything.
    #[serde(default)]
    pub(crate) net_any_host: bool,
    /// `omp.desktop.fs.<mode>.scope`: the standing reach the plugin declares for each file mode.
    ///
    /// Re-checked here with the same rule the host applied (`services::plugins::gates`), because a
    /// row is an input like any other: a pattern this side cannot read exactly is one two
    /// implementations would have to agree about by convention, a whole-tree pattern is only a read
    /// scope, and a block whose scope is unreadable is refused whole rather than honoured in part.
    #[serde(default)]
    pub(crate) fs_scopes: EngineFsScopes,
    /// `omp.desktop.themes`: the design tokens the plugin contributes to the appearance page.
    ///
    /// Carried as the host validated them, with the token names re-checked on this side
    /// ([`recheck_desktop`]) against the same two families the host publishes: a name outside them
    /// is a property this application never declares, and refusing it here is what keeps a token
    /// from a host that validated more loosely out of the renderer's style sheet.
    #[serde(default)]
    pub(crate) themes: Vec<EnginePluginTheme>,
    /// `omp.desktop.engines.ompDesktop`: the desktop range the plugin declares, or `null`.
    ///
    /// Reported, never evaluated (spec §3.2): evaluating a range is P2-2's, and until then this is a
    /// fact on the row. It is re-bounded here like every other string that crosses this boundary - a
    /// value this layer cannot bound is dropped rather than carried into a payload.
    #[serde(default)]
    pub(crate) engines_omp_desktop: Option<String>,
    /// The plugin's own translation table (`omp.desktop.i18n`): display metadata keyed by language,
    /// in whatever shape the plugin author wrote.
    ///
    /// It stays a `Value` because this layer has no opinion about it - the page picks a language and
    /// falls back, the host checks the shape it accepts - and the field name is the same on all
    /// three sides. Nothing here reads, trims or rewrites it: it is carried through the row
    /// conversion untouched.
    #[serde(default)]
    pub(crate) i18n: Option<Value>,
}

/// Longest `omp.desktop.engines.ompDesktop` range this layer carries, mirroring the host's bound.
const ENGINES_RANGE_MAX: usize = 128;

/// The standing reach one block declares for each file mode (spec §3.2, §6.3).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EngineFsScopes {
    #[serde(default)]
    pub(crate) read: Vec<String>,
    #[serde(default)]
    pub(crate) write: Vec<String>,
    #[serde(default)]
    pub(crate) delete: Vec<String>,
}

/// One theme a plugin contributes: its id, its labels per locale, the tokens it sets, and - when its
/// author ships one - a stylesheet and the assets that stylesheet may paint with.
///
/// `css` and `assets` have two shapes on their way through this process, and the difference is the
/// boundary at which they are rewritten: the host reports what the manifest declared (a
/// package-relative `.css` path, package-relative asset paths), and the row the page receives carries
/// what this layer made of it (`services::plugins::theme_css`): the sanitised stylesheet text, and the
/// absolute URLs the assets are served from. Nothing on the page side is ever a path.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnginePluginTheme {
    #[serde(default)]
    pub(crate) id: String,
    /// Locale → label, as the manifest wrote it; `null` when it wrote none.
    #[serde(default)]
    pub(crate) label: Option<Value>,
    /// Whether the plugin says the theme belongs to the dark base theme; `null` when it says nothing.
    #[serde(default)]
    pub(crate) dark: Option<bool>,
    /// Token name → value. Every name here has passed `validate_theme_token` (`desktop.rs`).
    #[serde(default)]
    pub(crate) tokens: std::collections::BTreeMap<String, String>,
    /// The theme's stylesheet: the declared package-relative `.css` on the host's row, and the
    /// sanitised text on the page's row. `null` when the theme declares none - or when what it
    /// declared did not apply, which [`Self::css_error`] then names.
    #[serde(default)]
    pub(crate) css: Option<String>,
    /// The files the stylesheet may paint with: the declared package-relative paths on the host's
    /// row, the absolute URLs they are served from on the page's row, in declared order. Empty when
    /// the theme declares none, or when its content was refused.
    #[serde(default)]
    pub(crate) assets: Vec<String>,
    /// `theme_css_invalid` when the theme declared a stylesheet (or assets) that could not be read,
    /// sanitised or served; `null` otherwise.
    ///
    /// The honest half of a per-theme refusal: a stylesheet that declared itself and did not apply
    /// is a fact its author has to be able to see, and the alternative - a theme that silently paints
    /// tokens only - is a bug nobody can diagnose.
    #[serde(default)]
    pub(crate) css_error: Option<String>,
}

/// `plugins_list`, and the answer to every plugin write: the whole list as it stands after the
/// call.
///
/// A write answers with a freshly read list rather than with an acknowledgement, because all of
/// them change the same page in the same way and the page renders whatever the host reports next.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnginePluginsView {
    #[serde(default)]
    pub(crate) plugins: Vec<EnginePluginRow>,
}

// ---- what the frontend receives ----

/// One plugin row as the page receives it: the host's row without `rootPath`.
///
/// The three sides of the contract use the same field names, and this is the only place one of them
/// is left out - because a machine-local path is host material, not page material.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginRowView {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) description: Option<String>,
    pub(crate) version: Option<String>,
    pub(crate) scope: String,
    pub(crate) enabled: bool,
    /// Whether this row is the plugin this application ships with (`services::plugins::builtin`): the
    /// page offers it "disable" and no uninstall, and it is never removed by anything here. It is
    /// `false` for a same-named package from anywhere else, and it is `false` for a row whose
    /// reserved id was *not* verified to have come from the bundled marketplace - the identity a row
    /// spells is not evidence of where it came from.
    pub(crate) builtin: bool,
    pub(crate) shadowed_by: Option<String>,
    /// The handle the plugin's write commands address (`installId`). The page never keys by it.
    pub(crate) install_id: Option<String>,
    pub(crate) source: EnginePluginSource,
    pub(crate) sources: Vec<EnginePluginSourceOption>,
    pub(crate) installed_at: Option<String>,
    pub(crate) last_updated: Option<String>,
    pub(crate) consent: EnginePluginConsent,
    pub(crate) code: EnginePluginCode,
    pub(crate) settings: EnginePluginSettingsSummary,
    pub(crate) desktop: Option<EngineDesktopBlock>,
    pub(crate) desktop_error: Option<String>,
}

/// The plugin list the commands answer with, in the row shape the page declares.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginsView {
    pub(crate) plugins: Vec<PluginRowView>,
}

impl From<EnginePluginRow> for PluginRowView {
    fn from(row: EnginePluginRow) -> Self {
        // Prepared before the row is taken apart: the re-check reads the row's identity, its enabled
        // state and the directory its files live in, so it borrows the row as a whole.
        let desktop = recheck_desktop(&row);
        Self {
            id: row.id.clone(),
            name: row.name,
            description: row.description,
            version: row.version,
            scope: row.scope.clone(),
            enabled: row.enabled,
            builtin: row.builtin,
            shadowed_by: row.shadowed_by,
            install_id: row.install_id,
            source: row.source,
            sources: row.sources,
            installed_at: row.installed_at,
            last_updated: row.last_updated,
            consent: row.consent,
            code: row.code,
            settings: row.settings,
            desktop,
            desktop_error: row.desktop_error,
        }
    }
}

impl From<EnginePluginsView> for PluginsView {
    fn from(view: EnginePluginsView) -> Self {
        Self {
            plugins: view.plugins.into_iter().map(PluginRowView::from).collect(),
        }
    }
}

// ---- one plugin's settings ----

/// One plugin's settings, as the read and every write answer them.
///
/// `schema` and `values` stay `Value`: the schema is the plugin author's own (`type`, `min`/`max`,
/// `values`, `description`, `default`, `env`), and a page that renders it does not need this layer
/// to restate it - which is also what keeps a keyword this build has never heard of from requiring
/// a Rust change. What this layer does judge is the one write it forwards: which value may be
/// stored for a key is checked against that key's own entry before the host is asked
/// (`services::plugins::validate::validate_setting_value`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnginePluginSettings {
    #[serde(default)]
    pub(crate) id: String,
    /// The plugin's declared settings, key by key. Empty for a plugin that declares none.
    #[serde(default)]
    pub(crate) schema: Value,
    /// The values the engine holds for that plugin: only the keys that were set explicitly, so a
    /// key that is absent here is running on the default its schema declares.
    #[serde(default)]
    pub(crate) values: Value,
    /// `Object.keys(values)`: the keys that carry a value of their own.
    #[serde(default)]
    pub(crate) explicit: Vec<String>,
}

// ---- marketplaces ----

/// One marketplace the engine's registry knows.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EngineMarketplaceRow {
    #[serde(default)]
    pub(crate) name: String,
    /// What the registry stores as the source: `owner/repo`, or the URL it was added by.
    #[serde(default)]
    pub(crate) source_uri: String,
    /// Host-derived: false when a local source's directory no longer exists.
    #[serde(default)]
    pub(crate) available: Option<bool>,
}

/// `marketplaces_list`, and the answer to every marketplace write: the whole registry after the
/// call.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EngineMarketplacesView {
    #[serde(default)]
    pub(crate) marketplaces: Vec<EngineMarketplaceRow>,
}

// ---- the catalogue entries a marketplace offers (the store) ----

/// One catalogue entry a registered marketplace offers, as the host reports it.
///
/// The fields are the engine's own listing (`MarketplacePluginEntry`), projected one for one: a
/// catalogue may declare a subset of them, so everything but the name is optional and the page hides
/// a row it has no value for rather than showing a made-up one (spec §3.4). `marketplace` is the
/// marketplace the entry was read from - the entry itself does not carry it - and `source` is the
/// install source as one readable label the host derived (`github:owner/repo@ref`, `npm:pkg@1.0.0`),
/// because the engine spells it either as a bare string or as one of four structured forms.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EngineMarketplacePluginRow {
    #[serde(default)]
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) marketplace: String,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(default)]
    pub(crate) version: Option<String>,
    /// The author's name, or their email when the catalogue declared no name.
    #[serde(default)]
    pub(crate) author: Option<String>,
    #[serde(default)]
    pub(crate) homepage: Option<String>,
    #[serde(default)]
    pub(crate) repository: Option<String>,
    #[serde(default)]
    pub(crate) license: Option<String>,
    #[serde(default)]
    pub(crate) category: Option<String>,
    /// `tags`, or the catalogue's `keywords` when it declares no tags.
    #[serde(default)]
    pub(crate) tags: Vec<String>,
    #[serde(default)]
    pub(crate) source: String,
}

/// `marketplace_plugins`: the catalogue entries the store lists, across the registered marketplaces
/// or from one of them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EngineMarketplacePluginsView {
    #[serde(default)]
    pub(crate) plugins: Vec<EngineMarketplacePluginRow>,
}

// ---- one package file, read before it is installed ----

/// `engine_plugin_inspect_package`: what one package file holds.
///
/// A *preview*, not an install: the tree it reads is temporary and removed before the answer leaves,
/// nothing is registered and nothing is installed. Every value is what the file itself declares or
/// what this application's own guards found - never a value derived to make the confirmation card
/// look complete (spec §3.4). The checksum pair is the honest state of an optional
/// `checksums.json`: a local package may ship none, which the page shows as "no checksum" rather
/// than as a failure, and `checksumCount` is how many files the list covers when it ships one.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InspectPackageView {
    pub(crate) name: String,
    pub(crate) version: Option<String>,
    pub(crate) description: Option<String>,
    /// The permissions the manifest declares that this build serves, in the manifest's own order.
    pub(crate) permissions: Vec<String>,
    /// The hosts the manifest declares, as the egress gate reads them.
    pub(crate) net_domains: Vec<String>,
    /// How many pages the `omp.desktop` block declares, across its four lists.
    pub(crate) page_count: usize,
    /// Whether the manifest declares extension modules (`omp.extensions`).
    pub(crate) has_extensions: bool,
    pub(crate) checksum_verified: bool,
    pub(crate) checksum_count: usize,
    /// The archive's own digest, always present: it is what a URL install's `sha256` is compared
    /// against, and what a user can check the file they picked against.
    pub(crate) sha256: String,
}

// ---- the template entry point ----

/// `engine_plugin_scaffold`: where a new plugin was written.
///
/// One field, and it is the directory rather than a file: a template is a whole tree (a manifest, a
/// page, a skill), and what the user does next is open that directory and edit it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginScaffoldView {
    /// The directory the template was copied to (`<targetDir>/<template>`).
    pub(crate) path: String,
}

// ---- the engine and its toolchain ----

/// `plugins_engine`: the engine build this host runs, and the external tools it found on this
/// machine.
///
/// A diagnostic rather than a plugin fact: it says which engine answers these frames and whether
/// the executables an install shells out to are there, so an install that cannot run at all is
/// explained as a missing tool (the host's `plugin_install_unavailable`) instead of as a broken
/// plugin. Every value is the host's own report and nothing here re-derives one.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnginePluginEngineInfo {
    /// The engine build the host was compiled against and is running.
    pub(crate) sdk_version: String,
    /// The frame protocol the host speaks, which the handshake already agreed on.
    pub(crate) protocol: u32,
    pub(crate) toolchain: EnginePluginToolchain,
}

/// Which external executables the host found, one flag per tool an install may need.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnginePluginToolchain {
    /// The runtime the engine's own installer spawns.
    pub(crate) bun: bool,
    /// For a source that has to be fetched from a repository.
    pub(crate) git: bool,
    /// For a source that resolves through the npm registry.
    pub(crate) npm: bool,
}

// ---- the reload ----

/// `plugins_reload`: the host's own report of the rebuild it just ran over the live sessions.
///
/// `reloaded` is the fact "every session converged", not "the call was made": a rebuild one session
/// could not take answers `false` and counts it in `failed`, so the page can say which sessions
/// have to be reopened instead of reporting a success the host did not have.
///
/// `failed` is an addition to an answer the host already sent, and it is read with
/// `#[serde(default)]` for that reason: a host from before the field answers `{reloaded, sessions}`
/// and this side reads it as no failures, while a host that sends it is read in full. The tolerance
/// runs both ways, which is why the field is an increment rather than a protocol change - the frame
/// and its version (`services::runtime::PROTOCOL_VERSION`) are untouched.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnginePluginReloadResult {
    #[serde(default)]
    pub(crate) reloaded: bool,
    /// How many live sessions were rebuilt.
    #[serde(default)]
    pub(crate) sessions: usize,
    /// How many live sessions could not be rebuilt; `0` for a host that does not report the field.
    #[serde(default)]
    pub(crate) failed: usize,
}

// ---- built-in plugins ----

/// One plugin this application ships with, as the built-in page renders it.
///
/// Unlike the plugin list (`engine_plugins`), this row is about the *definition* this build carries,
/// not about an installation a workspace can see: `id` is the installation id the engine derives for
/// the bundled package, `name`, `description` and `version` are read from the bundle's own manifest,
/// and the three flags say what became of it. `installed` and `enabled` are the host's answer about
/// the installation at its own scope; `suppressed` is this application's own record that the user
/// removed it (`services::store::builtin_suppression`), which is what the seed honours instead of
/// putting it back, and what the restore command clears. `version` is `None` when this build has no
/// readable bundle, which is the same state the seed reports by not installing anything.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BuiltinPluginRow {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) description: Option<String>,
    pub(crate) version: Option<String>,
    pub(crate) installed: bool,
    pub(crate) enabled: bool,
    pub(crate) suppressed: bool,
}

/// `engine_builtin_plugins`: the plugins this application ships with, and what became of each.
///
/// One row per built-in definition this build carries, whether or not it is installed: the page has
/// to show the user what they removed and offer to restore it, which is exactly the case an
/// installation list cannot express.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BuiltinPluginsView {
    pub(crate) plugins: Vec<BuiltinPluginRow>,
}

// ---- consent grants ----

/// One remembered consent grant: the plugin installation whose code the user agreed to run, and
/// when.
///
/// An installation is a plugin id together with the scope it lives at, which is why the row carries
/// both: the same id can be installed at both scopes, and a confirmation of one is not a
/// confirmation of the other. A project-scope installation additionally exists once per workspace,
/// so this row is only ever answered for one workspace at a time - the record is keyed by that
/// workspace's registry key (`services::plugins::grants`), and the list it arrives in
/// (`engine_plugin_grants`) is that workspace's own view of it: its project-scope rows plus the
/// user-scope ones, which speak about the single installation every workspace shares. The timestamp
/// is the store's own millisecond clock rendered as text, which is the shape the `plugin_grants`
/// column has: a grant is bookkeeping rather than a row anything sorts by, and the page shows at
/// most "already confirmed".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginGrantRow {
    pub(crate) plugin_id: String,
    /// `user` | `project`: the installation the answer is about.
    pub(crate) scope: String,
    pub(crate) granted_at: String,
}

/// `engine_plugin_grants`, and the answer to a grant write: every grant on record after the call.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginGrantsView {
    pub(crate) grants: Vec<PluginGrantRow>,
}

// ---- resident plugin processes (plan §6.4, T2) ----

/// One installation's resident process, as the supervisor holds it.
///
/// The identity is `(pluginId, scope)`: an id is only unique within a registry, and the same plugin
/// can be installed at both scopes. `reason` is a machine token (a crash class, a protocol
/// mismatch, a timeout), never a sentence - the wording lives in the page, and a token this build
/// cannot word is shown as it arrived. `lastExitAt` is an ISO-8601 instant, because the page formats
/// it with the document's own locale (`new Date(...)`), not a millisecond stamp it would print raw.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginProcessRow {
    pub(crate) plugin_id: String,
    /// `user` | `project`.
    pub(crate) scope: String,
    /// `stopped` | `starting` | `running` | `crashed`.
    pub(crate) state: &'static str,
    /// How many times the supervisor has restarted this process after a crash.
    pub(crate) restarts: u32,
    pub(crate) pid: Option<u32>,
    pub(crate) reason: Option<String>,
    pub(crate) last_exit_at: Option<String>,
}

/// `engine_plugin_process`, every restart, and the `plugin-process` event: one table, whole.
///
/// The whole table rather than a delta because a crash and the restart it triggers are two writes to
/// the same row, and a reader that patched would have to guess which one it missed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginProcessesView {
    pub(crate) processes: Vec<PluginProcessRow>,
}

/// `engine_plugin_command_run`: the worker's own answer, verbatim.
///
/// `ok: false` is not a transport failure - the command ran and was refused (by a gate, the worker
/// or the plugin itself), and `code` is what the page states beside the command that produced it.
/// `value` is always present so the row has one shape whether the plugin returned something or not.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnginePluginCommandRunView {
    pub(crate) ok: bool,
    pub(crate) value: Value,
    pub(crate) code: Option<String>,
    pub(crate) message: Option<String>,
}

/// `engine_plugin_renderer_call`: one `plugin.call` from a slot component, answered verbatim.
///
/// The same shape as [`EnginePluginCommandRunView`] and for the same reason: a refusal is the
/// worker's own answer (or one of this side's dispatch tokens, `PLUGIN_ACTION_UNKNOWN` /
/// `PLUGIN_ACTION_UNDECLARED`), not a transport failure. `params` is not echoed back - what the
/// plugin returned is.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnginePluginRendererCallView {
    pub(crate) ok: bool,
    pub(crate) value: Value,
    pub(crate) code: Option<String>,
    pub(crate) message: Option<String>,
}

#[cfg(test)]
mod tests;
