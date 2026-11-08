//! The consent chain as it is actually run: what each step reads, what it writes, and in which
//! order.
//!
//! `services::plugins::consent` holds the decisions - which rows an install has to switch off, the
//! answer an enable gate is given, the installations a withdrawal has to stop, the rows an upgrade
//! widened - as pure functions over the lists they are handed, and knows nothing about where those
//! lists come from. This module is the other half: it reads the host's plugin list and this
//! application's own grant record (`services::plugins::grants`, through the store) in the order the
//! chain requires, performs the writes each decision asks for, and reads every write back before
//! believing it. It is the owner of that sequence, and the sequence is the contract (spec §9.2,
//! chain ①-④):
//!
//! 1. **an install quarantines what it added** ([`install_from_source`]): the engine enables what it
//!    installs on its own terms and the source says nothing about what that will be, so the list is
//!    not answered before every row that would run code without a confirmation has been switched
//!    off;
//! 2. **an enable is answered by the record** ([`set_enabled`]): the gate is failed closed, because a
//!    write that names no scope lets the engine pick which installation it flips;
//! 3. **a withdrawal stops before it forgets** ([`set_grant`]): every installation of that id is
//!    disabled and verified first, and the record is deleted only once all of them are stopped;
//! 4. **an upgrade runs the same chain an import does** ([`upgrade`]): the rows whose new code
//!    widened what it may do are reconciled ([`reconfirm_widened`]) and everything left unconfirmed
//!    is quarantined, in that order - the second step reads the list the first answered with;
//! 5. **a removal forgets everything of that id the workspace can see** ([`uninstall`]), and takes
//!    the import catalogue with it when this was the last installation from it.
//!
//! Every step that changes a consent fact leaves one line in the audit trail
//! (`services::plugins::audit`). The identity every read and write is keyed by is
//! `(id, scope, workspace)`: `project_key` is the registry key of the workspace the caller addressed
//! (`commands::plugins::workspace_key`), a user-scope installation is the one every workspace shares
//! and so is keyed by the empty string, and a workspace that cannot be named answers for no
//! project-scope row at all rather than for a substitute - the write side refuses it
//! (`consent::grant_key`).
//!
//! The command layer calls these functions and converts their answers; no decision and no ordering
//! is left there (spec §9.2: `commands/plugins.rs` is a thin shell).

use crate::errors::{
    IpcError, IpcResult, PLUGIN_CONSENT_REQUIRED, PLUGIN_DISABLE_FAILED, PLUGIN_NOT_FOUND,
};
use crate::models::plugins::identity;
use crate::models::plugins::{EnginePluginRow, EnginePluginsView, PluginGrantRow};
use crate::services::log;
use crate::services::plugins::audit;
use crate::services::plugins::builtin;
use crate::services::plugins::consent::{self, GateAnswer};
use crate::services::plugins::imports;
use crate::state::AppState;

/// Installs one resolved source and leaves the consent chain answered.
///
/// An install is the one write that can end with code running that nobody confirmed: the engine
/// enables what it installs on its own terms, and the source says nothing about what that will be.
/// So the answer is not returned before every installation the list holds that would run code
/// without a confirmation has been switched off and verified - and if one cannot be switched off,
/// the call fails rather than reporting a list that says it is running. The list from before the
/// install is what makes the audit able to name what the call added; the host answers with a list,
/// and which plugin an install source resolves to is the engine's own classification.
pub(crate) async fn install_from_source(
    state: &AppState,
    cwd: Option<&str>,
    project_key: Option<&str>,
    source: &str,
    scope: Option<&'static str>,
) -> IpcResult<EnginePluginsView> {
    let before = state.runtime.plugins(cwd).await?;
    let installed = state.runtime.plugin_install(cwd, source, scope).await?;
    for added in consent::added_installs(&before.plugins, &installed.plugins) {
        audit::install(&added.id, Some(&added.scope));
    }
    quarantine_unconfirmed(state, cwd, project_key, installed).await
}

/// Switches off every installation the list holds that would run code without a confirmation, and
/// verifies each write before believing it.
///
/// Called with the list an install just answered with, and with the identity of the workspace the
/// install addressed. The decision is taken from that list and the grant rows the workspace can see
/// once (`services::plugins::consent::unconfirmed_enabled`): a confirmation of the project-scope copy
/// in another workspace is not a confirmation of this one, and a workspace that cannot be named has
/// no project-scope row at all, which is read as unconfirmed. Every target is then disabled at its
/// own scope: a plugin can be installed at both scopes, and the write has to name the one it means.
/// The row is read back from the answer - a disable that came back without an error and left the row
/// enabled has stopped nothing, and the caller is told the install cannot be reported as finished
/// rather than handed a list with code still running on it.
pub(crate) async fn quarantine_unconfirmed(
    state: &AppState,
    cwd: Option<&str>,
    project_key: Option<&str>,
    plugins: EnginePluginsView,
) -> IpcResult<EnginePluginsView> {
    let grants = state.store.plugin_grants(project_key).await?;
    let targets = consent::unconfirmed_enabled(&plugins.plugins, &grants);
    let mut current = plugins;
    for target in targets {
        // The engine write is addressed through that installation's own handle; the decision and the
        // audit line are about the plugin (`InstallRef`'s two identities, plan §4.1).
        let after = state
            .runtime
            .plugin_set_enabled(cwd, &target.target, false, Some(&target.scope))
            .await?;
        if consent::enabled_at(&after.plugins, &target.id, &target.scope) {
            audit::permission_denied(&target.id, Some(&target.scope));
            return Err(IpcError::new(
                PLUGIN_DISABLE_FAILED,
                "The installed plugin runs code and could not be disabled before it was confirmed.",
            ));
        }
        audit::disable(&target.id, Some(&target.scope));
        current = after;
    }
    Ok(current)
}

/// Upgrades one plugin, or every plugin that has an upgrade, and leaves the consent chain answered.
///
/// An upgrade is a replacement the engine has already performed, so the list is not answered before
/// the same chain an import runs has finished: a row whose new code widened what it may do is
/// switched off and its confirmation forgotten ([`reconfirm_widened`]), and every other installation
/// the new list holds that would run code without a confirmation - a row that was already enabled
/// and unconfirmed before this call - is quarantined by the step an install ends with
/// ([`quarantine_unconfirmed`], spec §6.2-①/§6.5). The two compose: the second reads the list the
/// first answered with. `id` names the installation to upgrade, and `None` is the engine's own
/// `upgradeAll` path.
pub(crate) async fn upgrade(
    state: &AppState,
    cwd: Option<&str>,
    project_key: Option<&str>,
    id: Option<&str>,
    scope: Option<&'static str>,
) -> IpcResult<EnginePluginsView> {
    // The list from before the upgrade: the comparison that decides whether the new code needs a
    // confirmation the old code did not (spec §6.5).
    let before = state.runtime.plugins(cwd).await?;
    // An upgrade rewrites the installation's directory, so its process has to be gone first: the
    // worker's `cwd` is that directory and Windows refuses to unlink it under a live child. The rows
    // this write addresses are the ones the list already holds.
    for row in consent::targets(&before.plugins, id.unwrap_or_default(), scope) {
        let row_id = identity::plugin_id(row).into_owned();
        state
            .plugin_process
            .stop_installation(&row_id, &row.scope)?;
    }
    let plugins = state.runtime.plugin_upgrade(cwd, id, scope).await?;
    let reconciled = reconfirm_widened(state, cwd, project_key, &before.plugins, plugins).await?;
    quarantine_unconfirmed(state, cwd, project_key, reconciled).await
}

/// Leaves the confirmation record answered for every installation an upgrade widened.
///
/// Spec §6.5: an upgrade that adds a permission must be confirmed again, and the confirmation is kept
/// per installation — it names no version and no reason list — so the comparison that finds the
/// widening is the one in `services::plugins::consent` (`widened_installs`), read off the list from
/// before the upgrade and the list the engine answered with.
///
/// What "confirmed again" means here is the fail-closed half of the rule, because an upgrade is a
/// replacement the engine has already performed: the installation is switched off and verified
/// (never left running code nobody agreed to), and its confirmation is forgotten so the page asks
/// again instead of offering a switch that turns the new code on under the old answer. An upgrade
/// that cannot be switched off fails the call rather than reporting a list that says it is running.
///
/// The confirmation is keyed by the scope's own identity (`consent::grant_key`): a user-scope row is
/// the one installation every workspace shares, while a project-scope row belongs to the workspace
/// that holds it — and a project-scope widening with no workspace to key by is refused rather than
/// forgotten under a value that stands for no project.
pub(crate) async fn reconfirm_widened(
    state: &AppState,
    cwd: Option<&str>,
    project_key: Option<&str>,
    before: &[EnginePluginRow],
    after: EnginePluginsView,
) -> IpcResult<EnginePluginsView> {
    let widened = consent::widened_installs(before, &after.plugins);
    if widened.is_empty() {
        return Ok(after);
    }
    let mut current = after;
    for target in widened {
        let disabled = state
            .runtime
            .plugin_set_enabled(cwd, &target.target, false, Some(&target.scope))
            .await?;
        if consent::enabled_at(&disabled.plugins, &target.id, &target.scope) {
            audit::permission_denied(&target.id, Some(&target.scope));
            return Err(IpcError::new(
                PLUGIN_CONSENT_REQUIRED,
                "The upgraded plugin brings code that was not confirmed, and it could not be disabled.",
            ));
        }
        let key = consent::grant_key(&target.scope, project_key)?;
        state
            .store
            .set_plugin_grant(&target.id, &target.scope, &key, false)
            .await?;
        audit::disable(&target.id, Some(&target.scope));
        audit::permission_denied(&target.id, Some(&target.scope));
        log::info(&format!(
            "plugin {}@{scope} was upgraded with new reasons ({reasons}) and needs confirming again",
            target.id,
            scope = target.scope,
            reasons = target.reasons.join(",")
        ));
        current = disabled;
    }
    Ok(current)
}

/// The write one enable or disable performs: the engine handle it addresses, the direction, and the
/// scope it names.
///
/// Grouped because they travel together - the handle is only meaningful with the scope beside it, and
/// both are the caller's answer rather than facts this layer reads. Keeping them one value is also
/// what lets [`set_enabled`] take the list it was judged against beside them.
pub(crate) struct EnableWrite<'a> {
    pub(crate) target: &'a str,
    pub(crate) enabled: bool,
    pub(crate) scope: Option<&'static str>,
}

/// Turns one plugin on or off and answers with the list as it stands after the write.
///
/// Enabling is gated: the plugin's own rows say whether they would run code (`consent.required`, the
/// host's factual reading of the plugin directory), and the grant table says whether the user has
/// confirmed each installation. Both are read from the workspace this write addresses, so the
/// consent facts belong to the plugin being enabled rather than to a same-named one elsewhere - and
/// the confirmation has to be the one recorded for that installation *in this workspace*, because a
/// project-scope installation exists once per workspace and the answer about the copy in another
/// project is not an answer about this one.
///
/// The gate is failed closed, because a write that names no scope lets the engine pick which
/// installation it flips: every installation of that id the list holds has to hold its own
/// confirmation before one of them is switched on, and only a row that needs no confirmation at all
/// is enabled without one (`services::plugins::consent::gate`). The grant is left alone by this
/// step - granting and enabling are two steps on the page, in that order.
///
/// Disabling is never gated: refusing it would leave code running that the user asked to stop.
///
/// The plugin this application ships with is brought in step with the bundled catalogue on the way
/// in, because this is where the user decides: switching it *on* first synchronizes it
/// (`services::plugins::builtin`), so a package an application update left beside it is applied at
/// the moment it is wanted.
///
/// `plugins` is the list the command already read (it judged the built-in protection by it), so this
/// step never asks the host the same question twice; `write` is the handle and direction the caller
/// named.
pub(crate) async fn set_enabled(
    app: &tauri::AppHandle,
    state: &AppState,
    cwd: Option<&str>,
    project_key: Option<&str>,
    plugins: EnginePluginsView,
    write: EnableWrite<'_>,
) -> IpcResult<EnginePluginsView> {
    let EnableWrite {
        target: id,
        enabled,
        scope,
    } = write;
    // The plugin this write is about, read from the list the command already judged the built-in
    // protection by - one read answers both questions. `id` is the engine handle the caller sent
    // (`installId`); the consent record and the audit line are keyed by the plugin instead, and a
    // write the list does not hold is left to the engine's own `plugin_not_found`.
    let plugin_id = consent::targets(&plugins.plugins, id, scope)
        .first()
        .map(|row| identity::plugin_id(row).into_owned());
    let mut plugins = plugins;
    if enabled {
        // The one plugin this application ships with is brought in step with the bundled catalogue
        // before it is switched on: an application update can leave a newer package beside an older
        // installation, and the user's own enable is the moment that package is applied
        // (`services::plugins::builtin`). Every other plugin is its own business.
        if plugin_id.as_deref().is_some_and(builtin::is_builtin_plugin) {
            plugins = builtin::sync_bundle(
                app,
                state,
                cwd,
                project_key,
                plugins,
                builtin::SyncReason::Enable,
            )
            .await;
        }
        let Some(plugin_id) = plugin_id.as_deref() else {
            return Err(IpcError::new(
                PLUGIN_NOT_FOUND,
                "The plugin is not installed.",
            ));
        };
        // A plugin can be installed at both scopes, and a write that names none lets the engine pick
        // which install it flips. So the gate asks about every installation of that plugin rather
        // than about the one that happened to match first.
        let targets = consent::installs(&plugins.plugins, plugin_id, scope);
        if targets.is_empty() {
            return Err(IpcError::new(
                PLUGIN_NOT_FOUND,
                "The plugin is not installed.",
            ));
        }
        let mut answers = Vec::with_capacity(targets.len());
        // The confirmations are read from the record as this workspace sees it: a user-scope
        // installation is the same one everywhere, while a project-scope row belongs to exactly one
        // workspace - so a confirmation of the copy elsewhere is not one of these answers, and a
        // workspace that cannot be named answers for none of them.
        for target in &targets {
            answers.push(GateAnswer {
                consent_required: target.consent_required,
                granted: state
                    .store
                    .plugin_granted(&target.id, &target.scope, project_key)
                    .await?,
            });
        }
        if let Err(refused) = consent::gate(&answers) {
            audit::permission_denied(plugin_id, consent::sole_scope(&targets));
            return Err(refused);
        }
    }
    let plugins = state
        .runtime
        .plugin_set_enabled(cwd, id, enabled, scope)
        .await?;
    // The rows of the list that came back name the scope this write is attributed to when the caller
    // named none; two of them say the engine's own choice is not knowable from here, and the audit
    // records that instead of picking one.
    let audited = match plugin_id.as_deref() {
        Some(plugin_id) => consent::installs(&plugins.plugins, plugin_id, scope),
        None => Vec::new(),
    };
    let audit_scope = consent::sole_scope(&audited);
    let audited_id = plugin_id.as_deref().unwrap_or(id);
    if enabled {
        audit::enable(audited_id, audit_scope);
    } else {
        audit::disable(audited_id, audit_scope);
    }
    Ok(plugins)
}

/// Records or withdraws the user's confirmation that one plugin installation may run code, and
/// answers with the grants the workspace can see.
///
/// Granting only writes the row: the plugin is enabled by its own step, after the gate has been
/// answered with this record, so nothing is turned on by confirming. The installation has to be one
/// the workspace can see - a confirmation recorded for something that is not installed would wait
/// for a later install of that id and admit it unseen. Naming no scope is answered with the only
/// scope the id is installed at, and refused when there are two.
///
/// The workspace is part of the row: a project-scope confirmation is stored under the addressed
/// workspace's own registry key, which is the same identity the enable gate looks it up by, while a
/// user-scope confirmation is stored under the empty key because that installation is the one every
/// workspace shares. A project-scope write with no workspace to key it by - the caller named none,
/// or one this registry does not hold - is refused (`INVALID_INPUT`) rather than recorded under a
/// value that stands for no project (`services::plugins::consent::grant_key`).
///
/// Withdrawing is the direction that has to be careful, and it switches off what the confirmation
/// covered before the record goes: every installation of that id at that scope is read from the
/// workspace's own list, disabled one by one and verified, and only when every one of them is
/// stopped is the grant forgotten. A disable that fails leaves the confirmation in place and fails
/// the call - a confirmation that is gone while the code it covered is still running is exactly the
/// state this gate exists to prevent. An id the list no longer holds is still forgotten, because a
/// grant for something that is no longer installed is the leftover that would otherwise admit a
/// later install; that is the one case where the enumeration is empty and the record still goes.
/// The rows it deletes are the ones the addressed workspace can see: the named scope's own row, or -
/// when no scope was named - every row of that id in this workspace, which is what the enumeration
/// covered. Another workspace's project-scope copy is a different installation and keeps its answer.
pub(crate) async fn set_grant(
    state: &AppState,
    cwd: Option<&str>,
    project_key: Option<&str>,
    plugin_id: &str,
    granted: bool,
    scope: Option<&'static str>,
) -> IpcResult<Vec<PluginGrantRow>> {
    let plugins = state.runtime.plugins(cwd).await?;
    if granted {
        let scope = consent::grant_scope(&plugins.plugins, plugin_id, scope)?;
        let project_key = consent::grant_key(&scope, project_key)?;
        state
            .store
            .set_plugin_grant(plugin_id, &scope, &project_key, true)
            .await?;
        audit::permission_granted(plugin_id, Some(&scope));
    } else {
        let targets = consent::installs(&plugins.plugins, plugin_id, scope);
        // Which rows this withdrawal deletes - and the identity each of them is keyed by - is settled
        // before anything is switched off: a withdrawal that stopped code and then could not delete
        // the record it covered is a half-done answer, and one that deleted the record while the code
        // kept running is the state this gate exists to prevent. The user scope needs no workspace to
        // be named; a project-scope row is keyed by this one, so a caller that named no workspace is
        // refused here rather than halfway through.
        let forgotten = match scope {
            Some(scope) => Some((scope, consent::grant_key(scope, project_key)?)),
            None => {
                for target in &targets {
                    consent::grant_key(&target.scope, project_key)?;
                }
                None
            }
        };
        for target in targets {
            let after = state
                .runtime
                .plugin_set_enabled(cwd, &target.target, false, Some(&target.scope))
                .await?;
            if consent::enabled_at(&after.plugins, &target.id, &target.scope) {
                return Err(IpcError::new(
                    PLUGIN_DISABLE_FAILED,
                    "The plugin could not be disabled, so its confirmation was kept.",
                ));
            }
            audit::disable(&target.id, Some(&target.scope));
        }
        match forgotten {
            Some((scope, key)) => {
                state
                    .store
                    .set_plugin_grant(plugin_id, scope, &key, false)
                    .await?;
            }
            None => {
                state
                    .store
                    .forget_plugin_grants(plugin_id, project_key)
                    .await?;
            }
        }
        audit::permission_denied(plugin_id, scope);
    }
    state.store.plugin_grants(project_key).await
}

/// Removes one plugin and answers with the list as it stands after the removal.
///
/// A removal takes the consent record with it: the rows of that id this workspace can see - the
/// shared user-scope ones and its own project-scope row - are forgotten once the engine has answered
/// that the plugin is gone. A grant left behind for something that is no longer installed is a
/// leftover that would silently admit a later install of the same id - the one thing this record
/// must never do - while another workspace's project-scope copy is an installation this removal did
/// not touch, so the answer it holds is not this call's to forget.
///
/// A removal also takes the catalogue an imported package was installed from, when this was the last
/// installation from it: the marketplace row and the `<dataRoot>/plugin-imports/<catalogue>`
/// directory exist only to make that installation upgradeable, and a row nothing is installed from
/// is the leftover the uninstall must not leave (`services::plugins::imports`). That step decides
/// conservatively and writes best-effort - the list is answered either way, because the removal the
/// caller asked for has already happened.
///
/// A *verified* built-in installation never reaches this function: the command refuses it first
/// (`builtin::protection_refusal`), because a built-in is the surface the build promises and not
/// something the user removes. Nothing is written to a suppression record here any more; the seed
/// clears records an earlier build left behind (`builtin::sync`).
pub(crate) async fn uninstall(
    state: &AppState,
    cwd: Option<&str>,
    project_key: Option<&str>,
    plugins: &EnginePluginsView,
    target: &str,
    scope: Option<&'static str>,
) -> IpcResult<EnginePluginsView> {
    // The rows this removal addresses, read from the list the command already judged the built-in
    // protection by: the answer to the write will no longer hold them, and both facts this step needs
    // - the identity the record is keyed by, and the import catalogue the installation came from -
    // are facts about the row that is about to be gone.
    let addressed = consent::targets(&plugins.plugins, target, scope);
    let plugin_id = addressed
        .first()
        .map(|row| identity::plugin_id(row).into_owned());
    let catalog = addressed
        .iter()
        .find_map(|row| imports::imported_catalog(&row.source))
        .map(str::to_owned);
    // The child first: a running worker's working directory is the installation's package, and the
    // engine's own removal answers `EBUSY` on Windows while it exists (2026-10-27 - a source switch
    // failed exactly that way and left the plugin uninstalled with its files behind). Stopping is a
    // no-op for an installation with no process, so a disabled plugin costs nothing here.
    for row in &addressed {
        let row_id = identity::plugin_id(row).into_owned();
        state
            .plugin_process
            .stop_installation(&row_id, &row.scope)?;
    }
    let plugins = state.runtime.plugin_uninstall(cwd, target, scope).await?;
    // The list just answered is the truth about what is still installed, so the question whether an
    // import catalogue is now empty is asked of it (`services::plugins::imports`).
    imports::remove_emptied_import(state, &plugins, catalog.as_deref()).await;
    // The record is keyed by the plugin, so that is what is forgotten - never the engine handle the
    // caller addressed it by. A write the list could not resolve falls back to what the caller named,
    // which at worst forgets nothing.
    let id = plugin_id.as_deref().unwrap_or(target);
    // A named scope is one installation; the same plugin in the other registry is still installed and
    // keeps its confirmation. Only an uninstall that named no scope speaks for both.
    match scope {
        Some(scope) => {
            state
                .store
                .forget_plugin_installation_grant(id, scope, project_key)
                .await?
        }
        None => state.store.forget_plugin_grants(id, project_key).await?,
    }
    audit::uninstall(id, scope);
    Ok(plugins)
}
