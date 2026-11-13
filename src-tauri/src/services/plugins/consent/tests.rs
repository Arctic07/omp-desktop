//! The consent decisions read against the rows they are answered from (split from the module by
//! `rules.md#single-file-line-limit`: the decisions stay there, the fixtures and assertions live here).
//!
//! Every case below is a caller-visible answer - which installations a write addresses, whether the
//! enable gate lets it through, which rows a withdrawal stops first - never the shape of the code.

use super::*;
use crate::errors::PLUGIN_CONSENT_REQUIRED;
use crate::models::plugins::{
    EnginePluginCode, EnginePluginConsent, EnginePluginSettingsSummary, EnginePluginSource,
};

/// One row as the host reports it, with only the fields a consent decision reads filled in.
fn row(id: &str, scope: &str, enabled: bool, consent_required: bool) -> EnginePluginRow {
    EnginePluginRow {
        id: id.to_owned(),
        name: String::new(),
        description: None,
        version: None,
        scope: scope.to_owned(),
        enabled,
        builtin: false,
        toggleable: false,
        shadowed_by: None,
        install_id: None,
        source: EnginePluginSource::default(),
        sources: Vec::new(),
        installed_at: None,
        last_updated: None,
        root_path: None,
        consent: EnginePluginConsent {
            required: consent_required,
            reasons: Vec::new(),
        },
        code: EnginePluginCode::default(),
        settings: EnginePluginSettingsSummary::default(),
        features: Vec::new(),
        desktop: None,
        desktop_error: None,
    }
}

/// One marketplace installation: the plugin's own id, and the engine's handle for the marketplace
/// it happens to be installed from. Plan §4.1's whole point is that these two differ.
fn market_row(
    plugin_id: &str,
    marketplace: &str,
    scope: &str,
    enabled: bool,
    consent_required: bool,
) -> EnginePluginRow {
    let mut row = row(plugin_id, scope, enabled, consent_required);
    let install_id = format!("{plugin_id}@{marketplace}");
    row.install_id = Some(install_id.clone());
    row.source = EnginePluginSource {
        kind: "marketplace".to_owned(),
        label: install_id.clone(),
        marketplace: Some(marketplace.to_owned()),
        install_id: Some(install_id),
        installed: true,
        ..EnginePluginSource::default()
    };
    row
}

/// A decision about a plugin is a decision about the *plugin*: the enumeration matches the
/// plugin's own id and carries the engine handle each installation is written through, so a
/// switch of source cannot make the gate judge one installation and disable another.
#[test]
fn an_enumeration_matches_the_plugin_id_and_carries_each_handle() {
    let rows = vec![
        market_row("demo-plugin", "market-a", "user", true, true),
        market_row("demo-plugin", "market-b", "project", true, true),
        market_row("other-plugin", "market-a", "user", true, true),
    ];

    let both = installs(&rows, "demo-plugin", None);
    assert_eq!(both.len(), 2);
    assert_eq!(both[0].id, "demo-plugin", "the identity, not the handle");
    assert_eq!(both[0].target, "demo-plugin@market-a");
    assert_eq!(both[1].target, "demo-plugin@market-b");
    assert_eq!(both[1].scope, "project");

    let one = installs(&rows, "demo-plugin", Some("project"));
    assert_eq!(one.len(), 1);
    assert_eq!(one[0].target, "demo-plugin@market-b");

    // The engine's handle is not an identity: asking for it by its own spelling finds nothing.
    assert!(installs(&rows, "demo-plugin@market-a", None).is_empty());
}

/// A write names the handle the page sends (`installId`), and a caller reading the record may
/// name the plugin instead: both are matched against the row's own two facts, and a scope
/// narrows either.
#[test]
fn a_write_is_addressed_by_its_handle_or_by_its_plugin_id() {
    let rows = vec![
        market_row("demo-plugin", "market-a", "user", true, true),
        market_row("other-plugin", "market-a", "user", true, true),
    ];

    let by_handle = targets(&rows, "demo-plugin@market-a", None);
    assert_eq!(by_handle.len(), 1);
    assert_eq!(identity::plugin_id(by_handle[0]), "demo-plugin");

    let by_id = targets(&rows, "demo-plugin", Some("user"));
    assert_eq!(by_id.len(), 1);
    assert_eq!(identity::install_spec(by_id[0]), "demo-plugin@market-a");

    assert!(targets(&rows, "demo-plugin", Some("project")).is_empty());
    assert!(
        targets(&rows, "demo", None).is_empty(),
        "half a handle is no identity"
    );
    assert!(targets(&rows, "other-plugin@market-b", None).is_empty());
}

/// A row from a host that predates `installId` still answers both questions: its handle is
/// collapsed for the identity and kept for the write.
#[test]
fn a_legacy_handle_is_still_addressed_by_its_own_spelling() {
    let mut legacy = row("demo-plugin@market-a", "user", true, true);
    legacy.source = EnginePluginSource {
        kind: "marketplace".to_owned(),
        label: "demo-plugin@market-a".to_owned(),
        ..EnginePluginSource::default()
    };
    let rows = { vec![legacy] };
    assert_eq!(
        installs(&rows, "demo-plugin", None)[0].target,
        "demo-plugin@market-a"
    );
    assert_eq!(targets(&rows, "demo-plugin@market-a", None).len(), 1);
    assert_eq!(targets(&rows, "demo-plugin", None).len(), 1);
}

/// The comparison an upgrade's confirmation rests on: only reasons the new code *adds* count.
#[test]
fn an_upgrade_is_widened_only_by_reasons_it_adds() {
    let before = vec!["extension-modules".to_owned()];
    let same = vec!["extension-modules".to_owned()];
    let narrower = Vec::new();
    let wider = vec!["extension-modules".to_owned(), "mcp-config".to_owned()];

    assert!(widened_reasons(&before, &same).is_empty());
    assert!(widened_reasons(&before, &narrower).is_empty());
    assert_eq!(
        widened_reasons(&before, &wider),
        vec!["mcp-config".to_owned()]
    );
    assert_eq!(
        widened_reasons(&[], &wider),
        vec!["extension-modules".to_owned(), "mcp-config".to_owned()]
    );
}

/// The installations one upgrade widened, matched by id *and* scope: the project-scope copy in one
/// workspace is a different installation, and a plugin that brings nothing new is not a decision.
#[test]
fn widened_installs_match_by_installation_and_skip_the_unchanged() {
    fn row(id: &str, scope: &str, reasons: &[&str]) -> EnginePluginRow {
        EnginePluginRow {
            id: id.to_owned(),
            name: String::new(),
            description: None,
            version: None,
            scope: scope.to_owned(),
            enabled: true,
            builtin: false,
            toggleable: false,
            shadowed_by: None,
            install_id: None,
            source: EnginePluginSource::default(),
            sources: Vec::new(),
            installed_at: None,
            last_updated: None,
            root_path: None,
            consent: EnginePluginConsent {
                required: !reasons.is_empty(),
                reasons: reasons.iter().map(|reason| (*reason).to_owned()).collect(),
            },
            code: EnginePluginCode::default(),
            settings: EnginePluginSettingsSummary::default(),
            features: Vec::new(),
            desktop: None,
            desktop_error: None,
        }
    }

    let before = vec![
        row("a@m", "user", &["extension-modules"]),
        row("b@m", "user", &["hooks-dir"]),
        row("c@m", "project", &["hooks-dir"]),
    ];
    let after = vec![
        // Same reasons: nothing to confirm again.
        row("a@m", "user", &["extension-modules"]),
        // A new reason: this installation's confirmation no longer covers what it runs.
        row("b@m", "user", &["hooks-dir", "mcp-config"]),
        // The other scope of the same id is untouched.
        row("c@m", "project", &["hooks-dir"]),
        // Not an upgrade at all: the install path owns what it added.
        row("d@m", "user", &["extension-modules"]),
    ];

    let widened = widened_installs(&before, &after);
    assert_eq!(widened.len(), 1);
    assert_eq!(widened[0].id, "b@m");
    assert_eq!(widened[0].scope, "user");
    assert_eq!(widened[0].reasons, vec!["mcp-config".to_owned()]);
}

/// A widening renews an answer; it never creates one. The installation the user withdrew stays out
/// of the renewal set, so an upgrade cannot silently undo a withdrawal.
#[test]
fn a_widening_renews_only_the_confirmations_already_on_record() {
    let widened = vec![
        WidenedInstall {
            id: "kept@m".to_owned(),
            scope: "user".to_owned(),
            reasons: vec!["mcp-config".to_owned()],
        },
        WidenedInstall {
            id: "withdrawn@m".to_owned(),
            scope: "user".to_owned(),
            reasons: vec!["hooks-dir".to_owned()],
        },
    ];
    let grants = vec![PluginGrantRow {
        plugin_id: "kept@m".to_owned(),
        scope: "user".to_owned(),
        granted_at: "2026-01-01T00:00:00.000Z".to_owned(),
    }];

    let renewed = renewals(&widened, &grants);
    assert_eq!(renewed.len(), 1);
    assert_eq!(renewed[0].id, "kept@m");
}

/// The scope an import addresses: named, unique, ambiguous, unknown, or not installed there.
#[test]
fn an_import_addresses_the_installation_the_caller_named() {
    fn install(id: &str, scope: &str) -> InstallRef {
        InstallRef {
            id: id.to_owned(),
            target: format!("{id}@market"),
            scope: scope.to_owned(),
            consent_required: true,
        }
    }

    let both = vec![install("a@m", "user"), install("a@m", "project")];
    assert_eq!(import_target_scope(&both, Some("user")).unwrap(), "user");
    assert_eq!(
        import_target_scope(&both, Some("project")).unwrap(),
        "project"
    );
    assert!(
        import_target_scope(&both, None).is_err(),
        "two installations, none named"
    );

    let one = vec![install("a@m", "project")];
    assert_eq!(import_target_scope(&one, None).unwrap(), "project");
    assert!(
        import_target_scope(&one, Some("user")).is_err(),
        "not installed there"
    );

    // A scope this build cannot name is not one it can address, whatever the row says.
    let odd = vec![install("a@m", "workspace")];
    assert!(import_target_scope(&odd, None).is_err());
}

/// One recorded answer for one installation.
fn granted(plugin_id: &str, scope: &str) -> PluginGrantRow {
    PluginGrantRow {
        plugin_id: plugin_id.to_owned(),
        scope: scope.to_owned(),
        granted_at: "1".to_owned(),
    }
}

/// A write that names no scope addresses both installations of that id - and only that id - so a
/// decision read from the list covers exactly the rows the engine could flip.
#[test]
fn installs_narrows_by_id_and_scope() {
    let rows = vec![
        row("hello@official", "user", true, true),
        row("hello@official", "project", false, true),
        row("other", "user", true, true),
    ];

    let both = installs(&rows, "hello@official", None);
    assert_eq!(both.len(), 2, "an unnamed scope keeps every installation");
    assert_eq!(both[0].scope, "user");
    assert_eq!(both[1].scope, "project");
    assert!(both[0].consent_required, "the host's reading travels");

    let one = installs(&rows, "hello@official", Some("project"));
    assert_eq!(one.len(), 1);
    assert_eq!(one[0].scope, "project");

    assert!(installs(&rows, "hello@official", Some("user")).len() == 1);
    assert!(
        installs(&rows, "hello@official", Some("workspace")).is_empty(),
        "a scope the engine does not have is not an installation"
    );
    assert!(installs(&rows, "missing", None).is_empty());
}

/// The quarantine filter is the three-way conjunction, and the grant is read per installation: a
/// confirmed project-scope install does not excuse the user-scope one, and a confirmed
/// installation is never switched off.
#[test]
fn only_enabled_unconfirmed_code_installations_are_quarantined() {
    let rows = vec![
        row("code@official", "user", true, true),
        row("code@official", "project", true, true),
        row("plain@official", "user", true, false),
        row("off@official", "user", false, true),
    ];
    let grants = vec![granted("code@official", "project")];

    let targets = unconfirmed_enabled(&rows, &grants);
    assert_eq!(
        targets,
        vec![InstallRef {
            id: "code@official".to_owned(),
            target: "code@official".to_owned(),
            scope: "user".to_owned(),
            consent_required: true,
        }],
        "only the enabled code installation that holds no confirmation of its own"
    );

    assert!(
        unconfirmed_enabled(&rows, &[granted("code@official", "user")]).len() == 1,
        "the other scope is still without one"
    );
    assert!(unconfirmed_enabled(
        &rows,
        &[
            granted("code@official", "user"),
            granted("code@official", "project")
        ]
    )
    .is_empty());
    assert!(
        unconfirmed_enabled(&[row("plain@official", "user", true, false)], &[]).is_empty(),
        "a plugin that runs no code needs no confirmation"
    );
}

/// A duplicate row - the same installation reported twice - is one target, never two writes.
#[test]
fn a_duplicated_row_is_one_target() {
    let rows = vec![
        row("code@official", "user", true, true),
        row("code@official", "user", true, true),
    ];
    assert_eq!(unconfirmed_enabled(&rows, &[]).len(), 1);
    assert_eq!(installs(&rows, "code@official", None).len(), 1);
}

/// What an install added is read from the two lists the host gave - the installations that were
/// not there before - because which plugin an install source resolves to is the engine's
/// classification, and a re-install of an existing installation adds no row at all.
#[test]
fn what_an_install_added_is_what_the_list_gained() {
    let before = vec![row("hello@official", "user", true, false)];
    let after = vec![
        row("hello@official", "user", true, false),
        row("hello@official", "project", true, true),
        row("other", "user", true, false),
    ];

    assert_eq!(
        added_installs(&before, &after),
        vec![
            InstallRef {
                id: "hello@official".to_owned(),
                target: "hello@official".to_owned(),
                scope: "project".to_owned(),
                consent_required: true,
            },
            InstallRef {
                id: "other".to_owned(),
                target: "other".to_owned(),
                scope: "user".to_owned(),
                consent_required: false,
            },
        ],
        "the installation the list gained, with the scope it gained it at"
    );
    assert!(
        added_installs(&after, &after).is_empty(),
        "a re-install adds no row"
    );
    assert!(
        added_installs(&after, &before).is_empty(),
        "a removal adds nothing"
    );
}

/// Enabling is failed closed in both directions: every installation the write could flip has to
/// hold its own confirmation (AND), while one installation that runs code is enough to make the
/// confirmation necessary (OR).
#[test]
fn the_enable_gate_needs_every_row_confirmed() {
    let needs = |consent_required, granted| GateAnswer {
        consent_required,
        granted,
    };

    let refused = gate(&[needs(true, true), needs(true, false)]).expect_err("one row short");
    assert_eq!(refused.code.as_ref(), PLUGIN_CONSENT_REQUIRED);
    assert!(
        gate(&[needs(true, false), needs(false, false)]).is_err(),
        "a code row without a confirmation is refused even when the other row needs none"
    );
    assert!(
        gate(&[needs(true, true), needs(false, false)]).is_err(),
        "the AND is over every installation the write could flip, not only the ones that ask"
    );
    assert!(
        gate(&[needs(true, true), needs(false, true)]).is_ok(),
        "both installations hold their own confirmation"
    );
    assert!(
        gate(&[needs(false, false)]).is_ok(),
        "a plugin that runs no code needs no grant of its own"
    );
    assert!(gate(&[needs(false, false), needs(false, false)]).is_ok());
    assert!(
        gate(&[needs(false, true)]).is_ok(),
        "a confirmed row of a plugin that needs none is still allowed"
    );
}

/// The audit scope is only named when the list itself can name it: one installation of that id
/// answers the question, two do not.
#[test]
fn an_unnamed_write_is_attributed_only_when_one_scope_can_be() {
    let one = installs(
        &[row("hello@official", "user", true, true)],
        "hello@official",
        None,
    );
    assert_eq!(sole_scope(&one), Some("user"));
    assert_eq!(sole_scope(&[]), None);

    let both = installs(
        &[
            row("hello@official", "user", true, true),
            row("hello@official", "project", true, true),
        ],
        "hello@official",
        None,
    );
    assert_eq!(sole_scope(&both), None, "two scopes are not a scope");
}

/// A confirmation is recorded for an installation the workspace can see; a write that names none
/// is answered with the only scope the id is installed at, and refused when that is ambiguous.
#[test]
fn a_grant_is_recorded_for_a_visible_installation() {
    let rows = vec![
        row("hello@official", "user", true, true),
        row("other", "project", true, false),
    ];

    assert_eq!(
        grant_scope(&rows, "hello@official", None).expect("the only scope"),
        "user"
    );
    assert_eq!(
        grant_scope(&rows, "hello@official", Some("project"))
            .expect_err("not there")
            .code
            .as_ref(),
        PLUGIN_NOT_FOUND
    );
    assert_eq!(
        grant_scope(&rows, "missing", None)
            .expect_err("not installed")
            .code
            .as_ref(),
        PLUGIN_NOT_FOUND
    );
    assert_eq!(
        grant_scope(&rows, "missing", Some("user"))
            .expect_err("not installed")
            .code
            .as_ref(),
        PLUGIN_NOT_FOUND
    );

    let both = vec![
        row("hello@official", "user", true, true),
        row("hello@official", "project", true, true),
    ];
    assert_eq!(
        grant_scope(&both, "hello@official", Some("project")).expect("named"),
        "project"
    );
    assert_eq!(
        grant_scope(&both, "hello@official", None)
            .expect_err("ambiguous")
            .code
            .as_ref(),
        INVALID_INPUT
    );
}

/// The identity an answer is stored under follows the scope. The user scope is one installation
/// in every workspace, so it is keyed by the empty string whatever workspace the caller named -
/// the gate looks it up by the same key. A project-scope installation belongs to one workspace,
/// and a write that has no workspace to name is refused rather than keyed by a substitution.
#[test]
fn a_project_grant_is_keyed_by_the_workspace_it_was_given_in() {
    assert_eq!(
        grant_key("user", None).expect("the shared key"),
        "",
        "the user scope needs no workspace"
    );
    assert_eq!(
        grant_key("user", Some("C:/project/demo")).expect("the shared key"),
        "",
        "and it is not keyed by one, because the same installation is installed in all of them"
    );

    assert_eq!(
        grant_key("project", Some("C:/project/demo")).expect("the workspace's own key"),
        "C:/project/demo"
    );
    assert_eq!(
        grant_key("project", None)
            .expect_err("no workspace to record it under")
            .code
            .as_ref(),
        INVALID_INPUT,
        "fail-closed: an answer nobody can attribute is not recorded"
    );
}

/// A disable is only believed when the list that came back says the row is off - or does not
/// hold it at all.
#[test]
fn a_row_that_came_back_enabled_is_not_stopped() {
    let off = vec![row("code@official", "user", false, true)];
    let on = vec![row("code@official", "user", true, true)];
    let other_scope = vec![row("code@official", "project", true, true)];

    assert!(!enabled_at(&off, "code@official", "user"));
    assert!(
        !enabled_at(&[], "code@official", "user"),
        "a gone row runs nothing"
    );
    assert!(!enabled_at(&other_scope, "code@official", "user"));
    assert!(enabled_at(&on, "code@official", "user"));
}
