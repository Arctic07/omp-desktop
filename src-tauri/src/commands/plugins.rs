//! The plugin commands: what is installed in a workspace, what can be installed or upgraded, one
//! plugin's settings, the consent grants this application keeps, and the plugins this application
//! ships with (what became of each, and the way back from a removal).
//!
//! The marketplace registry and its catalogue - what can be installed from where - are the store's
//! own half of the domain and live in `commands::plugin_marketplaces` (`rules.md#single-file-line-limit`): this module
//! is about installations that exist, that one is about sources they could come from.
//!
//! Every command here is the thin half of its pair. It checks what this process can judge on its
//! own - argument shape and bounds (`services::plugins::validate`), one settings value against the
//! schema the host just reported - then hands the request to the host and returns the host's
//! answer, converted to the row shape the page declares. Everything that needs engine knowledge
//! stays on the far side of the pipe: which plugins exist, what an install source resolves to, what
//! a plugin's manifest declares, what the engine's settings currently hold.
//!
//! Two writes are more than one call, and each has a service of its own. The consent chain - an
//! install quarantines what it added, an enable is answered by the confirmation record, a withdrawal
//! switches off before it forgets, an upgrade reconciles the rows it widened, a removal forgets
//! everything of that id - is `services::plugins::consent_flow`, which is what reads the host and
//! the store in the order the chain requires; one package file's import - unpack, catalogue,
//! promote, register, install or upgrade - is `services::plugins::import_flow`, which hands the
//! consent half to the same chain. Neither a decision nor an order is left here: this layer
//! sanitizes the arguments, calls one of them, and converts the answer.
//!
//! An installation is named by three things - the plugin id, the scope and, for the project scope,
//! the workspace it lives in - so every command reads its workspace identity from the id the caller
//! sent (`workspace_key` below) and uses it on both sides: the confirmation a write records is the
//! one the enable gate and the install quarantine look up. What a workspace's own view of the record
//! holds, and why a workspace that cannot be named is read as unconfirmed rather than substituted
//! for, is stated on that helper.

use serde_json::Value;
use tauri::State;

use crate::errors::{
    IpcError, IpcResult, INVALID_INPUT, PLUGIN_BUILTIN_UNKNOWN, PLUGIN_INSTALL_FAILED,
    TASK_CANCELLED,
};
use crate::models::plugins::identity;
use crate::models::plugins::{
    BuiltinPluginRow, BuiltinPluginsView, EnginePluginEngineInfo, EnginePluginReloadResult,
    EnginePluginSettings, EnginePluginUpdatesView, InspectPackageView, PluginGrantsView,
    PluginScaffoldView, PluginUpdateSwitchView, PluginsView,
};
use crate::services::plugins::audit;
use crate::services::plugins::builtin;
use crate::services::plugins::consent;
use crate::services::plugins::consent_flow;
use crate::services::plugins::import_flow;
use crate::services::plugins::scaffold;
use crate::services::plugins::switch;
use crate::services::plugins::validate::{
    sanitize_id, sanitize_marketplace_key, sanitize_scope, sanitize_sha256, sanitize_source,
    validate_setting_key_length, validate_setting_value,
};
use crate::services::tasks::{TaskOutcome, TaskRun};
use crate::state::AppState;

use super::plugin_pages::publish_pages;
use super::workspace_cwd;

/// The workspace identity a consent answer is keyed by: the registry key of the workspace the caller
/// named (`services::store::projects::root_key`), or `None` when it named none this registry holds.
///
/// A project-scope installation exists once per workspace, so the record of the user's answer about
/// it is keyed by the workspace it lives in, and every read and write of that record resolves the
/// key the same way: from the id the caller sent, never from the list the host answered with, and
/// never from a substitute. A command that names no workspace addresses the host's own default
/// workspace, which is not a registered workspace - so there is no key to derive for it, and the
/// "first row" of the registry, the workspace directory or an empty string are not one.
///
/// The read and the write paths answer that case differently, on purpose. A read (`None`) sees the
/// rows every workspace shares and no project-scope row at all, which is fail-closed: an
/// installation whose workspace cannot be named is not confirmed. A write refuses a project-scope
/// answer with no identity to key it by (`services::plugins::consent::grant_key`).
pub(super) async fn workspace_key(
    state: &AppState,
    workspace_id: Option<i64>,
) -> IpcResult<Option<String>> {
    match workspace_id {
        Some(id) => state.store.project_root_key(id).await,
        None => Ok(None),
    }
}

/// Every plugin the named workspace can see, with the facts the page renders about each one.
///
/// The workspace is the caller's: a project install is visible only from the directory it belongs
/// to, and naming no workspace asks the host about its own default one.
#[tauri::command]
pub(crate) async fn engine_plugins(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
) -> Result<PluginsView, IpcError> {
    let cwd = workspace_cwd(&state, workspace_id).await?;
    let key = workspace_key(&state, workspace_id).await?;
    let plugins = state.runtime.plugins(cwd.as_deref()).await?;
    // The built-in plugins are seeded from the bundle this application ships with, and kept in
    // step with it, on the one path every page refresh goes through. It is idempotent - the second
    // call in a process does nothing - and it never touches an installation the user disabled
    // (`services::plugins::builtin`).
    let mut plugins = builtin::sync_bundle(
        &app,
        &state,
        cwd.as_deref(),
        key.as_deref(),
        plugins,
        builtin::SyncReason::List,
    )
    .await;
    publish_pages(&app, &state, &mut plugins, cwd.as_deref(), key.as_deref()).await;
    log_plugin_list(&plugins);
    Ok(plugins.into())
}

/// One line per read: a menu that is missing its rows is answered by whether the built-in
/// installation was in it, and by what its desktop block declared.
///
/// A log line, not a rule: nothing reads this back.
fn log_plugin_list(plugins: &crate::models::plugins::EnginePluginsView) {
    let builtin: Vec<String> = plugins
        .plugins
        .iter()
        .filter(|plugin| plugin.builtin)
        .map(|plugin| {
            format!(
                "{} enabled={} desktop={} tabs={} work={} error={:?}",
                plugin.name,
                plugin.enabled,
                plugin.desktop.is_some(),
                plugin
                    .desktop
                    .as_ref()
                    .map(|desktop| desktop.sidebar_tabs.len())
                    .unwrap_or(0),
                plugin
                    .desktop
                    .as_ref()
                    .map(|desktop| desktop.work_panel_tabs.len())
                    .unwrap_or(0),
                plugin.desktop_error
            ) + &format!(
                " valid={:?} perms={:?} urls={:?}",
                plugin.desktop.as_ref().map(|desktop| desktop.valid),
                plugin
                    .desktop
                    .as_ref()
                    .map(|desktop| desktop.permissions.clone())
                    .unwrap_or_default(),
                plugin
                    .desktop
                    .as_ref()
                    .map(|desktop| desktop
                        .sidebar_tabs
                        .iter()
                        .map(|tab| (tab.id.clone(), tab.url.is_some()))
                        .collect::<Vec<_>>())
                    .unwrap_or_default()
            )
        })
        .collect();
    crate::services::log::info(&format!(
        "plugins list: {} installation(s), builtin={builtin:?}",
        plugins.plugins.len()
    ));
}

/// Installs one plugin from the source the user pasted, and answers with the list as it stands after
/// the install.
///
/// What the source *means* - a marketplace entry, an npm spec, a local directory, a git URL - is
/// the engine's own classification, decided on the host's side. This layer bounds the text, so an
/// oversized or control-carrying argument never becomes a frame.
///
/// The consent chain an install has to run is `services::plugins::consent_flow::install_from_source`,
/// shared with the package import, because both end the same way: the engine enables what it installs
/// on its own terms, and the source says nothing about what that will be.
#[tauri::command]
pub(crate) async fn engine_plugin_install(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
    source: String,
    scope: Option<String>,
) -> Result<PluginsView, IpcError> {
    let cwd = workspace_cwd(&state, workspace_id).await?;
    let key = workspace_key(&state, workspace_id).await?;
    let source = sanitize_source(&source)?;
    // The reserved installation is the seed's own business: this route would let a caller replace it
    // - or re-enable a copy the user switched off - through an install the engine is free to enable
    // (`services::plugins::builtin`).
    if let Some(refusal) = builtin::install_refusal(&source) {
        return Err(refusal);
    }
    let scope = sanitize_scope(scope.as_deref())?;
    let mut installed =
        consent_flow::install_from_source(&state, cwd.as_deref(), key.as_deref(), &source, scope)
            .await?;
    publish_pages(&app, &state, &mut installed, cwd.as_deref(), key.as_deref()).await;
    Ok(installed.into())
}

/// Installs or upgrades one plugin from a package file the user picked, and answers with the list as
/// it stands afterwards.
///
/// The file is unpacked by this process and installed through the engine's marketplace channel: a
/// one-entry catalogue beside the unpacked package is added as a marketplace, and `name@catalogue`
/// is installed from it. Which of install, upgrade, "already current" or a refusal that import ends
/// in is the engine's own version rule, and the whole flow - the staging directory, the promotion,
/// the marketplace registration and the consent chain every path runs - belongs to
/// `services::plugins::import_flow` (spec §2.3, §3.4). This layer bounds the scope and names the
/// workspace the import addresses.
#[tauri::command]
pub(crate) async fn engine_plugin_install_package(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
    path: String,
    scope: Option<String>,
) -> Result<PluginsView, IpcError> {
    let cwd = workspace_cwd(&state, workspace_id).await?;
    let key = workspace_key(&state, workspace_id).await?;
    let scope = sanitize_scope(scope.as_deref())?;
    // An import is the one plugin operation long enough to watch (`rules.md#tauri-ipc-and-permissions`): it is reported as a
    // task with an id the page can cancel, and its steps are the service's own (see
    // `services::plugins::import_flow`).
    let Some(run) = TaskRun::start(&app, &state, "plugin.import") else {
        return Err(IpcError::new(
            PLUGIN_INSTALL_FAILED,
            "The import could not be started.",
        ));
    };
    let outcome =
        import_flow::install_package(&state, cwd.as_deref(), key.as_deref(), &path, scope, &run)
            .await;
    match outcome {
        Ok(mut installed) => {
            run.finish(&state, TaskOutcome::Finished);
            publish_pages(&app, &state, &mut installed, cwd.as_deref(), key.as_deref()).await;
            Ok(installed.into())
        }
        Err(error) => {
            let outcome = if error.code.as_ref() == TASK_CANCELLED {
                TaskOutcome::Cancelled
            } else {
                TaskOutcome::Failed(error.code.to_string())
            };
            run.finish(&state, outcome);
            Err(error)
        }
    }
}

/// Installs or upgrades one plugin from a URL the user pasted, and answers with the list as it
/// stands afterwards.
///
/// The address is fetched by this application (`services::plugins::download`): `https` only (or
/// `http` from this machine's loopback), redirects followed by hand and re-checked one by one, two
/// headers and no credentials, a 200 MiB ceiling, and a mandatory `sha256` - a URL source is the one
/// install route with no local `checksums.json` to fall back on, so the digest is not optional and
/// the argument is refused here if it is not one. What arrives is then walked through the same
/// import a picked file takes (`services::plugins::import_flow`), which is what makes an install
/// from a URL an ordinary imported plugin: upgradeable from the copy the import promoted, and
/// answerable by the engine's own version rule.
#[tauri::command]
pub(crate) async fn engine_plugin_install_url(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
    url: String,
    sha256: String,
    scope: Option<String>,
) -> Result<PluginsView, IpcError> {
    let cwd = workspace_cwd(&state, workspace_id).await?;
    let key = workspace_key(&state, workspace_id).await?;
    let url = sanitize_source(&url)?;
    let sha256 = sanitize_sha256(&sha256)?;
    let scope = sanitize_scope(scope.as_deref())?;
    // The download and the unpacking that follows it are the same long operation a package import
    // is, reported under the same label: the page words the steps, and a URL install walks the same
    // ones (`services::tasks`).
    let Some(run) = TaskRun::start(&app, &state, "plugin.import") else {
        return Err(IpcError::new(
            PLUGIN_INSTALL_FAILED,
            "The install could not be started.",
        ));
    };
    let outcome = import_flow::install_url(
        &state,
        cwd.as_deref(),
        key.as_deref(),
        &url,
        &sha256,
        scope,
        &run,
    )
    .await;
    match outcome {
        Ok(mut installed) => {
            run.finish(&state, TaskOutcome::Finished);
            publish_pages(&app, &state, &mut installed, cwd.as_deref(), key.as_deref()).await;
            Ok(installed.into())
        }
        Err(error) => {
            let outcome = if error.code.as_ref() == TASK_CANCELLED {
                TaskOutcome::Cancelled
            } else {
                TaskOutcome::Failed(error.code.to_string())
            };
            run.finish(&state, outcome);
            Err(error)
        }
    }
}

/// Asks one long operation to stop (`rules.md#tauri-ipc-and-permissions`: a task can be cancelled).
///
/// The answer says whether the run was still in flight; a run that already finished is not an error,
/// and the caller's own answer - a refusal with `task_cancelled` - is what reports the outcome.
#[tauri::command]
pub(crate) async fn plugin_task_cancel(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<bool, IpcError> {
    let task_id = task_id.trim();
    if task_id.is_empty() || task_id.len() > 64 {
        return Err(IpcError::new(
            INVALID_INPUT,
            "That is not a task this build started.",
        ));
    }
    Ok(state.tasks.cancel(task_id))
}

/// Removes one plugin and answers with the list as it stands after the removal.
///
/// A removal takes the consent record with it - the rows of that id this workspace can see - and the
/// catalogue an imported package was installed from when this was the last installation from it.
/// Both steps, and the order between them, are `services::plugins::consent_flow::uninstall`
/// (spec §9.2-④).
#[tauri::command]
pub(crate) async fn engine_plugin_uninstall(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
    id: String,
    scope: Option<String>,
) -> Result<PluginsView, IpcError> {
    let cwd = workspace_cwd(&state, workspace_id).await?;
    let key = workspace_key(&state, workspace_id).await?;
    // The handle the page sends (`installId` for a marketplace row, the package name otherwise); the
    // plugin's own id is read from the row, never parsed out of this string.
    let id = sanitize_id(&id)?;
    let scope = sanitize_scope(scope.as_deref())?;
    // What this application ships with cannot be removed: a built-in is the surface the build
    // promises (the terminal's tab) and the skills it carries, so the removal
    // is refused rather than turned into a suppression record. The judgement is the row's own facts -
    // the plugin id, the scope, and the marketplace the host reports it came from - and the
    // marketplace check is asked fresh here rather than taken from the seed's cache, because a plugin
    // installed from a marketplace that merely holds the reserved name is the user's to remove like
    // any other (`services::plugins::builtin::write_refusal`).
    let listed = state.runtime.plugins(cwd.as_deref()).await?;
    let addressed = consent::targets(&listed.plugins, &id, scope);
    if let Some(refusal) = builtin::write_refusal(&state, &app, &addressed).await {
        return Err(refusal);
    }
    let mut plugins =
        consent_flow::uninstall(&state, cwd.as_deref(), key.as_deref(), &listed, &id, scope)
            .await?;
    publish_pages(&app, &state, &mut plugins, cwd.as_deref(), key.as_deref()).await;
    log_plugin_list(&plugins);
    Ok(plugins.into())
}

/// Turns one plugin on or off, and answers with the list as it stands after the write.
///
/// Enabling is gated against the confirmation record of the workspace this write addresses, and
/// failed closed over every installation the write could address; disabling is never gated, because
/// refusing it would leave code running that the user asked to stop. The gate, the write and the
/// audit line are `services::plugins::consent_flow::set_enabled` (spec §9.2-②).
#[tauri::command]
pub(crate) async fn engine_plugin_set_enabled(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
    id: String,
    enabled: bool,
    scope: Option<String>,
) -> Result<PluginsView, IpcError> {
    let cwd = workspace_cwd(&state, workspace_id).await?;
    let key = workspace_key(&state, workspace_id).await?;
    // The handle the page sends (`installId` for a marketplace row, the package name otherwise).
    let id = sanitize_id(&id)?;
    let scope = sanitize_scope(scope.as_deref())?;
    // One read answers both questions this command has: what the write addresses (the built-in
    // protection, judged from the row's own facts) and the consent gate behind the write.
    let listed = state.runtime.plugins(cwd.as_deref()).await?;
    // A built-in cannot be switched off: it is the surface the build promises, and its skills follow
    // it. Turning one *on* is still allowed, because a data root written by an earlier build may hold
    // it disabled and this is the only way back without a reinstall.
    if !enabled {
        let addressed = consent::targets(&listed.plugins, &id, scope);
        if let Some(refusal) = builtin::write_refusal(&state, &app, &addressed).await {
            return Err(refusal);
        }
    }
    let mut plugins = consent_flow::set_enabled(
        &app,
        &state,
        cwd.as_deref(),
        key.as_deref(),
        listed,
        consent_flow::EnableWrite {
            target: &id,
            enabled,
            scope,
        },
    )
    .await?;
    publish_pages(&app, &state, &mut plugins, cwd.as_deref(), key.as_deref()).await;
    log_plugin_list(&plugins);
    Ok(plugins.into())
}

/// Upgrades one plugin, or every plugin that has an upgrade, and answers with the list as it stands
/// afterwards.
///
/// An id that is absent - or blank, which the page sends for "all" - asks for every upgrade, which
/// is the engine's own `upgradeAll` path; a named id upgrades that plugin at that scope.
///
/// An upgrade is a replacement the engine has already performed, so the same chain an import runs
/// finishes it: the widened rows are reconciled and everything left unconfirmed is quarantined, in
/// that order (`services::plugins::consent_flow::upgrade`, spec §6.5).
#[tauri::command]
pub(crate) async fn engine_plugin_upgrade(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
    id: Option<String>,
    scope: Option<String>,
) -> Result<PluginsView, IpcError> {
    let cwd = workspace_cwd(&state, workspace_id).await?;
    let id = match id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(id) => Some(sanitize_id(id)?),
        None => None,
    };
    let scope = sanitize_scope(scope.as_deref())?;
    // "Every plugin" has no one scope: the host's own upgrade-all branch never reads the field, so
    // accepting it here would silently upgrade installations the caller did not name.
    if id.is_none() && scope.is_some() {
        return Err(IpcError::new(
            INVALID_INPUT,
            "Upgrading every plugin cannot name a scope.",
        ));
    }
    let key = workspace_key(&state, workspace_id).await?;
    let mut plugins =
        consent_flow::upgrade(&state, cwd.as_deref(), key.as_deref(), id.as_deref(), scope).await?;
    publish_pages(&app, &state, &mut plugins, cwd.as_deref(), key.as_deref()).await;
    log_plugin_list(&plugins);
    Ok(plugins.into())
}

/// Moves one plugin from the marketplace it is installed from to another one, and answers with the
/// list as it stands afterwards.
///
/// The engine cannot do this itself: `upgradePlugin` reinstalls within one `name@marketplace`, and one
/// runtime link can hold one marketplace at a time, so the move is uninstall + install + re-enable
/// (plan §4.3). That is `services::plugins::switch`, including what happens when the install half
/// fails - one rollback attempt, and an honest answer either way. Everything this layer contributes is
/// the argument shapes: the plugin's own id (the row's `id`, not the engine's handle), the scope it has
/// to name, and the marketplace it moves to.
///
/// The scope is required rather than inferred: a plugin installed in both scopes has two
/// installations, and which one moves is the user's decision - the same posture the engine's own
/// `setPluginEnabled` takes. A plugin this application ships with cannot be moved at all (the switch
/// removes it first, which is exactly the write the built-in protection refuses).
#[tauri::command]
pub(crate) async fn engine_plugin_update_switch(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
    plugin_id: String,
    scope: String,
    target_marketplace: String,
) -> Result<PluginUpdateSwitchView, IpcError> {
    let cwd = workspace_cwd(&state, workspace_id).await?;
    let key = workspace_key(&state, workspace_id).await?;
    // `plugin_id` is the page's own key (a row's `id`), so an `@` in it is an npm scope or nothing -
    // never a segment to split. The marketplace is a catalogue name, bounded like every other one.
    let plugin_id = sanitize_id(&plugin_id)?;
    let scope = sanitize_scope(Some(&scope))?;
    let target_marketplace = sanitize_marketplace_key(&target_marketplace)?;
    // The installation the switch would remove, judged before it is touched: a verified built-in is
    // not the user's to move, for the same reason it is not theirs to uninstall.
    let listed = state.runtime.plugins(cwd.as_deref()).await?;
    let addressed = consent::targets(&listed.plugins, &plugin_id, scope);
    if let Some(refusal) = builtin::write_refusal(&state, &app, &addressed).await {
        return Err(refusal);
    }
    let (mut plugins, switched) = switch::switch_source(
        &state,
        cwd.as_deref(),
        key.as_deref(),
        &plugin_id,
        scope,
        &target_marketplace,
    )
    .await?;
    // The pages a switch serves are the ones the new installation carries: the list the switch
    // answered with is published exactly as any other read is, so a window opened for the previous
    // package is closed (its revision changed) and the new one's pages start loading.
    publish_pages(&app, &state, &mut plugins, cwd.as_deref(), key.as_deref()).await;
    Ok(PluginUpdateSwitchView {
        plugins: PluginsView::from(plugins).plugins,
        switched,
    })
}

/// What an upgrade would move, read without changing anything: the engine's own update check over
/// the marketplaces the installed plugins came from.
#[tauri::command]
pub(crate) async fn engine_plugin_check_updates(
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
) -> Result<EnginePluginUpdatesView, IpcError> {
    let cwd = workspace_cwd(&state, workspace_id).await?;
    state.runtime.plugin_check_updates(cwd.as_deref()).await
}

/// The engine this host runs, and which external tools it found on this machine: the facts behind
/// an install this application reports as unavailable rather than as a broken plugin.
///
/// Nothing is judged here - the host reports its own build and probes its own environment, and its
/// answer travels as written. A machine missing a tool reaches the caller as
/// `PLUGIN_INSTALL_UNAVAILABLE` (restated by `services::plugins::map_host_error`), which is what
/// lets the page name the tool instead of blaming the plugin.
#[tauri::command]
pub(crate) async fn engine_plugin_engine_info(
    state: State<'_, AppState>,
) -> Result<EnginePluginEngineInfo, IpcError> {
    state.runtime.plugin_engine_info().await
}

/// Copies one bundled plugin template into a directory the user picked, and answers where it wrote.
///
/// The four templates ship with the application; the destination is the user's own directory and is
/// never written into unless it is absent or empty, so a template cannot overwrite a file
/// (`services::plugins::scaffold`). Nothing is registered or installed: a created plugin is a
/// directory to edit, and installing it afterwards is the ordinary source install.
#[tauri::command]
pub(crate) async fn engine_plugin_scaffold(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    template: String,
    target_dir: String,
) -> Result<PluginScaffoldView, IpcError> {
    let path = scaffold::create(&app, &state.paths, &template, &target_dir).await?;
    Ok(PluginScaffoldView { path })
}

/// Reads one package file and answers what it holds, without installing anything.
///
/// The confirmation card an install from a file is drawn from: the permissions and hosts the
/// manifest declares (filtered by this build's own rules), how many pages and extension modules it
/// contributes, and whether its checksum list checks out. Nothing is registered, promoted or
/// installed, and the temporary tree the read unpacks is removed before the answer leaves
/// (`services::plugins::import_flow::inspect_package`).
#[tauri::command]
pub(crate) async fn engine_plugin_inspect_package(
    state: State<'_, AppState>,
    path: String,
) -> Result<InspectPackageView, IpcError> {
    let inspection = import_flow::inspect_package(&state, &path).await?;
    Ok(InspectPackageView {
        name: inspection.name,
        version: inspection.version,
        description: inspection.description,
        permissions: inspection.permissions,
        net_domains: inspection.net_domains,
        page_count: inspection.page_count,
        has_extensions: inspection.has_extensions,
        checksum_verified: inspection.checksum_verified,
        checksum_count: inspection.checksum_count,
        sha256: inspection.sha256,
    })
}

/// One plugin's settings: the schema its author declared, and the values the engine resolves.
#[tauri::command]
pub(crate) async fn engine_plugin_config(
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
    id: String,
) -> Result<EnginePluginSettings, IpcError> {
    let cwd = workspace_cwd(&state, workspace_id).await?;
    let id = sanitize_id(&id)?;
    state.runtime.plugin_config(cwd.as_deref(), &id).await
}

/// Stores one value for one key of a plugin's settings, and answers with the settings as they stand
/// after the write.
///
/// The schema is read from the host first, and the value is checked against the entry of *that key*
/// before anything is stored: a key the plugin does not declare, or a value that does not fit its
/// type, its bounds or its declared values, is refused here with `INVALID_INPUT`. The read is what
/// makes the schema the engine's own rather than a copy this layer keeps, and the second round trip
/// is the price of validating against the plugin that is actually installed.
///
/// The key itself is bounded before the runtime is asked (`services::plugins::validate`), which is
/// the same ceiling the host applies while reading the frame.
#[tauri::command]
pub(crate) async fn engine_plugin_config_set(
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
    id: String,
    key: String,
    value: Value,
) -> Result<EnginePluginSettings, IpcError> {
    let cwd = workspace_cwd(&state, workspace_id).await?;
    let id = sanitize_id(&id)?;
    validate_setting_key_length(&key)?;
    let settings = state.runtime.plugin_config(cwd.as_deref(), &id).await?;
    let schema = settings
        .schema
        .get(key.as_str())
        .ok_or_else(|| IpcError::new(INVALID_INPUT, "The plugin declares no such setting."))?;
    validate_setting_value(schema, &value)?;
    let written = state
        .runtime
        .plugin_config_set(cwd.as_deref(), &id, &key, value)
        .await?;
    // The line carries the plugin and nothing of the write: which key and which value were stored is
    // what the settings page shows, and a value can be a token.
    audit::config_set(&id, None);
    Ok(written)
}

/// Forgets one key of a plugin's settings, or every key the plugin has a value for when none is
/// named, and answers with the settings as they stand after the write.
///
/// Nothing is read against a schema here: a reset can only remove values, and which keys exist is
/// the engine's own answer - the host reads the current settings and deletes exactly the keys it
/// found. The one thing this layer checks about the key is its bound
/// (`services::plugins::validate`), the same ceiling the host applies while reading the frame.
#[tauri::command]
pub(crate) async fn engine_plugin_config_reset(
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
    id: String,
    key: Option<String>,
) -> Result<EnginePluginSettings, IpcError> {
    let cwd = workspace_cwd(&state, workspace_id).await?;
    let id = sanitize_id(&id)?;
    let key = key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(key) = key {
        validate_setting_key_length(key)?;
    }
    let settings = state
        .runtime
        .plugin_config_reset(cwd.as_deref(), &id, key)
        .await?;
    audit::config_reset(&id, None);
    Ok(settings)
}

/// Rebuilds the plugin-derived state of every live session, so a change made on another machine -
/// or by an installer - becomes visible without restarting the application.
///
/// The answer is the host's own report of what it touched, read into the shape this layer
/// publishes: the sessions it rebuilt and the sessions it could not, so a caller can tell "the
/// change is live" apart from "some session still runs the old plugin set".
#[tauri::command]
pub(crate) async fn engine_plugin_reload(
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
) -> Result<EnginePluginReloadResult, IpcError> {
    let cwd = workspace_cwd(&state, workspace_id).await?;
    state.runtime.plugin_reload(cwd.as_deref()).await
}

/// Every consent grant the named workspace can see: the plugin installations the user has confirmed
/// may run code, each with the scope it was confirmed at and when that answer was given.
///
/// The workspace is the caller's, and it decides which project-scope rows are in the answer: those
/// of that workspace, plus the user-scope rows, which speak about the one installation every
/// workspace shares. Naming a workspace this registry does not hold - or none at all - answers with
/// the shared rows only, rather than with another project's confirmations, because a project-scope
/// answer belongs to the workspace it was given in and to no other.
#[tauri::command]
pub(crate) async fn engine_plugin_grants(
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
) -> Result<PluginGrantsView, IpcError> {
    let key = workspace_key(&state, workspace_id).await?;
    let grants = state.store.plugin_grants(key.as_deref()).await?;
    Ok(PluginGrantsView { grants })
}

/// Records or withdraws the user's confirmation that one plugin installation may run code, and
/// answers with the grants the named workspace can see.
///
/// Granting only writes the row - the plugin is enabled by its own command, after the gate has been
/// answered with this record - while withdrawing switches off what the confirmation covered before
/// the record goes. Which rows are written or deleted, and the identity each of them is keyed by, is
/// `services::plugins::consent_flow::set_grant` (spec §9.2-③); this layer sanitizes the arguments,
/// names the workspace and converts the answer.
#[tauri::command]
pub(crate) async fn engine_plugin_grant_set(
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
    plugin_id: String,
    granted: bool,
    scope: Option<String>,
) -> Result<PluginGrantsView, IpcError> {
    let plugin_id = sanitize_id(&plugin_id)?;
    let scope = sanitize_scope(scope.as_deref())?;
    let cwd = workspace_cwd(&state, workspace_id).await?;
    let key = workspace_key(&state, workspace_id).await?;
    let grants = consent_flow::set_grant(
        &state,
        cwd.as_deref(),
        key.as_deref(),
        &plugin_id,
        granted,
        scope,
    )
    .await?;
    Ok(PluginGrantsView { grants })
}

/// The plugins this application ships with, and what became of each: whether its installation is
/// present, whether it is enabled, and whether the user removed it - which is what keeps the seed
/// from putting it back until the restore below clears the record.
///
/// One row per definition this build carries (`services::plugins::builtin::BUILTIN_DEFINITIONS`),
/// and the row is about the *definition* rather than about an installation a workspace can see,
/// which is the whole reason this command exists: an installation list cannot show a plugin the user
/// removed, and that is exactly the state the page has to offer to undo. The name, the description
/// and the version come from the bundled catalogue's own manifest - the same file the seed reads -
/// so a build without a readable bundle answers with the row unversioned rather than failing, and the
/// workspace is the caller's, because which installation is visible is the host's answer about that
/// workspace.
#[tauri::command]
pub(crate) async fn engine_builtin_plugins(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
) -> Result<BuiltinPluginsView, IpcError> {
    let cwd = workspace_cwd(&state, workspace_id).await?;
    let installed = state.runtime.plugins(cwd.as_deref()).await?;
    let suppressed = state.store.builtin_suppressed_ids().await?;
    let mut plugins = Vec::with_capacity(builtin::BUILTIN_DEFINITIONS.len());
    for def in builtin::BUILTIN_DEFINITIONS {
        let manifest = builtin::definition_manifest(&state, &app, def);
        let text = |field: &str| {
            manifest
                .as_ref()
                .and_then(|manifest| manifest.get(field))
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        let current = installed.plugins.iter().find(|plugin| {
            identity::plugin_id(plugin) == def.name && plugin.scope == builtin::BUILTIN_SCOPE
        });
        plugins.push(BuiltinPluginRow {
            // The plugin's own id, which is the identity the page and the grant record key by; the
            // suppression record is keyed by the engine handle, because that is what was installed.
            id: def.name.to_owned(),
            name: text("name").unwrap_or_else(|| def.name.to_owned()),
            description: text("description"),
            version: text("version"),
            installed: current.is_some(),
            enabled: current.is_some_and(|plugin| plugin.enabled),
            suppressed: suppressed.iter().any(|id| id == def.install_id),
        });
    }
    Ok(BuiltinPluginsView { plugins })
}

/// Seeds one built-in plugin again after the user removed it, and answers with the plugin list as it
/// stands after the restore.
///
/// The removal is a suppression record rather than a state of the installation, so the way back is
/// the record's removal followed by the seed's own sequence
/// (`services::plugins::builtin::restore`): the catalogue is registered and the plugin is installed
/// through the consent chain, exactly as a first start does. The definition is the one the caller
/// named, and the boundary is enforced rather than assumed - nothing but an installation this
/// application ships may be seeded through this route, so an id this build does not carry is answered
/// with `PLUGIN_BUILTIN_UNKNOWN`. The answer is a plugin list, because that is what the page renders
/// next.
#[tauri::command]
pub(crate) async fn engine_builtin_restore(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
    plugin_id: String,
) -> Result<PluginsView, IpcError> {
    let Some(def) = builtin::def_for_plugin_id(&plugin_id) else {
        return Err(IpcError::new(
            PLUGIN_BUILTIN_UNKNOWN,
            "This plugin is not one the application ships with.",
        ));
    };
    if let Some(refusal) = builtin::restore_refusal(def.install_id) {
        return Err(refusal);
    }
    let cwd = workspace_cwd(&state, workspace_id).await?;
    let key = workspace_key(&state, workspace_id).await?;
    // Seed first, forget the removal second. The record is what makes the removal outlive a
    // restart; clearing it before a seed that then fails would silently undo the user's decision.
    let mut plugins = builtin::restore(&app, &state, cwd.as_deref(), key.as_deref(), def).await?;
    state
        .store
        .set_builtin_suppressed(def.install_id, false)
        .await?;
    publish_pages(&app, &state, &mut plugins, cwd.as_deref(), key.as_deref()).await;
    log_plugin_list(&plugins);
    Ok(plugins.into())
}
