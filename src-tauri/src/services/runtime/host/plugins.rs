//! The plugin calls [`HostRuntime`] serves for the settings page: what is installed, what can be
//! installed or upgraded, the marketplaces those installs come from, one plugin's settings, the
//! engine build and external tools an install runs on, and the reload that makes a change visible
//! to the running sessions.
//!
//! Every method is the same three steps in the same order as the capability calls beside it - make
//! sure a host is running, send the frame, read its answer into the DTO the command returns - with
//! one addition: a failure is restated in this application's plugin vocabulary before it travels on
//! (`services::plugins::map_host_error`), so the frontend branches on the constants `errors.rs`
//! registers rather than on the host's own lowercase tokens.
//!
//! Nothing here inspects, renames or recomputes a payload. What a plugin is, which files it holds,
//! what an install source resolves to and what the engine's settings say are all the host's
//! answers; the argument shapes this layer refuses are checked before any of this runs
//! (`services::plugins::validate`) and the engine's own rules stay on the far side of the pipe.
//!
//! Timeouts follow the same split as the capability calls: a read or a settings write answers out of
//! configuration the host already has, while an install, an upgrade or a marketplace write may
//! download and unpack before it answers, so those get `INSTALL_TIMEOUT_MS`.
//!
//! The plugin a frame addresses travels under `targetId` and never under `id`: `id` is the
//! envelope's request-response correlation key, written by the call path itself
//! (`host::ops::call_inner`), so a target sent as `id` would simply be overwritten and the write
//! would address nothing (the same ruling the skill writes carry, contract §2.3 C14). The frames
//! that take no target - the list, the checks, the marketplace registry - carry none.

use serde_json::{json, Value};

use crate::errors::IpcResult;
use crate::models::extensions::ExtensionsView;
use crate::models::plugins::{
    EngineMarketplacePluginsView, EngineMarketplacesView, EnginePluginEngineInfo,
    EnginePluginReloadResult, EnginePluginSettings, EnginePluginUpdatesView, EnginePluginsView,
    PluginAutoUpdateView, PluginDoctorView, PluginInstallPreview,
};
use crate::services::plugins::map_host_error;

use super::super::{CAPABILITY_TIMEOUT_MS, INSTALL_TIMEOUT_MS};
use super::capabilities::{command_frame, decode};
use super::HostRuntime;

impl HostRuntime {
    /// Every plugin this working directory can see, with the facts the page renders about each one.
    pub(crate) async fn plugins(&self, cwd: Option<&str>) -> IpcResult<EnginePluginsView> {
        self.ensure_running().await?;
        let data = self
            .call_plugin(command_frame("plugins_list", cwd), CAPABILITY_TIMEOUT_MS)
            .await?;
        decode(data, "plugin list")
    }

    /// Installs one plugin from whatever the user pasted, and answers with the list as it stands
    /// after the install.
    ///
    /// What the source *is* - a marketplace entry, an npm spec, a local directory, a git URL - is
    /// the engine's own classification, decided on the host's side; this layer only bounds the text
    /// before it travels.
    pub(crate) async fn plugin_install(
        &self,
        cwd: Option<&str>,
        source: &str,
        scope: Option<&str>,
        force: bool,
    ) -> IpcResult<EnginePluginsView> {
        self.ensure_running().await?;
        let mut request = command_frame("plugins_install", cwd);
        request["source"] = json!(source);
        if let Some(scope) = scope {
            request["scope"] = json!(scope);
        }
        if force {
            request["force"] = json!(true);
        }
        let data = self.call_plugin(request, INSTALL_TIMEOUT_MS).await?;
        decode(data, "plugin list")
    }

    /// What `plugins_install` would do, without doing it: the engine's `--dry-run`.
    ///
    /// The answer names the package, the version the engine could resolve without fetching, and
    /// the features the spec selects; nothing is written.
    pub(crate) async fn plugin_install_preview(
        &self,
        cwd: Option<&str>,
        source: &str,
        scope: Option<&str>,
        force: bool,
    ) -> IpcResult<PluginInstallPreview> {
        self.ensure_running().await?;
        let mut request = command_frame("plugins_install_preview", cwd);
        request["source"] = json!(source);
        if let Some(scope) = scope {
            request["scope"] = json!(scope);
        }
        if force {
            request["force"] = json!(true);
        }
        let data = self.call_plugin(request, INSTALL_TIMEOUT_MS).await?;
        decode(data, "plugin install preview")
    }

    /// Removes one plugin and answers with the list as it stands after the removal.
    ///
    /// The scope names which installation to remove when a plugin is installed in both places; a
    /// caller that names none lets the host decide, which is the engine's own rule. The id travels
    /// as `targetId` (see the module docs).
    pub(crate) async fn plugin_uninstall(
        &self,
        cwd: Option<&str>,
        id: &str,
        scope: Option<&str>,
    ) -> IpcResult<EnginePluginsView> {
        self.ensure_running().await?;
        let mut request = command_frame("plugins_uninstall", cwd);
        request["targetId"] = json!(id);
        if let Some(scope) = scope {
            request["scope"] = json!(scope);
        }
        let data = self.call_plugin(request, INSTALL_TIMEOUT_MS).await?;
        decode(data, "plugin list")
    }

    /// Turns one plugin on or off, and answers with the list as it stands after the write.
    ///
    /// Whether this may be enabled at all is decided before the call (`services::plugins`): the
    /// consent gate is this application's own rule, and it is answered here rather than by the
    /// engine, which has no notion of the user having agreed to anything. The id travels as
    /// `targetId` (see the module docs).
    pub(crate) async fn plugin_set_enabled(
        &self,
        cwd: Option<&str>,
        id: &str,
        enabled: bool,
        scope: Option<&str>,
    ) -> IpcResult<EnginePluginsView> {
        self.ensure_running().await?;
        let mut request = command_frame("plugins_set_enabled", cwd);
        request["targetId"] = json!(id);
        request["enabled"] = json!(enabled);
        if let Some(scope) = scope {
            request["scope"] = json!(scope);
        }
        let data = self.call_plugin(request, CAPABILITY_TIMEOUT_MS).await?;
        decode(data, "plugin list")
    }

    /// Turns one optional feature of an installation on or off, and answers with the list as it
    /// stands after the write.
    ///
    /// What the list of enabled features means is the engine's own rule (`enabledFeatures === null`
    /// enables the truthy defaults), so the host reads that resolution, applies the one change and
    /// writes the resulting list back. The id travels as `targetId` (see the module docs).
    pub(crate) async fn plugin_feature_set(
        &self,
        cwd: Option<&str>,
        id: &str,
        scope: Option<&str>,
        feature: &str,
        enabled: bool,
    ) -> IpcResult<EnginePluginsView> {
        self.ensure_running().await?;
        let mut request = command_frame("plugins_features_set", cwd);
        request["targetId"] = json!(id);
        request["feature"] = json!(feature);
        request["enabled"] = json!(enabled);
        if let Some(scope) = scope {
            request["scope"] = json!(scope);
        }
        let data = self.call_plugin(request, CAPABILITY_TIMEOUT_MS).await?;
        decode(data, "plugin list")
    }

    /// Upgrades one plugin, or every plugin that has an upgrade, and answers with the list as it
    /// stands afterwards.
    ///
    /// Both shapes answer with the same payload, so the page renders one thing whichever call it
    /// made; what was actually upgraded is the engine's own report and is not restated here as a
    /// list this layer would have to keep in step. A named plugin travels as `targetId` (see the
    /// module docs); naming none asks the host to upgrade everything it found stale.
    pub(crate) async fn plugin_upgrade(
        &self,
        cwd: Option<&str>,
        id: Option<&str>,
        scope: Option<&str>,
    ) -> IpcResult<EnginePluginsView> {
        self.ensure_running().await?;
        let mut request = command_frame("plugins_upgrade", cwd);
        if let Some(id) = id {
            request["targetId"] = json!(id);
        }
        if let Some(scope) = scope {
            request["scope"] = json!(scope);
        }
        let data = self.call_plugin(request, INSTALL_TIMEOUT_MS).await?;
        decode(data, "plugin list")
    }

    /// What `plugins_upgrade` would move, read without changing anything.
    ///
    /// Reading updates means asking the marketplaces' own metadata, so this is the read-only half
    /// of the upgrade and gets the wider budget rather than the capability one.
    pub(crate) async fn plugin_check_updates(
        &self,
        cwd: Option<&str>,
    ) -> IpcResult<EnginePluginUpdatesView> {
        self.ensure_running().await?;
        // The engine keeps a different installation registry per workspace, so a check that names
        // none is answered against the host's default workspace: a project-scope installation in the
        // workspace the reader is in would never appear as having an update.
        let data = self
            .call_plugin(
                command_frame("plugins_check_updates", cwd),
                INSTALL_TIMEOUT_MS,
            )
            .await?;
        decode(data, "plugin updates")
    }

    /// The marketplaces the engine's registry knows, and what each was added by.
    pub(crate) async fn marketplaces(&self) -> IpcResult<EngineMarketplacesView> {
        self.ensure_running().await?;
        let data = self
            .call_plugin(
                command_frame("marketplaces_list", None),
                CAPABILITY_TIMEOUT_MS,
            )
            .await?;
        decode(data, "marketplace list")
    }

    /// The catalogue entries the store lists: one marketplace's, or every registered marketplace's
    /// when none is named.
    ///
    /// A read of the catalogues the host already has on disk (`marketplace_plugins`), not a fetch:
    /// refreshing them is `marketplace_update`'s work, so opening the store costs a file read and
    /// rides the capability budget.
    pub(crate) async fn marketplace_plugins(
        &self,
        marketplace: Option<&str>,
    ) -> IpcResult<EngineMarketplacePluginsView> {
        self.ensure_running().await?;
        let mut request = command_frame("marketplace_plugins", None);
        if let Some(marketplace) = marketplace {
            request["marketplace"] = json!(marketplace);
        }
        let data = self.call_plugin(request, CAPABILITY_TIMEOUT_MS).await?;
        decode(data, "marketplace catalogue")
    }

    /// Adds one marketplace (a `owner/repo` or a URL) and answers with the registry as it stands.
    pub(crate) async fn marketplace_add(&self, source: &str) -> IpcResult<EngineMarketplacesView> {
        self.ensure_running().await?;
        let mut request = command_frame("marketplaces_add", None);
        request["source"] = json!(source);
        let data = self.call_plugin(request, INSTALL_TIMEOUT_MS).await?;
        decode(data, "marketplace list")
    }

    /// Removes one marketplace, by name.
    pub(crate) async fn marketplace_remove(&self, name: &str) -> IpcResult<EngineMarketplacesView> {
        self.ensure_running().await?;
        let mut request = command_frame("marketplaces_remove", None);
        request["name"] = json!(name);
        let data = self.call_plugin(request, INSTALL_TIMEOUT_MS).await?;
        decode(data, "marketplace list")
    }

    /// Refreshes one marketplace, or every marketplace when none is named.
    pub(crate) async fn marketplace_update(
        &self,
        name: Option<&str>,
    ) -> IpcResult<EngineMarketplacesView> {
        self.ensure_running().await?;
        let mut request = command_frame("marketplaces_update", None);
        if let Some(name) = name {
            request["name"] = json!(name);
        }
        let data = self.call_plugin(request, INSTALL_TIMEOUT_MS).await?;
        decode(data, "marketplace list")
    }

    /// One plugin's settings: the schema its author declared, and the values the engine resolves.
    /// The plugin travels as `targetId` (see the module docs).
    pub(crate) async fn plugin_config(
        &self,
        cwd: Option<&str>,
        id: &str,
    ) -> IpcResult<EnginePluginSettings> {
        self.ensure_running().await?;
        let mut request = command_frame("plugins_config_list", cwd);
        request["targetId"] = json!(id);
        let data = self.call_plugin(request, CAPABILITY_TIMEOUT_MS).await?;
        decode(data, "plugin settings")
    }

    /// Stores one value for one key of a plugin's settings, and answers with the settings as they
    /// stand after the write.
    ///
    /// Whether the value fits the key is judged before this runs, against the schema this same host
    /// reported (`services::plugins::validate::validate_setting_value`); the engine writes the value
    /// through its own settings file and the answer is the merged result, so a caller never has to
    /// guess what is now stored. The plugin travels as `targetId` (see the module docs).
    pub(crate) async fn plugin_config_set(
        &self,
        cwd: Option<&str>,
        id: &str,
        key: &str,
        value: Value,
        local: bool,
    ) -> IpcResult<EnginePluginSettings> {
        self.ensure_running().await?;
        let mut request = command_frame("plugins_config_set", cwd);
        request["targetId"] = json!(id);
        request["key"] = json!(key);
        request["value"] = value;
        if local {
            request["local"] = json!(true);
        }
        let data = self.call_plugin(request, CAPABILITY_TIMEOUT_MS).await?;
        decode(data, "plugin settings")
    }

    /// Forgets one key of a plugin's settings, or every key it has a value for, and answers with
    /// the settings as they stand after the write.
    ///
    /// Which keys exist is read from the engine on the far side: this layer names a key or asks for
    /// all of them, and the host decides what "all" is from the settings it just read. The plugin
    /// travels as `targetId` (see the module docs).
    pub(crate) async fn plugin_config_reset(
        &self,
        cwd: Option<&str>,
        id: &str,
        key: Option<&str>,
        local: bool,
    ) -> IpcResult<EnginePluginSettings> {
        self.ensure_running().await?;
        let mut request = command_frame("plugins_config_reset", cwd);
        request["targetId"] = json!(id);
        if let Some(key) = key {
            request["key"] = json!(key);
        }
        if local {
            request["local"] = json!(true);
        }
        let data = self.call_plugin(request, CAPABILITY_TIMEOUT_MS).await?;
        decode(data, "plugin settings")
    }

    /// Rebuilds the plugin-derived state of every live session and reports what was touched.
    ///
    /// The host answers with its own words (`{reloaded, sessions, failed}`): how many sessions were
    /// rebuilt, and how many could not be. `failed` is read with a default
    /// ([`EnginePluginReloadResult`]), so a host from before that field answers without it.
    pub(crate) async fn plugin_reload(
        &self,
        cwd: Option<&str>,
    ) -> IpcResult<EnginePluginReloadResult> {
        self.ensure_running().await?;
        let data = self
            .call_plugin(command_frame("plugins_reload", cwd), CAPABILITY_TIMEOUT_MS)
            .await?;
        decode(data, "plugin reload")
    }

    /// The engine this host runs, and which external tools it found on this machine.
    ///
    /// A read of the host's own build and environment rather than of any installed plugin, so it
    /// answers out of facts the host already holds and rides the capability budget. The page uses
    /// it to explain an install that cannot run at all: the host reports a missing tool as
    /// `plugin_install_unavailable`, and this call is what lets the surface name the tool instead
    /// of calling the plugin broken.
    pub(crate) async fn plugin_engine_info(&self) -> IpcResult<EnginePluginEngineInfo> {
        self.ensure_running().await?;
        let data = self
            .call_plugin(command_frame("plugins_engine", None), CAPABILITY_TIMEOUT_MS)
            .await?;
        decode(data, "plugin engine info")
    }

    /// The engine's marketplace auto-update policy, read or written.
    ///
    /// The setting is global (`marketplace.autoUpdate`), so this frame takes no workspace and no
    /// plugin; `mode` absent is a read.
    pub(crate) async fn plugin_auto_update(
        &self,
        mode: Option<&str>,
    ) -> IpcResult<PluginAutoUpdateView> {
        self.ensure_running().await?;
        let mut request = command_frame("plugins_auto_update", None);
        if let Some(mode) = mode {
            request["value"] = json!(mode);
        }
        let data = self.call_plugin(request, CAPABILITY_TIMEOUT_MS).await?;
        decode(data, "plugin auto update")
    }

    /// The engine's own health check over the plugins directory and every recorded installation.
    ///
    /// `fix` asks the engine to repair what it can; the answer is its own rows either way.
    pub(crate) async fn plugin_doctor(
        &self,
        cwd: Option<&str>,
        fix: bool,
    ) -> IpcResult<PluginDoctorView> {
        self.ensure_running().await?;
        let mut request = command_frame("plugins_doctor", cwd);
        request["fix"] = json!(fix);
        let data = self.call_plugin(request, INSTALL_TIMEOUT_MS).await?;
        decode(data, "plugin doctor")
    }

    /// The engine's extensions dashboard: every item a session can toggle, the ids already
    /// disabled, and whether the host's own page bound cut the list.
    pub(crate) async fn extensions(&self, cwd: Option<&str>) -> IpcResult<ExtensionsView> {
        self.ensure_running().await?;
        let data = self
            .call_plugin(command_frame("extensions_list", cwd), CAPABILITY_TIMEOUT_MS)
            .await?;
        decode(data, "extension list")
    }

    /// Enables or disables one extension item, answered with the dashboard as it stands after the
    /// write. The id is the engine's own `disabledExtensions` token, checked by the host.
    pub(crate) async fn extension_set(
        &self,
        cwd: Option<&str>,
        id: &str,
        enabled: bool,
    ) -> IpcResult<ExtensionsView> {
        self.ensure_running().await?;
        let mut request = command_frame("extensions_set", cwd);
        // `targetId`, not `id`: the request envelope's `id` is the correlation key this process
        // writes itself before encoding (`host/ops.rs::call_inner`), so an id sent under it would be
        // overwritten with `h7` and the host would refuse every write (ruling C14).
        request["targetId"] = json!(id);
        request["enabled"] = json!(enabled);
        let data = self.call_plugin(request, CAPABILITY_TIMEOUT_MS).await?;
        decode(data, "extension list")
    }

    /// One plugin command: the frame goes out, and a failure comes back restated in this
    /// application's plugin vocabulary.
    ///
    /// The mapping lives here rather than in each public method so that every plugin call answers
    /// the frontend in one vocabulary, and so a failure the host reports in its own words
    /// (`plugin_not_found`) reaches a caller that branches on the constant this build publishes.
    pub(super) async fn call_plugin(&self, request: Value, timeout_ms: u64) -> IpcResult<Value> {
        self.call_ok(request, timeout_ms)
            .await
            .map_err(map_host_error)
    }
}
