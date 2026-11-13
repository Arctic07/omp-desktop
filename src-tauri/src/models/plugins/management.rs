//! The plugin-management payloads that are not the row itself: the engine's health check, an
//! install's dry-run, and the marketplace auto-update policy.
//!
//! Split out of `models/plugins.rs` when that file reached the 1000-line gate; these three shapes
//! are one subject (a management action's answer) and share no field with the row DTOs.

use serde::{Deserialize, Serialize};

/// One line of the engine's own plugin health check (`PluginManager.doctor`).
///
/// `status` is the engine's token (`ok` | `warning` | `error`); `fixed` is whether this run repaired
/// the condition, which is false for a read and for a repair the engine could not make.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginDoctorCheck {
    pub(crate) name: String,
    pub(crate) status: String,
    pub(crate) message: String,
    #[serde(default)]
    pub(crate) fixed: bool,
}

/// `plugins_doctor`: every check the engine ran, in its own order.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginDoctorView {
    pub(crate) checks: Vec<PluginDoctorCheck>,
}

/// One install as the engine's own `--dry-run` describes it: what would be installed, at which
/// scope, with which features selected. `version` is null when the engine cannot know it without
/// fetching (an npm spec's real version, or a local link).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginInstallPreview {
    /// `marketplace` | `npm` | `link`. `npm` is the engine's own classification of every package
    /// spec, git URLs included: `classifyInstallTarget` answers `npm` for both, and `install` splits
    /// them internally.
    pub(crate) kind: String,
    pub(crate) name: String,
    pub(crate) version: Option<String>,
    /// `user` | `project`.
    pub(crate) scope: String,
    /// The `omp.features` names the install spec selects (`pkg[feat]`); `null` when the spec
    /// selects every declared feature (`pkg[*]`) or names no bracket at all.
    #[serde(default)]
    pub(crate) features: Option<Vec<String>>,
}

/// `plugins_auto_update`: the engine's `marketplace.autoUpdate` policy (`off` | `notify` | `auto`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginAutoUpdateView {
    pub(crate) value: String,
}
