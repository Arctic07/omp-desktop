//! The identity rule of one plugin row (`rules.md#plugin-system`), in one place.
//!
//! The engine keys an installation by `name@marketplace`, while everything the user *decided* about
//! a plugin - the confirmation that it may run code, its settings, its pages and themes, the update
//! card - is about the plugin itself. The host reports both facts on a row: `id` is the plugin's own
//! id, and `installId` is the engine's handle, `null` for an npm or linked install whose package
//! name already is the name the engine takes.
//!
//! So there are exactly two questions to ask a row, and this module is where both are answered:
//!
//! - [`plugin_id`] is the identity. It is what the page keys by, what `plugin_grants.plugin_id`
//!   holds since store v9, and what a caller names when it means "this plugin".
//! - [`install_spec`] is the handle. It is what an engine write addresses (`targetId` in
//!   `plugins_uninstall` / `plugins_set_enabled` / `plugins_upgrade`), and using it as an identity
//!   is how a switch of source would silently lose everything the user agreed to.
//!
//! A host from before `installId` existed reports only the engine's handle, so its marketplace rows
//! carry `name@marketplace` in `id`. The collapse below is the one reading of that shape - not a
//! second rule, and not something any other module may re-derive: a name segment is only stripped
//! when the host did *not* already say which half is which.
//!
//! Nothing here validates: what an id may contain is `services::plugins::validate`'s, and what a row
//! *is* is the host's answer.

use std::borrow::Cow;

use super::{EnginePluginRow, EnginePluginSource};

/// The plugin's own id, i.e. the identity the desktop keys a plugin by.
///
/// A row the host reported with an `installId` already spells the identity in `id`; one from a host
/// that predates that field spells the engine's handle there instead, and only such a marketplace
/// row is collapsed. An npm or linked row never is: its `id` *is* the package name, and a package
/// name may carry a scope's leading `@`.
pub(crate) fn plugin_id(row: &EnginePluginRow) -> Cow<'_, str> {
    if row.install_id.is_some() {
        return Cow::Borrowed(row.id.as_str());
    }
    if row.source.kind == MARKETPLACE {
        return Cow::Owned(name_segment(&row.id).to_owned());
    }
    Cow::Borrowed(row.id.as_str())
}

/// The handle an engine write addresses: `installId` when the host reports one, the row's own id
/// otherwise (an npm or linked install is addressed by its package name, and a marketplace row from
/// an older host carries the handle in `id`).
pub(crate) fn install_spec(row: &EnginePluginRow) -> &str {
    row.install_id.as_deref().unwrap_or(row.id.as_str())
}

/// The marketplace one installation came from, as the host reported it.
///
/// Never derived from an id: which marketplace a row points at is a fact the host reads from the
/// engine's registry (`source.marketplace`), and reconstructing it from a string here would make the
/// built-in plugin's protection depend on how a package spells itself.
pub(crate) fn source_marketplace(row: &EnginePluginRow) -> Option<&str> {
    row.source.marketplace.as_deref()
}

/// The name segment of an engine handle (`name@marketplace`), or the handle itself when it has no
/// segment to strip.
///
/// An `@` in the first position is a scope's, not a segment separator (`@scope/pkg` is one name),
/// which is why the split is at the *last* `@`.
pub(crate) fn name_segment(handle: &str) -> &str {
    match handle.rsplit_once('@') {
        Some((name, _)) if !name.is_empty() => name,
        _ => handle,
    }
}

/// The source kind the engine records a marketplace installation under.
pub(crate) const MARKETPLACE: &str = "marketplace";

/// Whether one source describes a marketplace installation - the only kind that can switch source.
pub(crate) fn is_marketplace(source: &EnginePluginSource) -> bool {
    source.kind == MARKETPLACE
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::plugins::{EnginePluginRow, EnginePluginSource};

    fn row(
        id: &str,
        kind: &str,
        install_id: Option<&str>,
        marketplace: Option<&str>,
    ) -> EnginePluginRow {
        EnginePluginRow {
            id: id.to_owned(),
            install_id: install_id.map(str::to_owned),
            source: EnginePluginSource {
                kind: kind.to_owned(),
                marketplace: marketplace.map(str::to_owned),
                ..EnginePluginSource::default()
            },
            ..EnginePluginRow::default()
        }
    }

    /// The four shapes a row arrives in, and the two answers each one owes: a marketplace row from
    /// the current host, one from a host before `installId`, a scoped npm install, and a linked one.
    #[test]
    fn the_identity_is_the_plugin_id_and_the_handle_is_the_install_id() {
        let current = row(
            "demo-plugin",
            MARKETPLACE,
            Some("demo-plugin@market-a"),
            Some("market-a"),
        );
        assert_eq!(plugin_id(&current), "demo-plugin");
        assert_eq!(install_spec(&current), "demo-plugin@market-a");
        assert_eq!(source_marketplace(&current), Some("market-a"));

        let legacy = row("demo-plugin@market-a", MARKETPLACE, None, None);
        assert_eq!(plugin_id(&legacy), "demo-plugin");
        assert_eq!(install_spec(&legacy), "demo-plugin@market-a");

        let scoped = row("@scope/pkg", "npm", None, None);
        assert_eq!(plugin_id(&scoped), "@scope/pkg");
        assert_eq!(install_spec(&scoped), "@scope/pkg");

        let linked = row("demo-plugin", "link", None, None);
        assert_eq!(plugin_id(&linked), "demo-plugin");
        assert_eq!(install_spec(&linked), "demo-plugin");
    }

    /// A legacy scoped marketplace row is `@scope/pkg@marketplace`: the scope's `@` is not the
    /// separator, so the collapse must keep the whole package name - and an id with no separator at
    /// all is its own name.
    #[test]
    fn a_name_segment_is_split_at_the_last_at_of_a_real_handle() {
        assert_eq!(name_segment("@scope/pkg@market-a"), "@scope/pkg");
        assert_eq!(name_segment("demo-plugin@market-a"), "demo-plugin");
        assert_eq!(name_segment("@scope/pkg"), "@scope/pkg");
        assert_eq!(name_segment("demo-plugin"), "demo-plugin");
        assert_eq!(name_segment("@market-a"), "@market-a");
        assert_eq!(name_segment(""), "");
    }
}
