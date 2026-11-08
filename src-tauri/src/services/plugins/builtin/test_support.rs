//! The fixture both of the built-in plugin's test modules build their rows with.
//!
//! Split out (`rules.md#single-file-line-limit`) so the identity tests (`builtin::tests`) and the seeding tests
//! (`builtin::sync::tests`) share one definition rather than two copies that could drift apart.

use super::*;
use crate::models::plugins::EnginePluginSource;

/// One host row of the shape the identity rule reads: the plugin's own id, the source kind, and -
/// for a marketplace install - the marketplace it came from. The engine handle is derived the way
/// the host derives it (`<plugin id>@<marketplace>`), so a fixture cannot spell a pair the host
/// would never report.
pub(super) fn row(plugin_id: &str, kind: &str, marketplace: Option<&str>) -> EnginePluginRow {
    let install_id = marketplace.map(|marketplace| format!("{plugin_id}@{marketplace}"));
    EnginePluginRow {
        id: plugin_id.to_owned(),
        install_id: install_id.clone(),
        source: EnginePluginSource {
            kind: kind.to_owned(),
            label: install_id.clone().unwrap_or_else(|| plugin_id.to_owned()),
            marketplace: marketplace.map(str::to_owned),
            install_id,
            installed: true,
            ..EnginePluginSource::default()
        },
        // The bundle is seeded at the shared scope; a row's scope is part of its identity
        // (`builtin::is_builtin_row`), so the fixture spells it rather than inheriting `""`.
        scope: BUILTIN_SCOPE.to_owned(),
        ..EnginePluginRow::default()
    }
}
