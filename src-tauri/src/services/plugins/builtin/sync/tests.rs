//! The seeding decision and the process-level cache behind it, read without an engine.
//!
//! Split from the module's own tests (`rules.md#single-file-line-limit`): `plan`'s rule - the user's removal first, a
//! list read never moving a disabled installation, a version already synchronized not acted on
//! twice, a version whose synchronization failed backed off for a list read - and the cache that
//! feeds it. What is pinned here is what a caller can observe: a decision, and what one
//! synchronization records for the next caller.

use super::super::def_for_plugin_id;
use super::super::test_support::*;
use super::*;

/// A disabled installation is not enabled, whichever other rows the list holds.
#[test]
fn the_enabled_state_is_read_from_the_definitions_own_installation() {
    let def = def_for_plugin_id("omp.terminal").expect("this build ships a terminal definition");
    let mut disabled = row(def.name, "marketplace", Some(BUILTIN_MARKETPLACE_NAME));
    disabled.scope = BUILTIN_SCOPE.to_owned();
    assert!(!enabled_at(std::slice::from_ref(&disabled), def));
    disabled.enabled = true;
    assert!(enabled_at(std::slice::from_ref(&disabled), def));
    // A row of the same plugin elsewhere is not this installation's state.
    let mut other = row(def.name, "marketplace", Some(BUILTIN_MARKETPLACE_NAME));
    other.scope = "project".to_owned();
    other.enabled = true;
    assert!(!enabled_at(std::slice::from_ref(&other), def));
    // Another plugin is not this definition's state either, however it is scoped - even one
    // installed from the reserved marketplace.
    let mut alien = row(
        "other-plugin",
        "marketplace",
        Some(BUILTIN_MARKETPLACE_NAME),
    );
    alien.scope = BUILTIN_SCOPE.to_owned();
    alien.enabled = true;
    assert!(!enabled_at(std::slice::from_ref(&alien), def));
}

/// The decision the whole seeding rests on, read without an engine.
///
/// The two rules that matter to the user are here: a list read never moves a disabled
/// installation (no install, no marketplace refresh, no update, no enable), and a bundle version
/// this process already synchronized is not acted on a second time - which is what makes the
/// sequence idempotent when the page reads its list again, or reads it concurrently.
#[test]
fn the_seeding_decision_leaves_a_disabled_installation_alone_and_never_repeats_itself() {
    use SyncAction::*;
    // Absent: install, whatever the caller.
    assert_eq!(
        plan(false, true, false, false, false, SyncReason::List),
        Install
    );
    assert_eq!(
        plan(false, true, false, false, false, SyncReason::Enable),
        Install
    );
    // Present and enabled, nothing synced yet: compare with the bundle.
    assert_eq!(
        plan(false, false, false, false, false, SyncReason::List),
        Update
    );
    assert_eq!(
        plan(false, false, false, false, false, SyncReason::Enable),
        Update
    );
    // Present and disabled: a list read does nothing at all; the user's own switch may apply a
    // pending update first.
    assert_eq!(
        plan(false, false, true, false, false, SyncReason::List),
        StayDisabled
    );
    assert_eq!(
        plan(false, false, true, false, false, SyncReason::Enable),
        Update
    );
    // Already synchronized: nothing, whatever else is true - the second read in a process, and
    // the second of two callers that arrived together. The disabled rule outranks the cache
    // when a list read is the caller: leaving the user's decision alone is the stronger answer,
    // and it is the same "nothing happens" either way.
    for missing in [true, false] {
        for reason in [SyncReason::List, SyncReason::Enable] {
            assert_eq!(
                plan(false, missing, false, true, false, reason),
                AlreadySynced
            );
        }
    }
    assert_eq!(
        plan(false, false, true, true, false, SyncReason::List),
        StayDisabled
    );
    assert_eq!(
        plan(false, false, true, true, false, SyncReason::Enable),
        AlreadySynced
    );
}

/// The user's removal is the strongest fact of all: a suppressed installation is not seeded back
/// whatever the list shows and whoever asks. The way back is the restore command, which clears the
/// record before it seeds again - not a switch, which would leave the record saying the opposite of
/// what the list shows - so the user's own switch is answered with the same "nothing" as a list
/// read.
#[test]
fn the_users_removal_outranks_every_other_fact() {
    use SyncAction::*;
    for missing in [true, false] {
        for disabled in [true, false] {
            for synced in [true, false] {
                for failed in [true, false] {
                    for reason in [SyncReason::List, SyncReason::Enable] {
                        assert_eq!(
                            plan(true, missing, disabled, synced, failed, reason),
                            Suppressed,
                            "a suppressed installation is never seeded back"
                        );
                    }
                }
            }
        }
    }
}

/// A failed synchronization is remembered per bundle version, and a list read backs off instead
/// of running the doomed sequence - marketplace refresh and install - again on every read. The
/// user's own switch is the one caller that may try again, because a user action must have a
/// chance to succeed; a later success ends the memory (see
/// `the_sync_cache_remembers_a_failed_version_until_a_success_clears_it`).
#[test]
fn a_failed_synchronization_is_not_retried_by_a_list_read_but_is_by_the_users_switch() {
    use SyncAction::*;
    // The version that failed: the list backs off, the user's switch gets its attempt.
    assert_eq!(
        plan(false, false, false, false, true, SyncReason::List),
        Backoff
    );
    assert_eq!(
        plan(false, false, false, false, true, SyncReason::Enable),
        Update
    );
    assert_eq!(
        plan(false, true, false, false, true, SyncReason::List),
        Backoff
    );
    assert_eq!(
        plan(false, true, false, false, true, SyncReason::Enable),
        Install
    );
    // A list read still leaves a disabled installation alone after a failure - the user's
    // decision is the stronger answer - and the user's own switch still gets to move it.
    assert_eq!(
        plan(false, false, true, false, true, SyncReason::List),
        StayDisabled
    );
    assert_eq!(
        plan(false, false, true, false, true, SyncReason::Enable),
        Update
    );
    // A version that failed but was then synchronized successfully is not backed off: the
    // success cleared the memory, and the cached version answers.
    assert_eq!(
        plan(false, false, false, true, false, SyncReason::List),
        AlreadySynced
    );
}

/// The process-level cache: what one synchronization recorded is what the next caller sees, and
/// resolving the bundle once is what keeps a list refresh from reading the resource again. The
/// memory is keyed by installation id, because one bundle carries one version per definition.
#[test]
fn the_sync_cache_remembers_one_bundle_version_per_definition() {
    let def = def_for_plugin_id("omp.terminal").expect("this build ships a terminal definition");
    let other = "other-plugin@omp-desktop-builtin";
    let sync = BuiltinSync::new();
    assert_eq!(sync.synced(def.install_id), None);
    sync.remember(def.install_id, "1.2.3".to_owned());
    assert_eq!(sync.synced(def.install_id).as_deref(), Some("1.2.3"));
    // A second synchronization of the same version is the same state, not a new one.
    sync.remember(def.install_id, "1.2.3".to_owned());
    assert_eq!(sync.synced(def.install_id).as_deref(), Some("1.2.3"));
    // An application update ships a new version, which is a new synchronization.
    sync.remember(def.install_id, "1.2.4".to_owned());
    assert_eq!(sync.synced(def.install_id).as_deref(), Some("1.2.4"));
    // One definition's memory is not another's.
    assert_eq!(sync.synced(other), None);
    sync.remember(other, "0.0.1".to_owned());
    assert_eq!(sync.synced(other).as_deref(), Some("0.0.1"));
    assert_eq!(sync.synced(def.install_id).as_deref(), Some("1.2.4"));
}

/// The failure memory is per bundle version and per definition, and a successful synchronization of
/// that version clears it - which is what lets a later list read act again, and what keeps the warn
/// from being repeated on every read in between.
#[test]
fn the_sync_cache_remembers_a_failed_version_until_a_success_clears_it() {
    let def = def_for_plugin_id("omp.terminal").expect("this build ships a terminal definition");
    let sync = BuiltinSync::new();
    assert_eq!(sync.failed(def.install_id), None);
    sync.remember_failed(def.install_id, "1.2.3".to_owned());
    assert_eq!(sync.failed(def.install_id).as_deref(), Some("1.2.3"));
    assert_eq!(
        sync.synced(def.install_id),
        None,
        "a failure is not a synchronization"
    );
    // A different bundle version is a different question, answered by its own facts.
    sync.remember_failed(def.install_id, "1.2.4".to_owned());
    assert_eq!(sync.failed(def.install_id).as_deref(), Some("1.2.4"));
    // A successful synchronization of the failed version clears the memory and records itself.
    sync.remember(def.install_id, "1.2.4".to_owned());
    assert_eq!(sync.failed(def.install_id), None);
    assert_eq!(sync.synced(def.install_id).as_deref(), Some("1.2.4"));
    // One definition's failure does not back off another's synchronization.
    sync.remember_failed(def.install_id, "2.0.0".to_owned());
    assert_eq!(sync.failed("other-plugin@omp-desktop-builtin"), None);
}

/// A list that still names the version an upgrade replaced is stale, and publishing it is what left
/// a built-in page requesting a directory the upgrade had already removed (2026-10-25, user report:
/// a blank panel after the built-in plugin was upgraded in place). The rule is read here as a value:
/// a remembered installation must be in the list, at the remembered version.
#[test]
fn a_list_that_still_names_the_replaced_version_is_read_again() {
    let def = def_for_plugin_id("omp.terminal").expect("this build ships a terminal definition");
    let remembered = [(def.install_id, "0.2.0".to_owned())];

    // The stale answer: the installation is still at the version the upgrade replaced.
    let mut stale = row(def.name, "marketplace", Some(BUILTIN_MARKETPLACE_NAME));
    stale.version = Some("0.1.5".to_owned());
    let view = EnginePluginsView {
        plugins: vec![stale],
    };
    assert!(contradicts(&remembered, &view));

    // The list after the upgrade: nothing to read again.
    let mut current = row(def.name, "marketplace", Some(BUILTIN_MARKETPLACE_NAME));
    current.version = Some("0.2.0".to_owned());
    let view = EnginePluginsView {
        plugins: vec![current],
    };
    assert!(!contradicts(&remembered, &view));

    // A row for the same id from another scope is not this installation.
    let mut elsewhere = row(def.name, "marketplace", Some(BUILTIN_MARKETPLACE_NAME));
    elsewhere.scope = "project".to_owned();
    elsewhere.version = Some("0.2.0".to_owned());
    let view = EnginePluginsView {
        plugins: vec![elsewhere],
    };
    assert!(contradicts(&remembered, &view));

    // Nothing remembered is nothing to contradict.
    assert!(!contradicts(&[], &view));
}

/// The retired installations are named as engine handles, and none of them is a definition this
/// build still ships. Retiring a live installation would remove a surface the build promises (and
/// the seed would install it again on the next pass), so the two lists are checked against each
/// other rather than trusted.
#[test]
fn the_retired_installations_are_not_ones_this_build_still_ships() {
    // Every entry it carries must be an engine handle that is not also a definition this build ships.
    for id in RETIRED_BUILTIN_INSTALL_IDS {
        assert!(
            id.contains('@'),
            "{id} is an engine handle (`name@marketplace`), not a plugin id"
        );
        assert!(
            !BUILTIN_DEFINITIONS.iter().any(|def| def.install_id == *id),
            "{id} is still a definition this build ships"
        );
        assert!(
            !crate::services::plugins::builtin::is_builtin_install_spec(id),
            "a retired id must not be recognised as a current built-in installation"
        );
    }
}

/// A retired installation is asked about only when the list actually holds it.
///
/// Asking the engine to uninstall something it does not have is not a harmless no-op: the host
/// answers a refusal and logs it as a failed command, so a data root that never ran the earlier
/// build - which is most of them - put "plugins_uninstall failed" in the user's log on every start.
#[test]
fn a_retired_installation_is_asked_about_only_when_the_list_holds_it() {
    let retired = RETIRED_BUILTIN_INSTALL_IDS[0];
    let empty = EnginePluginsView { plugins: vec![] };
    assert!(
        !retired_is_listed(&empty, retired),
        "an empty list holds nothing"
    );

    // The fixture derives the handle the host would report, so this is the row a machine that ran
    // the earlier build actually has.
    let def = def_for_plugin_id("omp.browser");
    let held = EnginePluginsView {
        plugins: vec![row(
            def.as_ref().map_or("omp.browser", |def| def.name),
            "marketplace",
            Some(BUILTIN_MARKETPLACE_NAME),
        )],
    };
    assert!(retired_is_listed(&held, retired));

    // The same handle at another scope is another installation, and the removal names only the
    // shared one - so it is not this list's business.
    let mut elsewhere = held.plugins[0].clone();
    elsewhere.scope = "project".to_owned();
    assert!(!retired_is_listed(
        &EnginePluginsView {
            plugins: vec![elsewhere],
        },
        retired
    ));

    // A different handle is a different installation, and a row with no handle at all is an npm or
    // linked install, which was never a built-in.
    let other = EnginePluginsView {
        plugins: vec![row(
            "omp.terminal",
            "marketplace",
            Some(BUILTIN_MARKETPLACE_NAME),
        )],
    };
    assert!(!retired_is_listed(&other, retired));
    let mut unhandled = held.plugins[0].clone();
    unhandled.install_id = None;
    assert!(!retired_is_listed(
        &EnginePluginsView {
            plugins: vec![unhandled],
        },
        retired
    ));
}
