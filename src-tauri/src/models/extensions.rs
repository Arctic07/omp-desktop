//! The extensions dashboard's payloads: the engine's discovered items, the ids the setting holds,
//! and whether the page bound cut the list.
//!
//! Every field is the engine's own answer projected by the host (`extensions_list`): the row's id
//! is the exact token `disabledExtensions` stores, `state` is the engine's gate (item-disabled,
//! provider-disabled, user opt-in, shadowed), and nothing here re-derives a discovery. An item's
//! filesystem path is deliberately absent: the page draws names and providers, and a machine path
//! is host material.

use serde::{Deserialize, Serialize};

/// One discovered extension item.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtensionRow {
    #[serde(default)]
    pub(crate) id: String,
    /// `skill` | `rule` | `tool` | `hook` | `prompt` | `slash-command` | `context-file` | `extension-module`.
    #[serde(default)]
    pub(crate) kind: String,
    #[serde(default)]
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) display_name: String,
    #[serde(default)]
    pub(crate) description: Option<String>,
    /// How the item is reached in a session (`/skill:…`, `/…`, `pre:bash`), when it has one.
    #[serde(default)]
    pub(crate) trigger: Option<String>,
    /// The discovering provider's id (`.omp`, `omp-plugins`, `claude-plugins`, …).
    #[serde(default)]
    pub(crate) provider: String,
    #[serde(default)]
    pub(crate) provider_name: String,
    /// `user` | `project`.
    #[serde(default)]
    pub(crate) level: String,
    /// `active` | `disabled` | `shadowed`.
    #[serde(default)]
    pub(crate) state: String,
    /// `item-disabled` | `provider-disabled` | `user-opt-in` | `shadowed`.
    #[serde(default)]
    pub(crate) disabled_reason: Option<String>,
    /// The name of the higher-priority copy when this row is shadowed, or null.
    #[serde(default)]
    pub(crate) shadowed_by: Option<String>,
}

/// `extensions_list` and `extensions_set`: the rows and the page bound.
///
/// The `disabledExtensions` list itself is not part of the answer: every row already carries the
/// engine's own `state`, which is that setting resolved item by item, and a second copy of the raw
/// list would be a second thing for a page to interpret.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtensionsView {
    #[serde(default)]
    pub(crate) extensions: Vec<ExtensionRow>,
    /// True when the answer is a prefix of a longer discovery.
    #[serde(default)]
    pub(crate) truncated: bool,
}
