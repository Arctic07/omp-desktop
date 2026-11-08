//! The package import flow: one `.omp.zip`/`.piplug` file, turned into an installation through the
//! engine's own marketplace channel.
//!
//! The file comes from one of three places and ends in the same sequence whichever it is: the native
//! picker ([`install_package`]), a URL this application fetched itself ([`install_url`], through
//! `services::plugins::download`), or - the read-only half of the same flow - nothing at all, when
//! the user only asked what a file holds before agreeing to install it ([`inspect_package`]).
//!
//! A package file is unpacked by this process (`services::plugins::package`) into this application's
//! own import directory, and installed through the engine's marketplace channel: a one-entry
//! catalogue beside the unpacked package is added as a marketplace, and `name@catalogue` is
//! installed from it. That route is the one an unelevated Windows can walk (the engine copies the
//! package into its own cache and junctions it), which is the reason a package file is not simply
//! handed to the engine as a directory to link.
//!
//! **The unpacked package and its catalogue stay**, and that is what makes an imported plugin
//! upgradeable rather than a one-shot install (spec §2.3): they are the marketplace the engine
//! installed from, so `plugins_check_updates` can compare the catalogue's version with the installed
//! one, and an upgrade installs from the same catalogue. A second import of the same plugin replaces
//! that source (`package::promote`), so the newest package the user picked is what both the version
//! comparison and the next install resolve against. The catalogue's own lifetime is the other
//! module's business: the removal that empties it takes it, and the marketplace page's own removal
//! takes its directory (`services::plugins::imports`).
//!
//! What an import does once the source is in place is decided by the engine's own version rule,
//! never by a comparison of this layer's (spec §3.4):
//!
//! - nothing installed under that id → **install** from the catalogue, with the consent chain an
//!   install always runs (`services::plugins::consent_flow::install_from_source`);
//! - installed, and the engine reports the catalogue as newer → **upgrade** (the engine reinstalls
//!   the installation in place, keeping its confirmation and its enabled flag), then the same chain
//!   is left answered for the new code: the widened rows are reconciled and anything unconfirmed is
//!   quarantined (`consent_flow::{reconfirm_widened, quarantine_unconfirmed}`);
//! - installed at the same version → the list is answered unchanged, because the import changed the
//!   source and nothing else;
//! - installed at a different version the engine does *not* call newer → refused, because silently
//!   installing an older package over a newer one is a downgrade nobody asked for.
//!
//! The command layer sanitizes the scope, resolves the workspace and converts the answer; the
//! unpacking, the staging directory's lifetime and every decision above live here.

use std::path::Path;

use crate::errors::{
    IpcError, IpcResult, PLUGIN_DOWNLOAD_FAILED, PLUGIN_PACKAGE_INVALID, TASK_CANCELLED,
};
use crate::models::plugins::identity;
use crate::models::plugins::EnginePluginsView;
use crate::services::log;
use crate::services::paths::is_within;
use crate::services::plugins::consent;
use crate::services::plugins::consent_flow;
use crate::services::plugins::download;
use crate::services::plugins::package::{self, PackageInspection};
use crate::services::tasks::{TaskRun, TaskStage};
use crate::state::AppState;

/// Imports one package file the user picked and answers with the list as it stands afterwards.
///
/// The whole import is one call: the file is bounded and read (`package::archive_path`), a staging
/// directory is taken under the import root, the package is unpacked into it, promoted to the
/// directory its catalogue is served from, registered as a marketplace and installed or upgraded
/// from there ([`import_package`]).
///
/// A staging directory never outlives the call: a promoted one has already moved into place, and a
/// refused one is a half-unpacked tree nothing else can read. A failure to remove it is logged
/// rather than returned, because the answer the caller is waiting for is the import's own - the
/// refusal that got here is the one that is reported.
pub(crate) async fn install_package(
    state: &AppState,
    cwd: Option<&str>,
    project_key: Option<&str>,
    path: &str,
    scope: Option<&'static str>,
    run: &TaskRun,
) -> IpcResult<EnginePluginsView> {
    run.progress(TaskStage::Reading);
    let archive = package::archive_path(path)?;
    import_archive(state, cwd, project_key, &archive, scope, run).await
}

/// Imports one archive *this application* produced (a download), through the same path a picked file
/// takes.
///
/// The file is one this application named and wrote, so it is checked by the rules a picked file is
/// checked by - absolute, a regular file, inside the archive bound - and by no others: the suffix
/// rule is what tells a user's own file apart from everything else in their downloads folder, and a
/// staging name is not the user's file at all. Everything after the path is [`import_archive`]'s.
pub(crate) async fn install_downloaded(
    state: &AppState,
    cwd: Option<&str>,
    project_key: Option<&str>,
    archive: &Path,
    scope: Option<&'static str>,
    run: &TaskRun,
) -> IpcResult<EnginePluginsView> {
    run.progress(TaskStage::Reading);
    let archive = package::staged_archive_path(archive)?;
    import_archive(state, cwd, project_key, &archive, scope, run).await
}

/// Fetches one package from a URL the user pasted and installs it, through the same import path a
/// picked file takes.
///
/// The fetch is `services::plugins::download`'s - the scheme rule, the hand-followed redirects, the
/// two headers, the size ceiling and the mandatory checksum - and it runs on the blocking pool, like
/// every other file- and network-heavy step of an import. The file it writes is this application's
/// own staging name, and the install is [`install_downloaded`]'s.
///
/// Nothing of the download outlives the call whichever way it answers: a failed fetch removes its own
/// partial file, and a successful one is removed here once the import has read it. What an install
/// needs afterwards is the *unpacked* copy and its catalogue - which the import promoted into the
/// import root - not the archive it arrived in.
pub(crate) async fn install_url(
    state: &AppState,
    cwd: Option<&str>,
    project_key: Option<&str>,
    url: &str,
    sha256: &str,
    scope: Option<&'static str>,
    run: &TaskRun,
) -> IpcResult<EnginePluginsView> {
    run.progress(TaskStage::Reading);
    let import_root = state.paths.plugin_imports.clone();
    let destination = package::download_staging_path(&import_root).map_err(|error| {
        IpcError::from_message(
            PLUGIN_DOWNLOAD_FAILED,
            format!("The download could not be started: {error}"),
        )
    })?;
    let url = url.to_owned();
    let expected = sha256.to_owned();
    let into = destination.clone();
    let fetched =
        tauri::async_runtime::spawn_blocking(move || download::download(&url, &into, &expected))
            .await
            .map_err(|_| IpcError::new(PLUGIN_DOWNLOAD_FAILED, "The download did not finish."))?;
    let outcome = match fetched {
        Ok(outcome) => outcome,
        Err(error) => {
            remove_download(&destination);
            return Err(error);
        }
    };
    log::info(&format!(
        "plugin package downloaded, {} bytes, sha256={}",
        outcome.bytes, outcome.sha256
    ));
    ensure_not_cancelled_before(run, &destination)?;
    let imported = install_downloaded(state, cwd, project_key, &destination, scope, run).await;
    remove_download(&destination);
    imported
}

/// The cancellation boundary of a URL install, which owns a file the other steps do not.
///
/// A run stopped between the download and the import is still holding the archive it just wrote, so
/// the file goes before the refusal travels on: leaving it behind would be a partial package nothing
/// is going to read, and the staging prefix is only swept at the next start.
fn ensure_not_cancelled_before(run: &TaskRun, download: &Path) -> IpcResult<()> {
    if run.cancelled() {
        remove_download(download);
        return Err(IpcError::new(
            TASK_CANCELLED,
            "The install was cancelled before it changed anything.",
        ));
    }
    Ok(())
}

/// Reads one package file without installing anything, and answers what it holds.
///
/// The preview half of the same flow: the archive is unpacked into a staging directory this function
/// removes whichever way the read answers, and every fact it reports comes from the file itself
/// (`package::inspect`). Nothing is registered, promoted or installed, so a user who reads the card
/// and changes their mind has changed nothing.
pub(crate) async fn inspect_package(state: &AppState, path: &str) -> IpcResult<PackageInspection> {
    let archive = package::archive_path(path)?;
    let import_root = state.paths.plugin_imports.clone();
    let staging = package::staging_dir(&import_root).map_err(|error| {
        IpcError::from_message(
            PLUGIN_PACKAGE_INVALID,
            format!("The unpacking directory could not be created: {error}"),
        )
    })?;
    let into = staging.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || package::inspect(&archive, &into))
        .await
        .map_err(|_| IpcError::new(PLUGIN_PACKAGE_INVALID, "The package was not read."))?
        .map_err(package::PackageRefusal::into_ipc);
    if staging.exists() {
        if let Err(error) = std::fs::remove_dir_all(&staging) {
            log::warn(&format!(
                "the inspection's staging directory could not be removed: {error}"
            ));
        }
    }
    outcome
}

/// The import itself, from an archive that has already been checked.
///
/// A staging directory is taken under the import root, the package is unpacked into it, promoted to
/// the directory its catalogue is served from, registered as a marketplace and installed or upgraded
/// from there ([`import_package`]). The staging directory never outlives the call, and a failure to
/// remove it is logged rather than returned: the answer the caller is waiting for is the import's own.
async fn import_archive(
    state: &AppState,
    cwd: Option<&str>,
    project_key: Option<&str>,
    archive: &Path,
    scope: Option<&'static str>,
    run: &TaskRun,
) -> IpcResult<EnginePluginsView> {
    let import_root = state.paths.plugin_imports.clone();
    let staging = package::staging_dir(&import_root).map_err(|error| {
        IpcError::from_message(
            PLUGIN_PACKAGE_INVALID,
            format!("The unpacking directory could not be created: {error}"),
        )
    })?;
    let outcome = import_package(
        state,
        cwd,
        project_key,
        archive,
        &staging,
        &import_root,
        scope,
        run,
    )
    .await;
    if staging.exists() {
        if let Err(error) = std::fs::remove_dir_all(&staging) {
            log::warn(&format!(
                "plugin import staging directory could not be removed: {error}"
            ));
        }
    }
    outcome
}

/// Removes one download's file, logging a failure rather than reporting it.
///
/// The answer the caller is waiting for is the import's, and a file that could not be removed carries
/// the staging prefix the next start sweeps (`package::sweep_staging`), so there is nothing a caller
/// could do with the failure either.
fn remove_download(path: &Path) {
    if !path.exists() {
        return;
    }
    if let Err(error) = std::fs::remove_file(path) {
        log::warn(&format!(
            "a downloaded package could not be removed: {error}"
        ));
    }
}

/// Stops one run at the next boundary, as the refusal its caller reports as a cancellation.
fn ensure_not_cancelled(run: &TaskRun) -> IpcResult<()> {
    if run.cancelled() {
        return Err(IpcError::new(
            TASK_CANCELLED,
            "The import was cancelled before it changed anything.",
        ));
    }
    Ok(())
}

/// Unpacks one package file, promotes it to its own import directory, and installs or upgrades from
/// the catalogue that lives there.
///
/// The three disk steps are the same three a package import always runs, and they are ordered by
/// what the next one reads: the archive is unpacked into `staging`, the catalogue describing the
/// package is written beside it, and the whole directory is promoted to
/// `<import_root>/<catalog_name>` - one directory per package name, replaced on every import so the
/// catalogue always describes the package the user picked last. The engine then has to be told about
/// the directory before it is asked anything about it, because the marketplace it installs from is
/// its own cached copy of the catalogue ([`ensure_import_marketplace`]).
///
/// The decision that follows is [`import_flow`](self)'s version rule: a first import installs, a
/// newer package upgrades and then runs the consent chain over the new list, the same version
/// answers the list unchanged, and an older one is refused.
#[allow(clippy::too_many_arguments)]
async fn import_package(
    state: &AppState,
    cwd: Option<&str>,
    project_key: Option<&str>,
    archive: &Path,
    staging: &Path,
    import_root: &Path,
    scope: Option<&'static str>,
    run: &TaskRun,
) -> IpcResult<EnginePluginsView> {
    // The steps are reported as they are taken, and the flag is read between them: an import that is
    // stopped leaves a whole package behind or none, never a half-promoted directory (see
    // `services::tasks`).
    run.progress(TaskStage::Unpacking);
    let unpack_archive = archive.to_path_buf();
    let unpack_into = staging.to_path_buf();
    let unpacked = tauri::async_runtime::spawn_blocking(move || {
        package::unpack(&unpack_archive, &unpack_into)
    })
    .await
    .map_err(|_| IpcError::new(PLUGIN_PACKAGE_INVALID, "The package was not unpacked."))?
    .map_err(package::PackageRefusal::into_ipc)?;
    log::info(&format!(
        "plugin package {} unpacked, sha256={}",
        unpacked.catalog_name, unpacked.archive_sha256
    ));

    ensure_not_cancelled(run)?;
    run.progress(TaskStage::Cataloguing);
    let catalog = unpacked.clone();
    let catalog_root = staging.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || package::write_catalog(&catalog_root, &catalog))
        .await
        .map_err(|_| {
            IpcError::new(
                PLUGIN_PACKAGE_INVALID,
                "The package catalogue was not written.",
            )
        })?
        .map_err(|error| {
            IpcError::from_message(
                PLUGIN_PACKAGE_INVALID,
                format!("The package catalogue could not be written: {error}"),
            )
        })?;

    ensure_not_cancelled(run)?;
    run.progress(TaskStage::Installing);
    // Where this import lives from now on: one directory per package name, replaced on every import
    // so the catalogue always describes the package the user picked last.
    let source = import_root.join(&unpacked.catalog_name);
    let promote_from = staging.to_path_buf();
    let promote_to = source.clone();
    tauri::async_runtime::spawn_blocking(move || package::promote(&promote_from, &promote_to))
        .await
        .map_err(|_| {
            IpcError::new(
                PLUGIN_PACKAGE_INVALID,
                "The import was not moved into place.",
            )
        })?
        .map_err(|error| {
            IpcError::from_message(
                PLUGIN_PACKAGE_INVALID,
                format!("The import could not be moved into place: {error}"),
            )
        })?;

    // The catalogue the engine compares and installs from is its own cached copy of this directory,
    // so a package that replaced an earlier one has to be re-read before it is asked about.
    if ensure_import_marketplace(state, &unpacked.catalog_name, &source).await? {
        state
            .runtime
            .marketplace_update(Some(&unpacked.catalog_name))
            .await?;
    }

    let current = state.runtime.plugins(cwd).await?;
    // The installations this import could be replacing, in the domain's own vocabulary: an import
    // has to name the installation it addresses before it asks (spec §6.5). The package's own name is
    // the plugin id; the handle it will be installed under is what the engine write addresses.
    let installs = consent::installs(&current.plugins, &unpacked.plugin_name, None);
    if installs.is_empty() {
        // A first import: install from the catalogue that was just added.
        return consent_flow::install_from_source(
            state,
            cwd,
            project_key,
            &unpacked.install_spec,
            scope,
        )
        .await;
    }

    let target_scope = consent::import_target_scope(&installs, scope)?;
    let imported_version = unpacked.version.clone().unwrap_or_default();
    if import_is_newer(state, cwd, &unpacked.plugin_name, target_scope).await? {
        // The engine is about to reinstall a newer version over the installed one: the last step is
        // an update, and the page says so while it runs (`TaskStage::Updating`).
        run.progress(TaskStage::Updating);
        let upgraded = state
            .runtime
            .plugin_upgrade(cwd, Some(&unpacked.install_spec), Some(target_scope))
            .await?;
        // A replacement that brings reasons the confirmed version did not is a decision the user has
        // not made: it is switched off and its confirmation forgotten before the list is answered
        // (spec §6.5), and anything left unconfirmed is quarantined by the same chain an install runs.
        let reconciled =
            consent_flow::reconfirm_widened(state, cwd, project_key, &current.plugins, upgraded)
                .await?;
        return consent_flow::quarantine_unconfirmed(state, cwd, project_key, reconciled).await;
    }

    // The installed version comes from the engine's own row, not from the domain's projection: which
    // version is installed is the engine's fact, and the comparison below is only "the same string".
    let installed_version = current
        .plugins
        .iter()
        .find(|row| identity::plugin_id(row) == unpacked.plugin_name && row.scope == target_scope)
        .and_then(|row| row.version.clone())
        .unwrap_or_default();
    if installed_version.trim() == imported_version.trim() {
        // The same version, re-imported: the source was replaced and nothing else changed.
        return Ok(current);
    }
    Err(IpcError::from_message(
        PLUGIN_PACKAGE_INVALID,
        format!(
            "The package declares version {imported_version}, which the engine does not report as newer than the installed {installed_version}; uninstall it first to move to an older version."
        ),
    ))
}

/// Whether the engine reports the catalogue as newer than what is installed — its own version rule,
/// asked rather than re-derived (spec §3.4: the desktop only shows and triggers upgrades).
///
/// The answer is the update check's own list, narrowed to the one plugin the import addresses at that
/// scope (`pluginId`, the identity, not the handle the row may be installed under): the engine
/// compares the catalogue against what is installed at that scope, and this layer only reads which
/// way it answered.
async fn import_is_newer(
    state: &AppState,
    cwd: Option<&str>,
    plugin_id: &str,
    scope: &str,
) -> IpcResult<bool> {
    // The import addresses one workspace, and so does the check: the engine's project registry is
    // per workspace, and a cwd-less check only ever sees the host's default one.
    let updates = state.runtime.plugin_check_updates(cwd).await?;
    Ok(updates
        .updates
        .iter()
        .any(|update| update.plugin_id == plugin_id && update.scope == scope))
}

/// Makes sure one imported package is a registered marketplace, answering whether the engine's
/// cached copy of its catalogue has to be refreshed.
///
/// The catalogue's name is derived from the package name, so the row that already holds it is either
/// this package's own earlier import (its source is this application's import directory) or somebody
/// else's marketplace. The first is left in place and refreshed; a row whose source is gone is a
/// leftover from an interrupted import and is replaced; a row that really is somebody else's is
/// refused, because deleting a marketplace the user added is not this flow's to do.
async fn ensure_import_marketplace(
    state: &AppState,
    catalog_name: &str,
    source: &Path,
) -> IpcResult<bool> {
    let registry = state.runtime.marketplaces().await?;
    let Some(existing) = registry
        .marketplaces
        .iter()
        .find(|row| row.name == catalog_name)
    else {
        state
            .runtime
            .marketplace_add(&source.to_string_lossy())
            .await?;
        return Ok(false);
    };
    let registered = Path::new(existing.source_uri.trim());
    if is_within(source, registered) {
        return Ok(true);
    }
    if !registered.exists() {
        state.runtime.marketplace_remove(catalog_name).await?;
        state
            .runtime
            .marketplace_add(&source.to_string_lossy())
            .await?;
        return Ok(false);
    }
    Err(IpcError::from_message(
        PLUGIN_PACKAGE_INVALID,
        format!(
            "A marketplace named \"{catalog_name}\" already exists and points at its own source; remove it or rename the package first."
        ),
    ))
}
