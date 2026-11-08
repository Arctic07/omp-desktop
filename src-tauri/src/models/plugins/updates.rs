//! The update surface: what an upgrade would move, and the answer to a switch of source
//! (`rules.md#plugin-system`).
//!
//! Three facts travel here and none of them is a version comparison: which upgrade the engine's own
//! check reports and where it comes from, which marketplaces declare a version of the same plugin
//! (the update card's "also in these marketplaces" list), and what a switch that already happened
//! moved the installation between. The comparison, the workspace scan and the rollback decision are
//! taken elsewhere - the first two by the host (`host/src/plugins-updates.ts`), the last by
//! `services::plugins::switch` - because each of them is a rule this layer would have to duplicate
//! to restate.

use serde::{Deserialize, Serialize};

use super::PluginRowView;

/// One available update, as the engine's own check and the host's cross-market scan report it.
///
/// `pluginId` is the identity the page keys by, `installId` the handle the engine acts through, and
/// `kind` says which of the two ways the update is applied (`switch-source` is the two-step one).
/// The kind is carried as the token it arrives as, the way `scope` is: this layer has no rule to
/// apply to it, and a token a later host adds is one this build can still carry.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnginePluginUpdate {
    /// The plugin's own id (`plugins_list`'s `id`), never the engine's handle.
    #[serde(default)]
    pub(crate) plugin_id: String,
    /// The engine handle this update is applied through (`name@marketplace`); `null` only on a row
    /// the host could not resolve into one, which is also a row with no marketplace.
    #[serde(default)]
    pub(crate) install_id: Option<String>,
    #[serde(default)]
    pub(crate) scope: String,
    #[serde(default)]
    pub(crate) from: String,
    #[serde(default)]
    pub(crate) to: String,
    /// The marketplace that declares `to`; `null` on a row no marketplace could be read from.
    #[serde(default)]
    pub(crate) marketplace: Option<String>,
    /// `in-place` | `switch-source`.
    #[serde(default)]
    pub(crate) kind: String,
}

/// One version of one plugin a marketplace declares: an entry of the update card's source list.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnginePluginUpdateSource {
    #[serde(default)]
    pub(crate) marketplace: String,
    /// The version that marketplace declares. Empty when the catalogue declares none, which the
    /// page renders as no version rather than as a made-up one.
    #[serde(default)]
    pub(crate) version: String,
}

/// Every source one plugin is available from, for the update card (plan §4.2).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnginePluginUpdateCandidate {
    #[serde(default)]
    pub(crate) plugin_id: String,
    #[serde(default)]
    pub(crate) scope: String,
    #[serde(default)]
    pub(crate) sources: Vec<EnginePluginUpdateSource>,
}

/// `plugins_check_updates`: what an upgrade would move, read without changing anything.
///
/// `candidates` is additive like the fields it carries: a host from before the cross-market scan
/// answers without it, and this side reads that as "no source list", which the page shows as no
/// card rather than as an empty one.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnginePluginUpdatesView {
    #[serde(default)]
    pub(crate) updates: Vec<EnginePluginUpdate>,
    #[serde(default)]
    pub(crate) candidates: Vec<EnginePluginUpdateCandidate>,
}

/// What one switch of source did with the installation it moved.
///
/// `from` and `to` are engine handles (`name@marketplace`), because that is what was uninstalled and
/// installed; `marketplace` names the source the plugin now comes from. `rolledBack` is read from the
/// switch's own outcome rather than assumed: an answer only exists when the switch happened, so it is
/// `false` on every answer that reaches the page, while the failure path carries the same fact in the
/// error it answers with (the switch did not happen, and the message says whether the previous
/// installation was put back).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginUpdateSwitch {
    pub(crate) from: String,
    pub(crate) to: String,
    pub(crate) marketplace: String,
    pub(crate) rolled_back: bool,
}

/// `engine_plugin_update_switch`: the plugin list as it stands after the switch, and what moved.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginUpdateSwitchView {
    pub(crate) plugins: Vec<PluginRowView>,
    pub(crate) switched: PluginUpdateSwitch,
}
