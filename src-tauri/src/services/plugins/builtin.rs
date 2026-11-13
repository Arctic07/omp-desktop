//! The plugins this application ships with: the definitions, and the guards around them.
//!
//! What is *not* a plugin is the capability behind a surface: a terminal is a pty this process owns
//! (`services::terminal`), because a sandboxed plugin document cannot hold one. What this module
//! defines is the plugin half - the packages, their installation and trust, and the tabs they
//! contribute (`rules.md#built-in-capabilities`):
//!
//! - **definitions** ([`BUILTIN_DEFINITIONS`]): every plugin this build carries, as data rather than
//!   as code. A definition names the package, the installation id the engine derives for it and the
//!   directory under the bundle's `package/` that holds it. Adding a plugin is a new entry here, its
//!   `package/<name>/` directory and its catalogue entry - no code path changes, and the seeding
//!   half reads the table rather than one hard-coded package (`builtin::sync`);
//! - **identity**: one marketplace name, and per definition a package name and the installation id
//!   the engine derives from the two. Everything that has to recognise "this is one we ship" - the
//!   DTO's `builtin` flag, the process gate's built-in exemption, the two writes that must not touch
//!   it - asks here rather than spelling the strings again;
//! - **seeding** ([`sync_bundle`]): the bundled catalogue is registered as a marketplace and
//!   installed once, through the engine's own manager and the consent chain an install always runs.
//!   A later start finds the installation and does nothing; an *enabled* installation is compared
//!   with the bundle through the engine's own update check, and only an update the engine reports is
//!   applied. An installation the user disabled is left exactly as it is - nothing is downloaded,
//!   no marketplace is refreshed, it is not re-enabled, and none of its pages or assets are loaded -
//!   until the user switches it on again, at which point a pending bundled update may be applied
//!   first. (Reading the bundled `package.json` for its version is not a page load: it is this
//!   application reading a file it shipped, and it happens whether or not the plugin is enabled.);
//! - **protection** ([`marketplace_removal_refusal`], [`install_refusal`]): the reserved
//!   marketplace and a *direct* install of the reserved installation are the things this
//!   application refuses, so the seed stays the only writer of the installation it ships. The proof
//!   is the marketplace check, not a name: a package or a catalogue that merely spells the reserved
//!   identity without having come from the bundle stays the user's to install and remove, which is
//!   what keeps a conflict recoverable without a restart;
//! - **protection** ([`protection_refusal`]): a *verified* built-in installation is not the user's
//!   to switch off or remove - it is the surface the build promises, and the skills it carries with
//!   it. The proof that a row really is this application's is again the marketplace check, so a
//!   package that merely spells the reserved id from somewhere else stays an ordinary plugin. A
//!   suppression record written by an earlier build (when removal was supported) is cleared by the
//!   seed, so those data roots get their built-ins back instead of staying empty forever.
//!
//! Nothing here writes an engine registry file, and nothing here re-implements the engine's
//! classification: the marketplace row, the install, the enable and the upgrade all go through
//! `services::runtime` (spec §0.1, `rules.md#engine-integration-and-data-ownership`). The version comparison is the engine's own
//! answer (`plugin_check_updates`), never a string comparison of ours.

use std::path::Path;

use serde_json::Value;

use crate::errors::{
    IpcError, PLUGIN_BUILTIN_PROTECTED, PLUGIN_BUILTIN_UNKNOWN, PLUGIN_INSTALL_RESERVED,
    PLUGIN_MARKETPLACE_RESERVED,
};
use crate::models::plugins::identity;
use crate::models::plugins::{EnginePluginRow, EnginePluginsView};
use crate::services::paths::is_within;
use crate::state::AppState;

mod sync;

// The seeding half moved to `sync` (`rules.md#single-file-line-limit`). These four names are its contract with the
// rest of the crate, re-exported here so every existing caller keeps naming them through `builtin`:
// this is a module split, not a forwarding layer.
pub(crate) use sync::{restore, sync_bundle, BuiltinSync, SyncReason};

/// The reserved marketplace a bundled catalogue is published from: the name a definition's
/// installation id is derived against, and the one that bundle's own catalogue has to declare
/// (`sync::bundle::resolve_bundle`). It is not a user's marketplace: it has no remote source, it
/// exists only so the engine has a catalogue to install from, and a row that really points at this
/// application's bundle cannot be removed (`marketplace_removal_refusal` - which deliberately allows
/// removing a *different* source holding the same name, because that row is the conflict the seed
/// fails closed on and removing it is the way out).
pub(crate) const BUILTIN_MARKETPLACE_NAME: &str = "omp-desktop-builtin";

/// The bundle resource a bundled catalogue is read from (`tauri.conf.json`, `bundle.resources`).
///
/// The directory name is part of an existing installation's identity: the engine's marketplace row
/// records this path as its `source_uri`, and renaming the resource makes `reserved_source_verified`
/// false for every installation that predates the rename (spec §17). The name comes from the first
/// plugin this bundle shipped, which has since been retired; today the catalogue holds only
/// `omp.terminal`. It is kept verbatim because the installs it points at cannot be re-pointed without
/// breaking them.
pub(crate) const BUILTIN_RESOURCE_DIR: &str = "builtin-browser-marketplace";

/// The scope the built-in plugins are installed at: the one installation every workspace shares.
pub(crate) const BUILTIN_SCOPE: &str = "user";

/// One plugin this build ships. Adding one is a new entry here plus its
/// `package/<name>/` directory and its catalogue entry — no code path changes.
///
/// The four fields are the whole of a definition, and each of them is a string or a permission the
/// rest of the crate would otherwise spell again: the package name the manifest declares, the
/// installation id the engine derives from the package and the reserved marketplace, the directory
/// under `<bundle>/package/` that holds the package, and whether the user may switch this definition
/// off. A definition is still not the user's to remove; `toggleable` only widens the switch.
pub(crate) struct BuiltinDef {
    /// `package.json#name`, and the name the engine reports.
    pub(crate) name: &'static str,
    /// The installation id the engine derives (`name@marketplace`).
    pub(crate) install_id: &'static str,
    /// The directory under `<bundle>/package/` that holds this package.
    pub(crate) package_dir: &'static str,
    /// Whether the user's own switch may turn this built-in off. `false` keeps the switch closed
    /// (`PLUGIN_BUILTIN_PROTECTED`); removal is refused either way.
    pub(crate) toggleable: bool,
}

/// Every plugin this build ships, in the order the surfaces list them.
///
/// The entries below are what every rule in this module and in `builtin::sync` iterates: nothing
/// there names a package, an installation or a directory of its own. `tests` pins every value
/// against its literal.
///
/// The terminal contributes a work-panel tab this application draws itself
/// (`omp.desktop.workPanelTabs`), so there is no document of its own for the page registry to serve.
/// The browser is a first-party surface now, not a plugin: it draws its own tab and needs no bundle.
///
/// The auto-continue plugin carries no page: it is one engine extension (`omp.extensions`) that
/// resumes a turn a provider interrupted, and its switch is the user's because that behaviour is
/// not a surface the build promises. Removal stays refused like every built-in.
pub(crate) const BUILTIN_DEFINITIONS: &[BuiltinDef] = &[
    BuiltinDef {
        name: "omp.terminal",
        install_id: "omp.terminal@omp-desktop-builtin",
        package_dir: "omp.terminal",
        toggleable: false,
    },
    BuiltinDef {
        name: "omp.auto-continue",
        install_id: "omp.auto-continue@omp-desktop-builtin",
        package_dir: "omp.auto-continue",
        toggleable: true,
    },
];

/// The definition one plugin id belongs to, when this build ships it.
///
/// The lookup is by the *plugin's own id* (`package.json#name`), which is the identity every row,
/// grant and page is keyed by since plan D0 - never by the engine's `name@marketplace` handle,
/// which a package can spell for itself from anywhere.
pub(crate) fn def_for_plugin_id(id: &str) -> Option<&'static BuiltinDef> {
    BUILTIN_DEFINITIONS.iter().find(|def| def.name == id)
}

/// Whether one plugin id is one of the built-in plugins'.
pub(crate) fn is_builtin_plugin(id: &str) -> bool {
    def_for_plugin_id(id).is_some()
}

/// Whether one engine target (the handle a write command addresses) is a built-in installation's.
///
/// The target is the engine's handle, so this is the one rule that still reads it: the seed, the
/// enable and the switch ask it to decide whether the write they are about to make is about the
/// plugin this application ships. Nothing that judges *trust* reads a handle (see
/// [`is_builtin_row`]); this only answers "is this write addressed at the one we seeded".
pub(crate) fn is_builtin_install_spec(target: &str) -> bool {
    BUILTIN_DEFINITIONS
        .iter()
        .any(|def| def.install_id == target.trim())
}

/// The manifest one built-in definition declares inside the bundle this build shipped with, when it
/// has a readable copy of it.
///
/// The read is `<bundle>/package/<def.package_dir>/package.json` - the file the installer wrote
/// beside the catalogue - and it is read for display only: `engine_builtin_plugins` shows the name,
/// description and version a definition declares, and the seeding half reads the same file for the
/// version it synchronizes. A build without a readable bundle answers `None`, which the caller
/// reports as an unversioned row rather than as a failure.
pub(crate) fn definition_manifest(
    state: &AppState,
    app: &tauri::AppHandle,
    def: &BuiltinDef,
) -> Option<Value> {
    let root = state.builtin_sync.bundle_root(app)?;
    let text = std::fs::read_to_string(
        root.join("package")
            .join(def.package_dir)
            .join("package.json"),
    )
    .ok()?;
    serde_json::from_str(&text).ok()
}

/// Whether one host row *is* the built-in installation, judged from the facts the host reports
/// about where it came from.
///
/// Three facts, and no spelling: the plugin's own id names a definition this build ships
/// ([`def_for_plugin_id`]), the row lives at the scope the bundle is seeded at, and the marketplace
/// it came from is the reserved one ([`identity::source_marketplace`]). What makes those facts
/// *trustworthy* is the marketplace check the caller applies on top ([`apply_trust`],
/// [`write_refusal`]): the reserved registration must point at this build's bundle. A registration
/// holding the name against another source is either an earlier build's leftover - the seed
/// repoints it at this build's absolute bundle directory - or somebody else's, which keeps the seed
/// unseeded and these rows unprotected.
pub(crate) fn is_builtin_row(row: &EnginePluginRow) -> bool {
    // The scope is part of the installation's identity: the bundle is seeded at [`BUILTIN_SCOPE`],
    // and a project-scope row of the same plugin is somebody else's installation.
    row.scope == BUILTIN_SCOPE
        && identity::is_marketplace(&row.source)
        && identity::source_marketplace(row) == Some(BUILTIN_MARKETPLACE_NAME)
        && is_builtin_plugin(identity::plugin_id(row).as_ref())
}

/// Writes this side's trust mark onto a host list, before anything reads it.
///
/// The mark is what the DTO's `builtin` flag and the process gate's built-in exemption read, so it
/// is applied in exactly one place (`commands::plugin_pages::publish_pages`), on every list any
/// command answers with - a read, an install, a switch. `trusted` is the process's own answer to
/// "is the reserved marketplace this application's bundled catalogue", and a row keeps the mark only
/// while both halves hold.
///
/// The switch answer is written here too, once, and carried to the page unchanged
/// (`PluginRowView::toggleable`): the control and the refusal then read one decision rather than two
/// derivations of it (`switch_open`).
pub(crate) fn apply_trust(view: &mut EnginePluginsView, trusted: bool) {
    for row in view.plugins.iter_mut() {
        let builtin = trusted && is_builtin_row(row);
        row.builtin = builtin;
        row.toggleable = switch_open(builtin, identity::plugin_id(row).as_ref());
    }
}

/// Whether the user's own switch may turn one installation off.
///
/// The one predicate both sides read: the page's control (`apply_trust`) and the write that would
/// arrive anyway (`protection_refusal`). An ordinary plugin is always the user's to switch; a
/// built-in only when the definition this build carries opted in, which is a fact about the
/// *definition* rather than about the row, so an installation from somebody else's marketplace keeps
/// its ordinary answer.
pub(crate) fn switch_open(builtin: bool, plugin_id: &str) -> bool {
    !builtin || def_for_plugin_id(plugin_id).is_some_and(|def| def.toggleable)
}

/// The refusal a removal of the reserved marketplace earns, when the row really is this
/// application's own.
///
/// The name alone is not the fact. A row holding the reserved name against somebody else's source is
/// exactly the conflict [`sync_bundle`] fails closed on, and refusing to remove *that* would leave
/// the user with no way out of it - the name would be permanently taken, the bundled catalogue
/// unreachable, and no surface able to fix it. So removal is refused only while the registered
/// source is inside the bundle this application shipped with, which is the fact that makes the row
/// this application's. When the bundle cannot be resolved there is nothing to compare against, and
/// the row is treated as the user's to manage rather than as ours to protect: a removal refusal is a
/// denial of a user action, and denying it without proof is what turns a conflict into a dead end.
pub(crate) fn marketplace_removal_refusal(
    name: &str,
    source: Option<&str>,
    bundle: Option<&Path>,
) -> Option<IpcError> {
    if name != BUILTIN_MARKETPLACE_NAME {
        return None;
    }
    let (Some(root), Some(source)) = (bundle, source) else {
        return None;
    };
    if !is_within(root, Path::new(source.trim())) {
        return None;
    }
    Some(IpcError::new(
        PLUGIN_MARKETPLACE_RESERVED,
        "This marketplace ships with the application and cannot be removed.",
    ))
}

/// Which write a built-in protection question is about.
///
/// The switch and the removal are different asks: a definition may let the user stop the code it
/// runs without letting them take the installation away. This enum is the one place the difference
/// is named, so every write path passes it rather than deciding on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BuiltinWrite {
    /// The user's own switch, turning a running installation off.
    SwitchOff,
    /// A removal, or a source switch that removes the installation first.
    Remove,
}

/// The refusal a write that would take a built-in plugin away earns, judged over the rows that
/// write addresses.
///
/// Built-ins are the surfaces the build promises (the terminal's tab) and the skills they carry, so
/// a removal is always refused and a switch-off is refused unless the definition opted in
/// (`BuiltinDef::toggleable`). Their controls follow the same facts; this is the answer a write
/// that arrives anyway gets.
///
/// `verified` is this process's own answer to "is the reserved marketplace the bundle we shipped"
/// ([`marketplace_verified`]). The row facts alone do not make a write ours: a package installed from
/// a marketplace that merely spells the reserved name is the conflict the seed fails closed on, and
/// it stays the user's to manage - refusing that would leave them no way out of it. A same-named
/// install from any *other* marketplace is not [`is_builtin_row`] at all, so it is refused by
/// nothing here.
pub(crate) fn protection_refusal(
    targets: &[&EnginePluginRow],
    verified: bool,
    write: BuiltinWrite,
) -> Option<IpcError> {
    let protected = verified
        && targets.iter().any(|row| {
            let builtin = is_builtin_row(row);
            match write {
                BuiltinWrite::Remove => builtin,
                BuiltinWrite::SwitchOff => !switch_open(builtin, identity::plugin_id(row).as_ref()),
            }
        });
    protected.then(|| {
        let message = match write {
            BuiltinWrite::SwitchOff => {
                "This plugin ships with the application: its switch cannot be turned off."
            }
            BuiltinWrite::Remove => {
                "This plugin ships with the application: it cannot be disabled or removed."
            }
        };
        IpcError::new(PLUGIN_BUILTIN_PROTECTED, message)
    })
}

/// The same refusal, with the marketplace check read only when a row could be ours.
///
/// The check is a registry read (`marketplace_verified`), and the overwhelmingly common write is
/// about a plugin this build does not ship - so it is asked only after the row facts already match a
/// definition. A caller that found no row to address gets no refusal either way: the engine's own
/// answer about an installation it does not have is the honest one.
pub(crate) async fn write_refusal(
    state: &AppState,
    app: &tauri::AppHandle,
    targets: &[&EnginePluginRow],
    write: BuiltinWrite,
) -> Option<IpcError> {
    if !targets.iter().any(|row| is_builtin_row(row)) {
        return None;
    }
    protection_refusal(targets, marketplace_verified(state, app).await, write)
}

/// The refusal a restore of something other than the built-in installation earns.
///
/// The restore command names one plugin id, so this can only answer about that id - the check is
/// written out anyway, because it is the boundary of the command: nothing but a plugin this
/// application ships may be seeded back through it, and an id it does not ship is answered rather
/// than silently seeding whatever the caller named.
pub(crate) fn restore_refusal(id: &str) -> Option<IpcError> {
    (!is_builtin_plugin(id)).then(|| {
        IpcError::new(
            PLUGIN_BUILTIN_UNKNOWN,
            "This plugin is not one the application ships with.",
        )
    })
}

/// Whether the reserved marketplace points at the bundle this application shipped with, read from
/// the registry now.
///
/// The seed caches its own answer for the list path; this is the same question asked fresh, for the
/// writes that have to decide whether a reserved id is this application's - a user who never opened
/// the plugin page still must not be able to uninstall the terminal's tab. A build with no bundle,
/// an unregistered name, or a name holding somebody else's source all answer `false`: nothing can be
/// proven to be this application's, so nothing is protected on that ground.
pub(crate) async fn marketplace_verified(state: &AppState, app: &tauri::AppHandle) -> bool {
    let Some(root) = state.builtin_sync.bundle_root(app) else {
        return false;
    };
    sync::reserved_source_verified(state, &root)
        .await
        .unwrap_or(false)
}

/// The refusal a *direct* install of a reserved installation earns.
///
/// The built-in plugins are installed by the seed itself ([`sync_bundle`]), which talks to the
/// runtime directly; a caller naming a reserved `name@marketplace` through the public install route
/// is asking this application to replace or re-enable what the user's own switch decided - and an
/// install is the engine's write, which is free to enable what it installs. So the route is closed
/// for those sources and open for every other, including an import of a package that merely carries
/// the same package name (its catalogue is `<name>-import`, so it is a different spec and a
/// different installation).
pub(crate) fn install_refusal(source: &str) -> Option<IpcError> {
    is_builtin_install_spec(source).then(|| {
        IpcError::new(
            PLUGIN_INSTALL_RESERVED,
            "This plugin is installed by the application itself and is not installed from a source.",
        )
    })
}

#[cfg(test)]
mod test_support;

#[cfg(test)]
mod tests;
