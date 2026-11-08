//! The switch sequence, read as a machine over scripted engine results: what the user is left with
//! after each way the two steps can go (plan §4.3).
//!
//! What is pinned here is the answer and the end state, never the shape of the code: the order of the
//! writes *is* the contract (the uninstall comes first because one runtime link can hold one
//! marketplace at a time), so the steps the machine asked for are asserted as a list.

use super::*;
use crate::models::plugins::{EnginePluginRow, EnginePluginSource};

fn start(enabled: bool) -> SwitchStart {
    SwitchStart {
        plugin_id: "demo-plugin".to_owned(),
        scope: "user".to_owned(),
        marketplace: "market-a".to_owned(),
        install_spec: "demo-plugin@market-a".to_owned(),
        version: Some("1.0.0".to_owned()),
        enabled,
    }
}

/// Runs the machine, answering each step it asks for with the next scripted result (a missing one
/// answers success), and reports the steps it asked for and how it ended.
fn drive(enabled: bool, answers: Vec<IpcResult<()>>) -> (Vec<SwitchStep>, SwitchEnd) {
    let mut machine = SwitchMachine::new(start(enabled), "market-b");
    let mut answers = answers.into_iter();
    let mut steps = Vec::new();
    loop {
        let Some(step) = machine.step() else {
            panic!("the machine stopped without an answer");
        };
        steps.push(step.clone());
        let answer = answers.next().unwrap_or(Ok(()));
        if let Some(end) = machine.advance(answer) {
            return (steps, end);
        }
    }
}

fn uninstall() -> SwitchStep {
    SwitchStep::Uninstall {
        install_spec: "demo-plugin@market-a".to_owned(),
    }
}

fn install(spec: &str) -> SwitchStep {
    SwitchStep::Install {
        install_spec: spec.to_owned(),
    }
}

fn enable(spec: &str) -> SwitchStep {
    SwitchStep::Enable {
        install_spec: spec.to_owned(),
    }
}

fn refused(message: &str) -> IpcError {
    IpcError::from_message(PLUGIN_UPDATE_SWITCH_FAILED, message.to_owned())
}

/// The happy path: the old handle goes, the new one is installed, and the enabled state comes back -
/// in that order, and only when the installation was enabled.
#[test]
fn a_switch_moves_the_installation_and_keeps_its_enabled_state() {
    let (steps, end) = drive(true, vec![Ok(()), Ok(()), Ok(())]);
    assert_eq!(
        steps,
        vec![
            uninstall(),
            install("demo-plugin@market-b"),
            enable("demo-plugin@market-b"),
        ]
    );
    match end {
        SwitchEnd::Switched(switched) => {
            assert_eq!(switched.from, "demo-plugin@market-a");
            assert_eq!(switched.to, "demo-plugin@market-b");
            assert_eq!(switched.marketplace, "market-b");
            assert!(!switched.rolled_back);
        }
        SwitchEnd::Failed(failure) => panic!("the switch failed: {}", failure.cause.message),
    }

    // A disabled installation is moved without being switched on: the user's switch stays as it was.
    let (steps, end) = drive(false, vec![Ok(()), Ok(())]);
    assert_eq!(steps, vec![uninstall(), install("demo-plugin@market-b")]);
    assert!(matches!(end, SwitchEnd::Switched(_)));
}

/// The install fails and the previous installation is put back: the switch did not happen, the answer
/// says so, and nothing was lost.
#[test]
fn a_failed_install_is_rolled_back_to_the_previous_marketplace() {
    let (steps, end) = drive(
        true,
        vec![Ok(()), Err(refused("market-b refused")), Ok(()), Ok(())],
    );
    assert_eq!(
        steps,
        vec![
            uninstall(),
            install("demo-plugin@market-b"),
            install("demo-plugin@market-a"),
            enable("demo-plugin@market-a"),
        ],
        "the rollback is one install, and the enabled state is restored after it"
    );
    match end {
        SwitchEnd::Failed(failure) => {
            assert_eq!(failure.cause.code, PLUGIN_UPDATE_SWITCH_FAILED);
            assert!(failure.rolled_back, "the previous installation is back");
            assert!(!failure.rollback_failed);
            assert!(
                failure.cause.message.contains("was restored"),
                "the answer says which state it is in: {}",
                failure.cause.message
            );
        }
        SwitchEnd::Switched(_) => panic!("a failed install is not a switch"),
    }
}

/// Both halves fail: the plugin is uninstalled, the answer says exactly that, and the failure is
/// flagged so the caller audits it. Nothing in the sequence writes to the store, which is what keeps
/// the confirmation record - the reason installing it again does not ask the user again.
#[test]
fn a_failed_rollback_leaves_the_plugin_uninstalled_and_keeps_the_record() {
    let (steps, end) = drive(
        true,
        vec![
            Ok(()),
            Err(refused("market-b refused")),
            Err(refused("market-a refused")),
        ],
    );
    assert_eq!(
        steps,
        vec![
            uninstall(),
            install("demo-plugin@market-b"),
            install("demo-plugin@market-a"),
        ],
        "one rollback attempt, and no enable of an installation that is not there"
    );
    match end {
        SwitchEnd::Failed(failure) => {
            assert_eq!(failure.cause.code, PLUGIN_UPDATE_SWITCH_FAILED);
            assert!(!failure.rolled_back, "nothing was restored");
            assert!(failure.rollback_failed, "the caller audits this outcome");
            assert!(
                failure.cause.message.contains("uninstalled"),
                "the answer says the plugin is gone: {}",
                failure.cause.message
            );
            assert!(
                failure
                    .cause
                    .message
                    .contains("confirmation for it was kept"),
                "and that the confirmation survives: {}",
                failure.cause.message
            );
        }
        SwitchEnd::Switched(_) => panic!("nothing was switched"),
    }
}

/// An uninstall that fails changes nothing, so there is nothing to roll back: the engine's own
/// failure is the answer, and no install is attempted.
#[test]
fn an_uninstall_that_fails_does_not_install_anything() {
    let (steps, end) = drive(
        true,
        vec![Err(IpcError::from_message(
            PLUGIN_NOT_FOUND,
            "The plugin is not installed.".to_owned(),
        ))],
    );
    assert_eq!(steps, vec![uninstall()]);
    match end {
        SwitchEnd::Failed(failure) => {
            assert_eq!(failure.cause.code, PLUGIN_NOT_FOUND);
            assert!(!failure.rolled_back && !failure.rollback_failed);
        }
        SwitchEnd::Switched(_) => panic!("nothing was removed"),
    }
}

/// The target installs and the re-enable fails: the switch happened and the plugin is left switched
/// off. The answer is a failure that says so rather than reporting either the old state or a clean
/// switch.
#[test]
fn a_re_enable_that_fails_reports_the_installed_but_switched_off_state() {
    let (steps, end) = drive(true, vec![Ok(()), Ok(()), Err(refused("cannot enable"))]);
    assert_eq!(
        steps,
        vec![
            uninstall(),
            install("demo-plugin@market-b"),
            enable("demo-plugin@market-b"),
        ]
    );
    match end {
        SwitchEnd::Failed(failure) => {
            assert_eq!(failure.cause.code, PLUGIN_UPDATE_SWITCH_FAILED);
            assert!(!failure.rolled_back && !failure.rollback_failed);
            assert!(
                failure.cause.message.contains("installed and switched off"),
                "the answer names the state the plugin is in: {}",
                failure.cause.message
            );
        }
        SwitchEnd::Switched(_) => panic!("the plugin is not in the state it had"),
    }
}

/// The installation a switch starts from is read from the row facts: the scope the caller named, the
/// marketplace it came from, and the handle to remove. An id that is not installed there, a row with
/// no marketplace, and a switch to the marketplace it already comes from are each refused before
/// anything is written.
#[test]
fn a_start_is_read_from_the_row_and_the_impossible_ones_are_refused() {
    let marketplace_row = |marketplace: &str, scope: &str| EnginePluginRow {
        id: "demo-plugin".to_owned(),
        install_id: Some(format!("demo-plugin@{marketplace}")),
        source: EnginePluginSource {
            kind: "marketplace".to_owned(),
            marketplace: Some(marketplace.to_owned()),
            install_id: Some(format!("demo-plugin@{marketplace}")),
            installed: true,
            ..EnginePluginSource::default()
        },
        scope: scope.to_owned(),
        enabled: true,
        version: Some("1.0.0".to_owned()),
        ..EnginePluginRow::default()
    };
    let view = EnginePluginsView {
        plugins: vec![
            marketplace_row("market-a", "user"),
            marketplace_row("market-a", "project"),
        ],
    };

    let start = start_of(&view, "demo-plugin", "project", "market-b").expect("the named scope");
    assert_eq!(start.scope, "project");
    assert_eq!(start.marketplace, "market-a");
    assert_eq!(start.install_spec, "demo-plugin@market-a");
    assert!(start.enabled);

    assert_eq!(
        start_of(&view, "demo-plugin", "workspace", "market-b")
            .expect_err("nobody is installed there")
            .code,
        PLUGIN_NOT_FOUND
    );
    assert!(
        start_of(&view, "demo-plugin", "user", "market-a").is_err(),
        "the marketplace it already comes from is not a switch"
    );

    // An npm installation has no marketplace to switch from.
    let npm = EnginePluginRow {
        id: "demo-plugin".to_owned(),
        scope: "user".to_owned(),
        source: EnginePluginSource {
            kind: "npm".to_owned(),
            ..EnginePluginSource::default()
        },
        ..EnginePluginRow::default()
    };
    let npm_view = EnginePluginsView { plugins: vec![npm] };
    assert_eq!(
        start_of(&npm_view, "demo-plugin", "user", "market-b")
            .expect_err("no source to switch from")
            .code,
        INVALID_INPUT
    );
}
