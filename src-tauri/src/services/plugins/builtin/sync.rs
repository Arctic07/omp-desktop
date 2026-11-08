//! Seeding and version synchronization for the plugins this application ships with.
//!
//! Split from `builtin` (`rules.md#single-file-line-limit`) so neither file grows past the size the rules allow: the
//! reserved identities, the definition table and the guards stay there, the seeding and the version
//! check live here. Nothing about the split is visible outside it - the parent module re-exports the
//! names the rest of the crate calls, and every rule, refusal and log line is the one that was there
//! before.
//!
//! Everything below is per *definition* ([`BUILTIN_DEFINITIONS`]): each one resolves its own version
//! out of the bundle, decides on its own facts, and is synchronized on its own. One definition's
//! failure is remembered for that definition and does not stop the next one, and the list a caller
//! gets back is the last one a definition actually changed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::{BuiltinDef, BUILTIN_DEFINITIONS, BUILTIN_MARKETPLACE_NAME, BUILTIN_SCOPE};
use crate::errors::{
    IpcError, IpcResult, PLUGIN_BUILTIN_UNAVAILABLE, PLUGIN_MARKETPLACE_RESERVED, PLUGIN_NOT_FOUND,
};
use crate::models::plugins::identity;
use crate::models::plugins::{EnginePluginRow, EnginePluginsView};
use crate::services::log;
use crate::services::paths::is_within;
use crate::services::plugins::consent_flow;
use crate::state::AppState;

mod bundle;

use bundle::{resolve_bundle, Bundle};

/// The built-in installations earlier builds shipped and this one does not.
///
/// A retired installation is still installed on every machine that ran an earlier build, and its
/// always-on rules keep teaching the agent a surface this build no longer has. The seed removes it
/// once per process ([`retire_unshipped`]) so the data root ends up describing what this build
/// actually is - and because it is an install identity, the removal is the engine's own uninstall,
/// which also takes the cache directory with it.
const RETIRED_BUILTIN_INSTALL_IDS: &[&str] = &["omp.browser@omp-desktop-builtin"];

/// Why the bundle is being synchronized.
///
/// The two callers want different things from the same facts, and the difference is the whole of the
/// user's control over these plugins: a list read leaves a disabled installation alone, while the
/// user's own switch asks for the newest package before it turns the plugin on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SyncReason {
    /// A plugin list read: seed if absent, keep an enabled installation in step, touch nothing else.
    List,
    /// The user is switching the built-in plugin on: a pending bundled update may be applied first.
    Enable,
}

/// The seeding state this process keeps: the resolved bundle, the version already synchronized per
/// definition, and the version whose synchronization last failed per definition.
///
/// Owner/bound/release: owned by `AppState`, one entry for the process's whole life, released with
/// it. The bundle cannot change while this process lives (it is a file the installer wrote), so
/// resolving it once and remembering the version the engine has been brought in step with is what
/// keeps a plugin list refresh - which the page does freely - from turning into a marketplace call
/// every time. Both memories are keyed by the definition's installation id, because a bundle carries
/// one version per definition: a definition whose version is already synchronized is not touched
/// again, while another one's change is still acted on. The failure memory is the other half of the
/// same rule: a version whose seeding failed is remembered too, so the next list read backs off
/// instead of re-running a sequence that is already known to fail - while the user's own switch still
/// gets its attempt. Both maps are bounded by the number of definitions this build carries.
pub(crate) struct BuiltinSync {
    state: Mutex<SyncState>,
    /// Serializes one synchronization end to end.
    ///
    /// The sequence is awaits throughout - a marketplace write, an install, an update check - and
    /// several callers arrive at once in practice: the page reads its plugin list on every mount, the
    /// shell reads it at start-up, and the user's own switch is another caller. Without this they
    /// would all see the same state (no installation, or nothing synced yet) and all act on it,
    /// registering the marketplace twice or installing twice. So the whole sequence holds this gate,
    /// and the state it acts on is read *after* it is held - the second caller sees what the first
    /// one did and does nothing. It is an async lock because the work it guards awaits.
    gate: tokio::sync::Mutex<()>,
}

/// What one synchronization should do, from the facts it is handed.
///
/// Pure, so the rule the whole seeding rests on can be read - and tested - without an engine: a
/// removal the user made is honoured before anything else, a list read never moves a disabled
/// installation, a version this process already synchronized is not touched again, a version whose
/// synchronization already failed in this process is not retried by a list read either, an absent
/// installation is installed and a present one is compared.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SyncAction {
    /// Nothing, and nothing is read either: the user removed this installation, and the record of
    /// that removal is what keeps the seed from putting it back. Only the restore command clears the
    /// record; until then every caller - the page's list read and the user's own switch alike -
    /// leaves the state exactly as the removal left it.
    Suppressed,
    /// Nothing: the installation is disabled, and a list read leaves the user's decision alone.
    StayDisabled,
    /// Nothing: this process has already synchronized this bundle version.
    AlreadySynced,
    /// Nothing: this bundle version's synchronization already failed in this process, and the caller
    /// is a list read. The user's own switch may try again; a page refresh may not.
    Backoff,
    /// Install the plugin from the bundled catalogue.
    Install,
    /// Ask the engine whether the bundle is newer, and apply it when it is.
    Update,
}

fn plan(
    suppressed: bool,
    missing: bool,
    disabled: bool,
    synced: bool,
    failed: bool,
    reason: SyncReason,
) -> SyncAction {
    // The user's removal is the strongest fact there is: it is not a state of the installation the
    // seed may move, it is the answer "do not seed this", and it is read first so no other rule can
    // override it. The user's own switch does not override it either - the way back is the restore
    // command, which clears the record before it seeds again, not a switch that would leave the
    // record saying the opposite of what the list shows.
    if suppressed {
        return SyncAction::Suppressed;
    }
    if disabled && reason == SyncReason::List {
        return SyncAction::StayDisabled;
    }
    // A synchronization that already failed for this bundle version is not tried again by a list
    // read: the page reads its list freely, and a doomed marketplace refresh plus install must not
    // run on every read. The user's own switch is a different caller with a different question, so
    // it falls through and gets its attempt.
    if failed && reason == SyncReason::List {
        return SyncAction::Backoff;
    }
    if synced {
        return SyncAction::AlreadySynced;
    }
    if missing {
        SyncAction::Install
    } else {
        SyncAction::Update
    }
}

#[derive(Default)]
struct SyncState {
    /// Resolved once; `resolved` says whether the read below has happened at all.
    bundle: Option<Bundle>,
    resolved: bool,
    /// Whether this process has already retired the installations earlier builds shipped and this
    /// one does not (`RETIRED_BUILTIN_INSTALL_IDS`). One attempt per process is the bound: a removal
    /// the caller cannot make (an engine that is not running yet) is not worth an uninstall call on
    /// every list read, and a later start tries again because the process is new.
    retired: bool,
    /// Installation id → the bundle version this process has already synchronized against the
    /// engine.
    synced: HashMap<String, String>,
    /// Installation id → the bundle version whose synchronization last failed in this process. The
    /// reason is not kept here - the warn is logged on the attempt itself - because all this memory
    /// decides is that a later *list read* does not run the same doomed sequence again; the user's own
    /// switch still may (`plan`). A successful synchronization of that definition clears its entry.
    failed: HashMap<String, String>,
    /// Whether the reserved marketplace has been read and found to point at the bundled catalogue.
    /// Nothing about the reserved identity is trusted until this is true.
    trusted: bool,
}

impl BuiltinSync {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(SyncState::default()),
            gate: tokio::sync::Mutex::new(()),
        }
    }

    /// Whether the reserved marketplace has been verified against the bundle this process shipped
    /// with. Read by the one place that marks a host list (`apply_trust`), so an unverified
    /// marketplace leaves every reserved-looking row untrusted - fail closed.
    pub(crate) fn trusted(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.trusted)
            .unwrap_or(false)
    }

    fn remember_trusted(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.trusted = true;
        }
    }

    /// Whether this process has already retired the installations this build no longer ships.
    fn retired(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.retired)
            .unwrap_or(false)
    }

    /// Records that the retirement pass has run, whatever it answered: one attempt per process.
    fn remember_retired(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.retired = true;
        }
    }

    /// The bundled catalogue, resolved once per process. `None` means this build has no usable
    /// bundle beside it, which is reported rather than papered over: no plugin this build ships is
    /// then installed, and the surfaces they contribute are simply absent.
    fn bundle(&self, app: &tauri::AppHandle) -> Option<Bundle> {
        if let Ok(state) = self.state.lock() {
            if state.resolved {
                return state.bundle.clone();
            }
        }
        let bundle = resolve_bundle(app);
        if let Ok(mut state) = self.state.lock() {
            state.resolved = true;
            state.bundle = bundle.clone();
        }
        bundle
    }

    /// The directory the bundled catalogue lives in, resolved once per process, when this build has
    /// one. Read by the marketplace page's own removal guard, which refuses only a row that really
    /// points here (`marketplace_removal_refusal`), and by the built-in page's manifest read
    /// (`definition_manifest`).
    pub(crate) fn bundle_root(&self, app: &tauri::AppHandle) -> Option<PathBuf> {
        self.bundle(app).map(|bundle| bundle.root)
    }

    /// The bundle version this process has already synchronized for one definition.
    fn synced(&self, install_id: &str) -> Option<String> {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.synced.get(install_id).cloned())
    }

    /// The bundle version whose synchronization last failed for one definition, when one did. The
    /// decision that reads it is `plan`'s: a list read for this version does not try again.
    fn failed(&self, install_id: &str) -> Option<String> {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.failed.get(install_id).cloned())
    }

    fn remember(&self, install_id: &str, version: String) {
        if let Ok(mut state) = self.state.lock() {
            state.synced.insert(install_id.to_owned(), version);
            // A successful synchronization is the end of any earlier failure for this definition:
            // the next list read is free to act again, and the warn is not repeated.
            state.failed.remove(install_id);
        }
    }

    /// Records that one definition's bundle version failed to synchronize. A list read that finds
    /// this version here backs off (`plan`); the user's own switch is still allowed its attempt.
    fn remember_failed(&self, install_id: &str, version: String) {
        if let Ok(mut state) = self.state.lock() {
            state.failed.insert(install_id.to_owned(), version);
        }
    }
}

/// Whether one retired installation is one the list actually holds, at the scope its removal names.
///
/// Pure, so the rule that decides whether the engine is asked at all can be read without an
/// application: asking about an installation the list does not have is what puts a misleading
/// "uninstall failed" line in the user's log on every start.
fn retired_is_listed(view: &EnginePluginsView, id: &str) -> bool {
    view.plugins
        .iter()
        .any(|row| row.install_id.as_deref() == Some(id) && row.scope == BUILTIN_SCOPE)
}

/// Removes the built-in installations this build no longer ships, once per process, and answers with
/// the list as it stands afterwards.
///
/// The caller holds the synchronization gate, and the removal is the engine's own uninstall at the
/// shared scope. Only an installation the handed list actually holds is asked about: an engine that
/// has no such installation answers with a refusal, and the *host* logs that refusal as a failed
/// command - a line in the user's log saying a plugin could not be uninstalled when nothing was
/// wrong. A machine that never ran the earlier build, which is most of them, therefore never asks.
///
/// The list is a snapshot, so the engine can still answer `plugin_not_found` for an entry it holds:
/// that arm is the race, and like an engine that is not running yet it is logged at info level and
/// the list is returned unchanged, because the seed is not the reason the caller asked and nothing
/// here may fail the list read.
async fn retire_unshipped(
    state: &AppState,
    cwd: Option<&str>,
    view: EnginePluginsView,
) -> EnginePluginsView {
    if state.builtin_sync.retired() {
        return view;
    }
    state.builtin_sync.remember_retired();
    let mut answer: Option<EnginePluginsView> = None;
    for id in RETIRED_BUILTIN_INSTALL_IDS.iter().copied() {
        if !retired_is_listed(&view, id) {
            continue;
        }
        match state
            .runtime
            .plugin_uninstall(cwd, id, Some(BUILTIN_SCOPE))
            .await
        {
            Ok(updated) => {
                log::info(&format!(
                    "a built-in plugin an earlier build shipped was removed: {id}"
                ));
                answer = Some(updated);
            }
            // Nothing to retire after all: the user removed it between the list and this call.
            Err(error) if error.code == PLUGIN_NOT_FOUND => {
                log::info(&format!(
                    "a retired built-in plugin is not installed, so nothing was removed: {id}"
                ));
            }
            Err(error) => log::warn(&format!(
                "a retired built-in plugin could not be removed: id={id} code={} message={}",
                error.code, error.message
            )),
        }
    }
    answer.unwrap_or(view)
}

/// Seeds, or keeps in step, every plugin this build ships, and answers with the list as it stands.
///
/// Called from the plugin list read (the one path every page refresh goes through) and from the
/// user's own switch, and idempotent in both: the second call in a process does nothing, because the
/// version it would compare against is the one it already synchronized - or the one whose
/// synchronization already failed, which a list read leaves alone rather than retrying. Nothing here
/// fails the caller - a bundle that is missing, an install that could not run, a marketplace name
/// already taken by somebody else's source - is reported in the log and answered with the list
/// unchanged, which is exactly the state "no plugin this build ships was seeded".
pub(crate) async fn sync_bundle(
    app: &tauri::AppHandle,
    state: &AppState,
    cwd: Option<&str>,
    project_key: Option<&str>,
    view: EnginePluginsView,
    reason: SyncReason,
) -> EnginePluginsView {
    // One synchronization at a time, and the facts read after the gate is held: a second caller -
    // the page's list read, the shell's, the user's own switch - sees what the first one did rather
    // than the same empty state, which is what keeps the marketplace and the install from being
    // written twice (`BuiltinSync::gate`).
    let _gate = state.builtin_sync.gate.lock().await;
    // Installations an earlier build shipped and this one does not are taken away before anything
    // else: their own always-on rules would otherwise keep instructing the agent to use a surface
    // this build no longer has. It is the engine's own uninstall at the shared scope, so it also
    // takes the cache directory with it, and the list it answers with replaces the caller's - an
    // installation that is gone must not be read as present by the passes below.
    let view = retire_unshipped(state, cwd, view).await;
    let Some(bundle) = state.builtin_sync.bundle(app) else {
        return view;
    };
    // Suppression records are no longer written: a built-in cannot be removed (`protection_refusal`).
    // Records an earlier build left behind are *cleared* here, because keeping them would leave that
    // data root with no built-in tab forever. A read that fails is treated as
    // "nothing is suppressed" and logged: seeding an installation is the honest answer about what
    // this build ships, and the only way back from a stale record.
    let suppressed = match state.store.builtin_suppressed_ids().await {
        Ok(ids) => ids,
        Err(error) => {
            log::warn(&format!(
                "the built-in plugins' suppression record could not be read, so none of them is treated as suppressed: code={} message={}",
                error.code, error.message
            ));
            Vec::new()
        }
    };
    for id in &suppressed {
        if BUILTIN_DEFINITIONS.iter().any(|def| def.install_id == *id) {
            if let Err(error) = state.store.set_builtin_suppressed(id, false).await {
                log::warn(&format!(
                    "a suppression record left by an earlier build could not be cleared: id={id} code={} message={}",
                    error.code, error.message
                ));
            } else {
                log::info(&format!(
                    "a suppression record left by an earlier build was cleared: {id}"
                ));
            }
        }
    }
    let suppressed: Vec<String> = suppressed
        .into_iter()
        .filter(|id| !BUILTIN_DEFINITIONS.iter().any(|def| def.install_id == *id))
        .collect();
    // Every definition is synchronized on its own facts, and one definition's failure does not reach
    // the next: each records its own failure and the loop goes on. The answer is the last list a
    // definition actually changed, or the list as it was read when none did.
    let pass = SyncPass {
        state,
        cwd,
        project_key,
        bundle: &bundle,
        view: &view,
        suppressed: &suppressed,
        reason,
    };
    let mut answer: Option<EnginePluginsView> = None;
    for def in BUILTIN_DEFINITIONS {
        if let Some(updated) = pass.run(def).await {
            answer = Some(updated);
        }
    }
    let mut answer = answer.unwrap_or(view);
    // The list this returns is what the page registry publishes and what the shell renders. A view
    // the caller read *before* this process's own upgrade - or one served from a cache - still names
    // the install path the upgrade removed, and publishing it leaves pages requesting files that are
    // no longer there: a blank tab (2026-10-25, user report; the plugin
    // cache showed 0.2.0 while the page registry still held the deleted 0.1.5 directory). A
    // definition this process synchronized but the answer does not show at that version means the
    // answer is stale, so it is asked for once more rather than trusted.
    if out_of_step(state, &answer) {
        match state.runtime.plugins(cwd).await {
            Ok(fresh) => {
                log::info(
                    "the plugin list was read again after a built-in synchronization: the caller's answer predated it",
                );
                answer = fresh;
            }
            Err(error) => log::warn(&format!(
                "the plugin list could not be read again after a built-in synchronization: code={} message={}",
                error.code, error.message
            )),
        }
    }
    answer
}

/// Whether a list contradicts what this process has already synchronized.
///
/// A definition this process brought to a version, but the list does not show at that version for
/// its scope, is the stale-answer case [`sync_bundle`] repairs. Definitions that were never
/// synchronized - suppressed, disabled, or failed - are not the question: their absence is the
/// user's or an error's, not a stale read's.
fn out_of_step(state: &AppState, view: &EnginePluginsView) -> bool {
    let remembered: Vec<(&str, String)> = BUILTIN_DEFINITIONS
        .iter()
        .filter_map(|def| {
            state
                .builtin_sync
                .synced(def.install_id)
                .map(|version| (def.install_id, version))
        })
        .collect();
    contradicts(&remembered, view)
}

/// Whether a list contradicts the versions this process synchronized, as a rule over values.
///
/// Pure so the answer can be pinned without an engine: `remembered` is one `(install id, version)`
/// per definition this process brought in step, and the list is stale when a remembered
/// installation is absent from it or still shown at another version.
fn contradicts(remembered: &[(&str, String)], view: &EnginePluginsView) -> bool {
    remembered.iter().any(|(id, version)| {
        view.plugins.iter().all(|row| {
            identity::install_spec(row) != *id
                || row.scope != BUILTIN_SCOPE
                || row.version.as_deref() != Some(version.as_str())
        })
    })
}

/// One synchronization's shared facts, so the per-definition pass takes the definition and nothing
/// else.
struct SyncPass<'a> {
    state: &'a AppState,
    cwd: Option<&'a str>,
    project_key: Option<&'a str>,
    bundle: &'a Bundle,
    /// The list as the caller read it, against which every definition's presence is decided.
    view: &'a EnginePluginsView,
    /// The installation ids the user has removed.
    suppressed: &'a [String],
    reason: SyncReason,
}

impl SyncPass<'_> {
    /// Synchronizes one definition, answering with the list when this definition changed it.
    ///
    /// `None` means nothing changed, for any of the reasons `plan` states - and each of them is
    /// answered without touching the installation, the marketplace or the engine.
    async fn run(&self, def: &BuiltinDef) -> Option<EnginePluginsView> {
        let state = self.state;
        let bundle = self.bundle;
        let version = bundle.version(def)?;
        let mut missing = true;
        let mut disabled = false;
        for row in &self.view.plugins {
            if identity::plugin_id(row) == def.name && row.scope == BUILTIN_SCOPE {
                missing = false;
                disabled = !row.enabled;
            }
        }
        let synced = state.builtin_sync.synced(def.install_id).as_deref() == Some(version.as_str());
        let failed = state.builtin_sync.failed(def.install_id).as_deref() == Some(version.as_str());
        let suppressed = self.suppressed.iter().any(|id| id == def.install_id);
        let action = plan(suppressed, missing, disabled, synced, failed, self.reason);
        // The reserved marketplace is checked against the bundle this process shipped with *before*
        // anything is trusted, and this is the only path that has to read it for its own sake: the
        // install and the update read the same registry through `ensure_marketplace`, which marks the
        // trust when the row points at the bundle. Without this read, a disabled installation on a
        // list read would never be identified - and, more importantly, a row that merely spells the
        // reserved id from somebody else's marketplace would be trusted for it, which is exactly the
        // escalation the mark exists to prevent.
        //
        // It is a registry read that writes nothing, so it stays on the paths where no install or
        // update runs - including the backoff after a failure: a failed *install* must not also cost
        // a present-and-enabled installation its trust mark, and therefore its built-in exemption.
        // A suppressed installation is not one of these paths either: the user removed
        // it, so there is nothing to identify and no read to make.
        if !state.builtin_sync.trusted()
            && !missing
            && matches!(
                action,
                SyncAction::StayDisabled | SyncAction::AlreadySynced | SyncAction::Backoff
            )
        {
            match reserved_source_verified(state, &bundle.root).await {
                Ok(true) => state.builtin_sync.remember_trusted(),
                Ok(false) => log::info(
                    "the built-in plugins' reserved marketplace is not this application's bundle, so the installations are not trusted as built-in",
                ),
                Err(error) => log::warn(&format!(
                    "the built-in plugins' reserved marketplace could not be checked: code={} message={}",
                    error.code, error.message
                )),
            }
        }
        // A disabled installation is the user's decision, and a list read does not touch it: no
        // marketplace is refreshed, no update is applied, it is not enabled, and its page is never
        // loaded. The one registry read above is the trust check, and it writes nothing. The user's
        // own switch is the one caller that may move it, and even then only by applying a package the
        // engine calls newer.
        // A suppressed installation is the user's removal, and nothing here undoes it: no marketplace
        // is registered, no install runs, no update is applied and no trust is read - the record is
        // cleared only by the restore command, which then seeds the installation itself.
        let outcome = match action {
            SyncAction::Suppressed
            | SyncAction::StayDisabled
            | SyncAction::AlreadySynced
            | SyncAction::Backoff => return None,
            SyncAction::Install => {
                install_first(state, self.cwd, self.project_key, def, bundle, &version).await
            }
            SyncAction::Update => {
                update_if_newer(state, self.cwd, self.project_key, def, bundle, &version).await
            }
        };
        match outcome {
            Ok(Some(updated)) => {
                state.builtin_sync.remember(def.install_id, version.clone());
                Some(updated)
            }
            // Nothing to change: the installed version is the bundle's own, as far as the engine's
            // own update check is concerned.
            Ok(None) => {
                state.builtin_sync.remember(def.install_id, version.clone());
                None
            }
            Err(error) => {
                // One warn per *attempt*, not per list read: this version is remembered as failed, so
                // a later list read backs off instead of running the doomed sequence - and logging it
                // - again. The user's own switch is still allowed its attempt (`plan`), and a success
                // clears the memory.
                state
                    .builtin_sync
                    .remember_failed(def.install_id, version.clone());
                log::warn(&format!(
                    "the built-in plugin {} could not be kept in step with the bundled version {}: code={} message={}",
                    def.name, version, error.code, error.message
                ));
                None
            }
        }
    }
}

/// Registers the bundled catalogue and installs one definition's plugin from it, once.
///
/// The install runs the consent chain every install runs (`consent_flow::install_from_source`),
/// because that chain is what makes an install answerable at all - and then the enabled state is
/// read back rather than assumed: a first seed wants a plugin the user can use, so a row the engine
/// left switched off is switched on explicitly.
async fn install_first(
    state: &AppState,
    cwd: Option<&str>,
    project_key: Option<&str>,
    def: &BuiltinDef,
    bundle: &Bundle,
    version: &str,
) -> IpcResult<Option<EnginePluginsView>> {
    ensure_marketplace(state, bundle).await?;
    let installed = consent_flow::install_from_source(
        state,
        cwd,
        project_key,
        def.install_id,
        Some(BUILTIN_SCOPE),
    )
    .await?;
    if enabled_at(&installed.plugins, def) {
        log::info(&format!(
            "the built-in plugin {} was installed at version {version}",
            def.name
        ));
        return Ok(Some(installed));
    }
    let enabled = state
        .runtime
        .plugin_set_enabled(cwd, def.install_id, true, Some(BUILTIN_SCOPE))
        .await?;
    log::info(&format!(
        "the built-in plugin {} was installed and enabled at version {version}",
        def.name
    ));
    Ok(Some(enabled))
}

/// Seeds one definition's plugin again after the user removed it.
///
/// The removal is a suppression record, not a state of the installation, so the way back is the same
/// install the first seed runs: the record is cleared by the caller before this is reached, and this
/// then registers the bundled catalogue and installs the plugin through the consent chain
/// (`install_first`), exactly as a first start does. The caller holds no other copy of that sequence,
/// which is why it is reused rather than written out again.
///
/// The bundle is resolved before anything else, and a build whose bundle cannot be read answers
/// `PLUGIN_BUILTIN_UNAVAILABLE`: unlike the seed - which is silent about a missing bundle, because
/// nothing asked for it - a restore is a user action, so it is told why nothing was restored rather
/// than answered with a list that quietly did not change. The gate is held for the same reason the
/// seed holds it: a restore arriving beside a list read must not register the marketplace or install
/// the plugin twice.
pub(crate) async fn restore(
    app: &tauri::AppHandle,
    state: &AppState,
    cwd: Option<&str>,
    project_key: Option<&str>,
    def: &BuiltinDef,
) -> IpcResult<EnginePluginsView> {
    let _gate = state.builtin_sync.gate.lock().await;
    let Some(bundle) = state.builtin_sync.bundle(app) else {
        return Err(IpcError::from_message(
            PLUGIN_BUILTIN_UNAVAILABLE,
            format!(
                "The built-in {} plugin could not be restored, because this build has no readable \
                 copy of it.",
                def.name
            ),
        ));
    };
    let Some(version) = bundle.version(def) else {
        return Err(IpcError::from_message(
            PLUGIN_BUILTIN_UNAVAILABLE,
            format!(
                "The built-in {} plugin could not be restored, because this build has no readable \
                 copy of it.",
                def.name
            ),
        ));
    };
    if let Some(view) = install_first(state, cwd, project_key, def, &bundle, &version).await? {
        log::info(&format!(
            "the built-in plugin {} was restored at version {version}",
            def.name
        ));
        return Ok(view);
    }
    // `install_first` answers with the list it installed; the read is the fallback for a build where
    // it could not (nothing was installed, so the list as it stands is the honest answer).
    state.runtime.plugins(cwd).await
}

/// Refreshes the bundled catalogue and applies an update, when the engine reports one.
///
/// The comparison is the engine's own update check (`plugin_check_updates`), never a comparison of
/// version strings here: the engine knows what is installed, what the catalogue holds and which
/// direction is an update. Nothing is applied when the check reports none, so a bundle older than
/// the installation (a user who installed a newer package by hand) is left alone rather than
/// silently downgraded.
async fn update_if_newer(
    state: &AppState,
    cwd: Option<&str>,
    project_key: Option<&str>,
    def: &BuiltinDef,
    bundle: &Bundle,
    version: &str,
) -> IpcResult<Option<EnginePluginsView>> {
    ensure_marketplace(state, bundle).await?;
    let updates = state.runtime.plugin_check_updates(cwd).await?;
    let newer = updates
        .updates
        .iter()
        .any(|update| update.plugin_id == def.name && update.scope == BUILTIN_SCOPE);
    if !newer {
        return Ok(None);
    }
    log::info(&format!(
        "the built-in plugin {} has a bundled update to {version} and is being upgraded",
        def.name
    ));
    let upgraded = consent_flow::upgrade(
        state,
        cwd,
        project_key,
        Some(def.install_id),
        Some(BUILTIN_SCOPE),
    )
    .await?;
    // The answer a replacement carries is not evidence about what it replaced. This list is what the
    // caller publishes as the pages this process serves (`commands::plugin_pages::publish_pages`),
    // and a row still naming the directory the upgrade just removed would make every request for an
    // installed page a `404` until something read the list again. So the list is read back and
    // the re-read is what the caller publishes; a failed re-read keeps the upgrade's answer rather
    // than failing a synchronization the engine has already performed.
    match state.runtime.plugins(cwd).await {
        Ok(fresh) => Ok(Some(fresh)),
        Err(error) => {
            log::warn(&format!(
                "the plugin list could not be read back after the built-in plugin {} was upgraded, so its pages are published from the upgrade's own answer: code={} message={}",
                def.name, error.code, error.message
            ));
            Ok(Some(upgraded))
        }
    }
}

/// Whether the list holds one definition's installation in the enabled state.
fn enabled_at(plugins: &[EnginePluginRow], def: &BuiltinDef) -> bool {
    plugins.iter().any(|row| {
        identity::plugin_id(row) == def.name && row.scope == BUILTIN_SCOPE && row.enabled
    })
}

/// Whether the reserved marketplace this process can see points at the bundle it shipped with.
///
/// The read is the registry alone - no refresh, no install, no plugin file - which is what makes it
/// safe on the path where nothing else may be touched (a disabled installation on a list read).
/// `Ok(false)` means the name is not registered yet, or is registered against somebody else's source:
/// either way nothing may be trusted until it is. The first case is fixed by the install that
/// follows, which registers the bundle's own directory; the second is a conflict this application
/// refuses to resolve, and the installation stays an ordinary third-party plugin.
pub(super) async fn reserved_source_verified(state: &AppState, root: &Path) -> IpcResult<bool> {
    let registry = state.runtime.marketplaces().await?;
    let Some(existing) = registry
        .marketplaces
        .iter()
        .find(|row| row.name == BUILTIN_MARKETPLACE_NAME)
    else {
        return Ok(false);
    };
    Ok(is_within(root, Path::new(existing.source_uri.trim())))
}

/// Makes sure the reserved marketplace is registered against the bundled catalogue, and refreshes
/// the engine's cached copy of it.
///
/// The name is this application's own, so a row holding it is either a previous run's registration
/// (the source is the bundle directory, or inside it) or somebody else's marketplace that happens to
/// spell the same name. The first is refreshed - a new application version ships a new catalogue at
/// the same path, and the engine's cached copy is what its update check reads - while the second is
/// refused outright: removing a marketplace this application did not add is not a repair, and the
/// installations stay unseeded instead of the name being stolen.
async fn ensure_marketplace(state: &AppState, bundle: &Bundle) -> IpcResult<()> {
    let registry = state.runtime.marketplaces().await?;
    let Some(existing) = registry
        .marketplaces
        .iter()
        .find(|row| row.name == BUILTIN_MARKETPLACE_NAME)
    else {
        state
            .runtime
            .marketplace_add(&bundle.root.to_string_lossy())
            .await?;
        state.builtin_sync.remember_trusted();
        return Ok(());
    };
    if !is_within(&bundle.root, Path::new(existing.source_uri.trim())) {
        return Err(IpcError::new(
            PLUGIN_MARKETPLACE_RESERVED,
            "A marketplace with the built-in plugins' reserved name already exists and points somewhere else.",
        ));
    }
    state
        .runtime
        .marketplace_update(Some(BUILTIN_MARKETPLACE_NAME))
        .await?;
    // Only now: the row this process just read points at the bundle, so the reserved identity is
    // this application's own (`apply_trust`).
    state.builtin_sync.remember_trusted();
    Ok(())
}

#[cfg(test)]
mod tests;
