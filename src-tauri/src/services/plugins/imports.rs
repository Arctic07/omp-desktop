//! The import directories this application creates for a package file: what they are for, and what
//! an uninstall leaves of one.
//!
//! A package file the user picked is served to the engine through a catalogue this application
//! writes under its own `plugin-imports` directory (`services::plugins::package`), and that pair -
//! the marketplace row in the engine's registry and the directory the catalogue reads - is what
//! makes the installation upgradeable (spec §2.3, §3.4). It is also what makes them leftovers the
//! moment nothing is installed from them any more: the row names a marketplace with no install to
//! supply and no user who added it, and the directory is a package nothing resolves against. So an
//! uninstall asks this module whether the installation it just removed was the last one from such a
//! catalogue, and takes both with the installation when it was.
//!
//! The decision is [`import_dir_to_remove`]: pure, and deliberately conservative, because forgetting
//! a marketplace is not this layer's to do unless every fact says it is an import of ours - a name
//! this application built, a source that is a strict subdirectory of the import root
//! (`services::paths::import_dir_removable`), and a plugin list that holds no other installation from
//! it. A row that does not clear all of those stays, and stays harmless: the user can remove it
//! from the marketplace page, while a directory deleted out from under an installation still
//! upgrading from it is an install nobody can repair.
//!
//! The two writes live here rather than in the command layer because they are the pair the
//! marketplace page's own removal performs as well: the row goes through the host, the directory off
//! the runtime's thread, and sharing them here is what states "only this application's imports may
//! be deleted" once for both callers.

use std::path::{Path, PathBuf};

use crate::models::plugins::identity;
use crate::models::plugins::{
    EngineMarketplaceRow, EnginePluginRow, EnginePluginSource, EnginePluginsView,
};
use crate::services::log;
use crate::services::paths::import_dir_removable;
use crate::state::AppState;

use super::package;

/// The catalogue one removed installation came from, when it names a catalogue this application
/// imported.
///
/// The marketplace is a fact the host reports on the source (`source.marketplace`), which is what a
/// row's install handle is derived from - so it is read, never re-derived from an id by splitting
/// one (plan §4.4). A source with no marketplace carries the handle instead, and the handle's own
/// marketplace segment is the same fact; both are the host's report, and `rsplit_once` is applied to
/// *that*, not to whatever a caller named. Only a name carrying [`package::CATALOG_SUFFIX`] is one of
/// ours, so an npm scope's leading `@`, a marketplace the user added under a name of their own, and
/// an npm or linked install all answer `None` and leave every row where it is.
pub(crate) fn imported_catalog(source: &EnginePluginSource) -> Option<&str> {
    if !identity::is_marketplace(source) {
        return None;
    }
    let catalog = match source.marketplace.as_deref() {
        Some(marketplace) => marketplace,
        None => marketplace_segment(source.install_id.as_deref()?)?,
    };
    catalog
        .ends_with(package::CATALOG_SUFFIX)
        .then_some(catalog)
}

/// The marketplace segment of an engine handle (`name@marketplace`), or `None` when the handle is
/// not one (`@scope/pkg` is a package name, not a handle).
fn marketplace_segment(handle: &str) -> Option<&str> {
    let (name, marketplace) = handle.rsplit_once('@')?;
    (!name.is_empty() && !marketplace.is_empty()).then_some(marketplace)
}

/// The import directory an uninstall may also take with it, when it emptied an import catalogue.
///
/// `catalog` is the marketplace name [`imported_catalog`] read from the removed installation,
/// `marketplace` the registry's row of that name when the registry holds one, and `remaining` the
/// plugin list the uninstall answered with. The answer is the directory to remove, and it takes
/// every one of these:
///
/// - no row of `remaining` came from that catalogue: another installation still upgrades from it;
/// - the registry holds the row: a name no registry refers to has no source this layer can trust;
/// - the row's source is a strict subdirectory of `import_root` ([`import_dir_removable`]): a
///   marketplace added from a git URL - or one whose source *is* the import root - is not this
///   application's, and losing its row because a package happened to be imported under the same name
///   would be worse than any leftover.
///
/// The directory answered is the row's own source, which for an import this application made is
/// `<import_root>/<catalogue>` (`package::promote`).
pub(crate) fn import_dir_to_remove(
    import_root: &Path,
    catalog: &str,
    marketplace: Option<&EngineMarketplaceRow>,
    remaining: &[EnginePluginRow],
) -> Option<PathBuf> {
    if remaining.iter().any(|row| installed_from(row, catalog)) {
        return None;
    }
    let directory = PathBuf::from(marketplace?.source_uri.trim());
    import_dir_removable(import_root, &directory).then_some(directory)
}

/// Whether one row of a plugin list is an installation from `catalog`.
///
/// The marketplace a row came from is the host's own fact on the source (plan §4.1) - the same fact
/// the row's identity is derived from, and the reason nothing here splits an id: an npm package name
/// may carry an `@` of its own (a scope) while never coming from a marketplace at all, and the kind
/// is checked with it for exactly that reason.
fn installed_from(row: &EnginePluginRow, catalog: &str) -> bool {
    identity::is_marketplace(&row.source) && identity::source_marketplace(row) == Some(catalog)
}

/// Takes the marketplace row and the directory of an import with the installation that emptied it.
///
/// The list the uninstall answered with is the truth about what is installed, so the decision is
/// asked of that list rather than of a second read, and the registry is read once - only when the
/// removed id named an import catalogue at all. That list is read from exactly the registries the
/// removal itself addressed (the user registry plus the addressed workspace's project registry,
/// `host/src/plugins-facts.ts`), so an installation it does not hold is one the removal would not
/// have touched either; an installation another workspace's project registry keeps goes on running
/// and loses only the upgrade source, which is what removing a marketplace means for every plugin
/// installed from it. Both writes are best-effort: the installation is already gone and its list is
/// the answer the caller waits for, so a marketplace the host could not forget, or a directory that
/// could not be removed, is logged rather than returned - the same treatment the marketplace page's
/// own removal gives the same failures.
pub(crate) async fn remove_emptied_import(
    state: &AppState,
    installed: &EnginePluginsView,
    catalog: Option<&str>,
) {
    let Some(catalog) = catalog else {
        return;
    };
    let registry = match state.runtime.marketplaces().await {
        Ok(registry) => registry,
        Err(error) => {
            log::warn(&format!(
                "an import was not checked after an uninstall: {}",
                error.message
            ));
            return;
        }
    };
    let marketplace = registry.marketplaces.iter().find(|row| row.name == catalog);
    let Some(directory) = import_dir_to_remove(
        &state.paths.plugin_imports,
        catalog,
        marketplace,
        &installed.plugins,
    ) else {
        return;
    };
    match state.runtime.marketplace_remove(catalog).await {
        Ok(_) => {
            log::info(&format!(
                "the import of an uninstalled plugin was removed: catalog={catalog}"
            ));
            remove_directory(directory).await;
        }
        Err(error) => log::warn(&format!(
            "the marketplace of an uninstalled plugin was not removed: {}",
            error.message
        )),
    }
}

/// Removes the directory behind one marketplace source, when it is one of this application's imports.
///
/// Used where a marketplace is removed by name (the marketplace page's own removal): the row's
/// source is read before the host forgets it, and this is what decides whether the directory it
/// named is this application's to delete at all - a source that is the import root, or beside it,
/// keeps its row's fate and nothing more.
pub(crate) async fn remove_source_directory(import_root: &Path, source: &str) {
    let directory = PathBuf::from(source.trim());
    if import_dir_removable(import_root, &directory) {
        remove_directory(directory).await;
    }
}

/// Removes one directory off the runtime the frames are answered on.
///
/// Removing a package directory is the same kind of work as unpacking one, so it must not run on a
/// worker the webview's frames share. A directory that could not be removed is logged rather than
/// returned: both callers have already done the write the user asked for and owe that write's
/// answer, not this one's failure.
async fn remove_directory(directory: PathBuf) {
    let removed =
        tauri::async_runtime::spawn_blocking(move || std::fs::remove_dir_all(&directory)).await;
    match removed {
        Ok(Ok(())) => {}
        Ok(Err(error)) => log::warn(&format!(
            "imported package directory could not be removed: {error}"
        )),
        Err(_) => log::warn("imported package directory removal did not run"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::plugins::EnginePluginSource;

    /// One row of the plugin list as the host reports it: the plugin's own id, and the source facts
    /// the cleanup reads (the kind, and the marketplace an installation was recorded from).
    fn row(plugin_id: &str, kind: &str, marketplace: Option<&str>) -> EnginePluginRow {
        let install_id = marketplace.map(|marketplace| format!("{plugin_id}@{marketplace}"));
        EnginePluginRow {
            id: plugin_id.to_owned(),
            install_id: install_id.clone(),
            source: EnginePluginSource {
                kind: kind.to_owned(),
                marketplace: marketplace.map(str::to_owned),
                install_id,
                ..EnginePluginSource::default()
            },
            ..EnginePluginRow::default()
        }
    }

    /// The registry row of a catalogue that lives under this application's import root.
    fn import_row(root: &Path, catalog: &str) -> EngineMarketplaceRow {
        EngineMarketplaceRow {
            name: catalog.to_owned(),
            source_uri: root.join(catalog).to_string_lossy().into_owned(),
            ..EngineMarketplaceRow::default()
        }
    }

    /// Only a source that names a catalogue this application built is read as one; a bare name, an
    /// npm scope, somebody else's marketplace and a non-marketplace install all answer `None`, which
    /// keeps every row where it is. The catalogue is the host's own fact, never a split of an id.
    #[test]
    fn only_an_import_catalogue_source_is_read_as_one() {
        let mut imported = row("demo-plugin", "marketplace", Some("demo-plugin-import"));
        // The handle says the same thing, for a host that reports the marketplace only inside it.
        imported.source.marketplace = None;
        imported.source.install_id = Some("demo-plugin@demo-plugin-import".to_owned());
        assert_eq!(
            imported_catalog(&imported.source),
            Some("demo-plugin-import")
        );
        assert_eq!(
            imported_catalog(&row("demo-plugin", "marketplace", Some("demo-plugin-import")).source),
            Some("demo-plugin-import")
        );
        // Somebody else's marketplace: not one of ours.
        assert_eq!(
            imported_catalog(&row("demo-plugin", "marketplace", Some("some-marketplace")).source),
            None
        );
        // An npm scope is one name, and an npm or linked install has no marketplace at all.
        assert_eq!(
            imported_catalog(&row("@scope/demo-plugin", "npm", None).source),
            None
        );
        assert_eq!(
            imported_catalog(&row("demo-plugin", "link", None).source),
            None
        );
        // A host that reports neither fact proves nothing, so nothing is touched.
        assert_eq!(imported_catalog(&EnginePluginSource::default()), None);
    }

    /// The three answers the cleanup stands on: the last installation takes its catalogue with it,
    /// another installation from the same catalogue keeps both, and a marketplace that is not one of
    /// this application's imports is never touched.
    #[test]
    fn an_emptied_import_goes_and_a_used_one_stays() {
        let root = Path::new("data/plugin-imports");
        let catalog = "demo-plugin-import";
        let marketplace = import_row(root, catalog);

        let elsewhere = vec![row("other-plugin", "marketplace", Some("other-import"))];
        assert_eq!(
            import_dir_to_remove(root, catalog, Some(&marketplace), &elsewhere),
            Some(PathBuf::from("data/plugin-imports/demo-plugin-import")),
            "nothing is installed from the catalogue, and the row is one of this application's"
        );

        let remaining = vec![row(
            "demo-plugin",
            "marketplace",
            Some("demo-plugin-import"),
        )];
        assert_eq!(
            import_dir_to_remove(root, catalog, Some(&marketplace), &remaining),
            None,
            "a second installation from the catalogue still upgrades from it"
        );
        // The same id as an npm package is not an installation from the marketplace: the kind is
        // what makes the suffix mean a marketplace.
        let npm = vec![row("demo-plugin", "npm", None)];
        assert_eq!(
            import_dir_to_remove(root, catalog, Some(&marketplace), &npm),
            Some(PathBuf::from("data/plugin-imports/demo-plugin-import")),
            "an npm row that spells the same suffix is not an installation from the catalogue"
        );

        let foreign = EngineMarketplaceRow {
            name: catalog.to_owned(),
            source_uri: "https://github.com/owner/marketplace".to_owned(),
            ..EngineMarketplaceRow::default()
        };
        assert_eq!(
            import_dir_to_remove(root, catalog, Some(&foreign), &[]),
            None,
            "a marketplace whose source is not under the import root is somebody else's row"
        );
        // No row at all: there is no source to trust, so there is nothing to remove.
        assert_eq!(import_dir_to_remove(root, catalog, None, &[]), None);
    }

    /// The import root itself and a path that climbs out of it are never a directory to remove,
    /// however the registry spells them.
    #[test]
    fn the_import_root_itself_is_never_removed() {
        let root = Path::new("data/plugin-imports");
        let catalog = "demo-plugin-import";
        let at_the_root = EngineMarketplaceRow {
            name: catalog.to_owned(),
            source_uri: root.to_string_lossy().into_owned(),
            ..EngineMarketplaceRow::default()
        };
        assert_eq!(
            import_dir_to_remove(root, catalog, Some(&at_the_root), &[]),
            None
        );

        let climbing = EngineMarketplaceRow {
            name: catalog.to_owned(),
            source_uri: "data/plugin-imports/../../elsewhere".to_owned(),
            ..EngineMarketplaceRow::default()
        };
        assert_eq!(
            import_dir_to_remove(root, catalog, Some(&climbing), &[]),
            None
        );
    }
}
