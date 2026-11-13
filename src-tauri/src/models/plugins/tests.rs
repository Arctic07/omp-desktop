//! Wire contract of the plugin models: one test per field group the frontend reads by name.
//!
//! Split out of `plugins.rs` when it outgrew one file (`rules.md#single-file-line-limit`); the assertions and the paths
//! inside them are unchanged - these are the only lines of that module the application does not
//! carry into the binary.

use super::*;
use serde_json::json;
use std::collections::BTreeMap;

/// A host row whose other fields say nothing: these tests read the desktop block and the verdict
/// the conversion gives it.
fn view(desktop: Option<EngineDesktopBlock>) -> PluginRowView {
    PluginRowView::from(EnginePluginRow {
        id: "hello@official".to_owned(),
        name: "Hello Plugin".to_owned(),
        description: None,
        version: Some("0.1.0".to_owned()),
        scope: "user".to_owned(),
        enabled: false,
        builtin: false,
        toggleable: false,
        shadowed_by: None,
        install_id: None,
        source: EnginePluginSource::default(),
        sources: Vec::new(),
        installed_at: None,
        last_updated: None,
        root_path: None,
        consent: EnginePluginConsent::default(),
        code: EnginePluginCode::default(),
        settings: EnginePluginSettingsSummary::default(),
        features: Vec::new(),
        desktop,
        desktop_error: None,
    })
}

/// One block as a plugin declares it, with only the fields these tests read filled in.
fn block(valid: bool, reason: Option<&str>, permissions: &[&str]) -> EngineDesktopBlock {
    EngineDesktopBlock {
        schema_version: 1,
        valid,
        reason: reason.map(str::to_owned),
        permissions: permissions.iter().map(|name| (*name).to_owned()).collect(),
        ..EngineDesktopBlock::default()
    }
}

/// One page entry of the shape the four lists carry, with only its icon under test.
fn page(id: &str, icon: Option<&str>) -> EngineDesktopPage {
    EngineDesktopPage {
        id: id.to_owned(),
        entry: "index.html".to_owned(),
        icon: icon.map(str::to_owned),
        ..EngineDesktopPage::default()
    }
}

/// A block whose one panel carries `icon`, declared with the permission that list needs.
fn block_with_panel(icon: Option<&str>) -> EngineDesktopBlock {
    EngineDesktopBlock {
        valid: true,
        permissions: vec!["ui.panel".to_owned()],
        panels: vec![page("main", icon)],
        ..EngineDesktopBlock::default()
    }
}

/// A block naming only permissions this build serves is carried as the host reported it, verdict
/// and reason included, and a plugin without a desktop block keeps having none.
#[test]
fn a_valid_desktop_block_passes_through_unchanged() {
    let desktop = view(Some(block(
        true,
        None,
        &["ui.panel", "notify", "agent.extension"],
    )))
    .desktop
    .expect("the block travels");
    assert!(desktop.valid);
    assert_eq!(desktop.reason, None);
    assert_eq!(desktop.permissions.len(), 3);

    assert!(
        view(None).desktop.is_none(),
        "no block stays no block, not an empty one"
    );
}

/// A block the host called valid but that names a permission outside the P1 set is refused here:
/// the first offending name is the whole reason, the declared list is left as the host read it,
/// and only the verdict changes.
#[test]
fn an_out_of_set_permission_downgrades_the_block() {
    let desktop = view(Some(block(
        true,
        None,
        &["ui.panel", "clipboard.pwn", "fs.write"],
    )))
    .desktop
    .expect("the block travels");
    assert!(!desktop.valid);
    assert_eq!(
        desktop.reason.as_deref(),
        Some("unknown_permission:clipboard.pwn"),
        "the first out-of-set name, and nothing else, is the reason"
    );
    assert_eq!(
        desktop.permissions,
        vec![
            "ui.panel".to_owned(),
            "clipboard.pwn".to_owned(),
            "fs.write".to_owned()
        ],
        "what the block declares is reported, not rewritten"
    );
}

/// A block the host already refused keeps its own reason: its verdict is about the block as a
/// whole, and replacing that with this layer's narrower complaint would lose the diagnosis.
#[test]
fn a_block_the_host_already_refused_keeps_its_reason() {
    let desktop = view(Some(block(
        false,
        Some("panels[0] has no entry"),
        &["clipboard.pwn"],
    )))
    .desktop
    .expect("the block travels");
    assert!(!desktop.valid);
    assert_eq!(desktop.reason.as_deref(), Some("panels[0] has no entry"));
}

/// The plugin's translation table is display metadata this layer does not interpret: whatever the
/// host read travels to the page value for value, and a plugin that declares none keeps none.
#[test]
fn desktop_i18n_is_carried_through_unchanged() {
    let declared = json!({
        "en": { "name": "Hello Plugin", "description": "Says hello" },
        "zh": { "name": "冒烟插件" }
    });
    let desktop = view(Some(EngineDesktopBlock {
        valid: true,
        i18n: Some(declared.clone()),
        ..EngineDesktopBlock::default()
    }))
    .desktop
    .expect("the block travels");
    assert_eq!(desktop.i18n, Some(declared));

    let without = view(Some(block(true, None, &["notify"])))
        .desktop
        .expect("the block travels");
    assert_eq!(without.i18n, None, "no table stays no table");
}

/// A page's icon is a token the page resolves against its own table, so this layer checks the shape
/// and never the name (spec §3.2): a token travels as written, a name this build has never heard of
/// is still a token, an absent icon stays absent, and a value outside the shape refuses the block
/// the way every other entry field does.
#[test]
fn a_page_icon_is_a_token_or_absent() {
    let checked = |icon: Option<&str>| {
        view(Some(block_with_panel(icon)))
            .desktop
            .expect("the block travels")
    };

    let carried = checked(Some("browser"));
    assert!(carried.valid);
    assert_eq!(carried.panels[0].icon.as_deref(), Some("browser"));

    let unknown = checked(Some("no-such-icon"));
    assert!(
        unknown.valid,
        "the name set is the page's, not this layer's"
    );
    assert_eq!(unknown.panels[0].icon.as_deref(), Some("no-such-icon"));

    assert_eq!(
        checked(None).panels[0].icon,
        None,
        "an absent icon stays absent"
    );

    // The wire shape: the host's own key, and a page that declares no icon read as absent.
    let declared: EngineDesktopPage = serde_json::from_value(json!({
        "id": "main", "entry": "index.html", "icon": "browser"
    }))
    .expect("a page with an icon reads");
    assert_eq!(declared.icon.as_deref(), Some("browser"));
    let absent: EngineDesktopPage =
        serde_json::from_value(json!({"id": "main", "entry": "index.html"}))
            .expect("a page without an icon reads");
    assert_eq!(absent.icon, None);

    let refused = checked(Some("Not An Icon"));
    assert!(!refused.valid);
    assert_eq!(refused.reason.as_deref(), Some("invalid_entry_field:main"));
    assert!(
        refused.panels.is_empty(),
        "a refused block declares no pages"
    );
}

/// The icon is an entry field of every list, not only the panels: one declared on each of the four
/// travels with the page it was written on.
#[test]
fn every_page_list_carries_an_icon() {
    let desktop = view(Some(EngineDesktopBlock {
        valid: true,
        permissions: ["ui.panel", "ui.view", "ui.settings", "ui.tab"]
            .iter()
            .map(|name| (*name).to_owned())
            .collect(),
        panels: vec![page("panel", Some("browser"))],
        views: vec![page("view", Some("list"))],
        settings_destinations: vec![page("settings", Some("sliders"))],
        sidebar_tabs: vec![page("tab", Some("globe-2"))],
        ..EngineDesktopBlock::default()
    }))
    .desktop
    .expect("the block travels");

    assert!(desktop.valid);
    assert_eq!(
        [
            desktop.panels[0].icon.as_deref(),
            desktop.views[0].icon.as_deref(),
            desktop.settings_destinations[0].icon.as_deref(),
            desktop.sidebar_tabs[0].icon.as_deref(),
        ],
        [
            Some("browser"),
            Some("list"),
            Some("sliders"),
            Some("globe-2")
        ]
    );
}

/// One work-panel tab of the shape the list carries, with only its renderer and icon under test.
fn work_tab(id: &str, renderer: &str, icon: Option<&str>) -> EngineWorkPanelTab {
    EngineWorkPanelTab {
        id: id.to_owned(),
        renderer: renderer.to_owned(),
        icon: icon.map(str::to_owned),
        ..EngineWorkPanelTab::default()
    }
}

/// A work-panel tab reaches the page as the manifest wrote it - under the contract's own field name -
/// and it needs the work panel's permission (`ui.view`) exactly as a docked view does. A list
/// declared without it, or a tab whose renderer is not a token, refuses the block whole, the way
/// every other entry list does; nothing about a refused block may be drawn.
#[test]
fn a_work_panel_tab_needs_its_permission_and_a_renderer_token() {
    let carried = view(Some(EngineDesktopBlock {
        valid: true,
        permissions: vec!["ui.view".to_owned()],
        work_panel_tabs: vec![work_tab("terminal", "terminal", Some("terminal"))],
        ..EngineDesktopBlock::default()
    }))
    .desktop
    .expect("the block travels");
    assert!(carried.valid);
    assert_eq!(carried.work_panel_tabs.len(), 1);
    assert_eq!(carried.work_panel_tabs[0].id, "terminal");
    assert_eq!(carried.work_panel_tabs[0].renderer, "terminal");
    assert_eq!(carried.work_panel_tabs[0].icon.as_deref(), Some("terminal"));
    // The name the frontend reads it by is the contract's, not this struct's own spelling.
    let wire = serde_json::to_value(&carried).expect("the block serialises");
    assert_eq!(wire["workPanelTabs"][0]["renderer"], "terminal");
    assert_eq!(wire["workPanelTabs"][0]["order"], 0);

    let missing_permission = view(Some(EngineDesktopBlock {
        valid: true,
        permissions: Vec::new(),
        work_panel_tabs: vec![work_tab("terminal", "terminal", None)],
        ..EngineDesktopBlock::default()
    }))
    .desktop
    .expect("the block travels");
    assert!(!missing_permission.valid);
    assert!(missing_permission.work_panel_tabs.is_empty());
    assert_eq!(
        missing_permission.reason.as_deref(),
        Some("entry_permission_missing:ui.view")
    );

    let bad_renderer = view(Some(EngineDesktopBlock {
        valid: true,
        permissions: vec!["ui.view".to_owned()],
        work_panel_tabs: vec![work_tab("terminal", "Terminal 1", None)],
        ..EngineDesktopBlock::default()
    }))
    .desktop
    .expect("the block travels");
    assert!(!bad_renderer.valid);
    assert!(bad_renderer.work_panel_tabs.is_empty());
    assert_eq!(
        bad_renderer.reason.as_deref(),
        Some("invalid_entry_field:terminal")
    );
}

/// The engine-info frame's field names are the contract the frontend types are written against:
/// a host answer spelled exactly as the contract spells it reads into the struct, and the struct
/// writes those same keys back out.
#[test]
fn engine_info_uses_the_contract_field_names() {
    let answer = json!({
        "sdkVersion": "18.6.1",
        "protocol": 14,
        "toolchain": { "bun": true, "git": false, "npm": true }
    });

    let info: EnginePluginEngineInfo =
        serde_json::from_value(answer.clone()).expect("the host's answer reads");
    assert_eq!(info.sdk_version, "18.6.1");
    assert_eq!(info.protocol, 14);
    assert!(info.toolchain.bun);
    assert!(!info.toolchain.git);
    assert!(info.toolchain.npm);

    assert_eq!(
        serde_json::to_value(&info).expect("the answer writes"),
        answer
    );
}

/// The reload answer's field names are the contract the frontend types are written against, and
/// `failed` is read with a default ([`EnginePluginReloadResult`]): a host from before the field
/// answers the older shape and is read as no failures, while a host that reports it is read in
/// full - which is what makes the field an increment rather than a protocol change.
#[test]
fn the_reload_answer_reads_with_or_without_the_failed_count() {
    let before: EnginePluginReloadResult =
        serde_json::from_value(json!({"reloaded": true, "sessions": 3}))
            .expect("a host from before the field reads");
    assert!(before.reloaded);
    assert_eq!(before.sessions, 3);
    assert_eq!(before.failed, 0, "no report of a failure is no failure");

    let answered = json!({"reloaded": false, "sessions": 3, "failed": 2});
    let current: EnginePluginReloadResult =
        serde_json::from_value(answered.clone()).expect("the host's answer reads");
    assert!(!current.reloaded);
    assert_eq!(current.sessions, 3);
    assert_eq!(current.failed, 2);
    assert_eq!(
        serde_json::to_value(&current).expect("the answer writes"),
        answered
    );
}

/// The page is told which row is a plugin this application ships with, and the flag is the mark
/// this side writes (`services::plugins::builtin::apply_trust`) rather than anything the row
/// spells: a same-named package from npm or from somebody else's marketplace is an ordinary plugin
/// the user can uninstall, and calling it built-in would offer them a rule this application does
/// not apply to it.
#[test]
fn only_a_marked_installation_reaches_the_page_as_built_in() {
    let reserved = "omp-desktop-builtin";
    let row = |plugin_id: &str, kind: &str, marketplace: Option<&str>| EnginePluginRow {
        id: plugin_id.to_owned(),
        install_id: marketplace.map(|marketplace| format!("{plugin_id}@{marketplace}")),
        source: EnginePluginSource {
            kind: kind.to_owned(),
            label: match marketplace {
                Some(marketplace) => format!("{plugin_id}@{marketplace}"),
                None => plugin_id.to_owned(),
            },
            marketplace: marketplace.map(str::to_owned),
            ..EnginePluginSource::default()
        },
        // The built-in installation lives at the shared scope; the mark is keyed on that identity.
        scope: "user".to_owned(),
        ..EnginePluginRow::default()
    };
    let mut rows = EnginePluginsView {
        plugins: vec![
            // This application's own bundle.
            row("omp.terminal", "marketplace", Some(reserved)),
            // The same plugin name, from somebody else's marketplace: not ours.
            row("omp.terminal", "marketplace", Some("some-marketplace")),
            // The same plugin name, linked from a development directory.
            row("omp.terminal", "npm", None),
        ],
    };
    // Unverified: nothing is built-in, however a row spells itself.
    assert!(PluginsView::from(rows.clone())
        .plugins
        .iter()
        .all(|row| !row.builtin));

    crate::services::plugins::builtin::apply_trust(&mut rows, true);
    let plugins = PluginsView::from(rows);
    assert!(plugins.plugins[0].builtin);
    assert!(!plugins.plugins[1].builtin);
    assert!(!plugins.plugins[2].builtin);
    assert!(!view(None).builtin, "an ordinary row is not built-in");
}

/// The additive row fields travel under exactly the names the frontend types declare, and a host
/// that predates them still parses: `installId`, `source.marketplace` / `source.installId` /
/// `source.installed`, and `sources[]` (plan §4.1).
#[test]
fn the_row_carries_the_host_identity_and_its_sources() {
    let host = json!({
        "id": "demo-plugin",
        "name": "Demo",
        "description": null,
        "version": "1.2.3",
        "scope": "user",
        "enabled": true,
        "shadowedBy": null,
        "installId": "demo-plugin@market-a",
        "source": {
            "kind": "marketplace",
            "label": "demo-plugin@market-a",
            "gitCommitSha": "abc",
            "marketplace": "market-a",
            "installId": "demo-plugin@market-a",
            "installed": true
        },
        "sources": [
            {"marketplace": "market-a", "version": "1.2.3", "sourceLabel": "demo-plugin@market-a", "installed": true},
            {"marketplace": "market-b", "version": "2.0.0", "sourceLabel": "demo-plugin@market-b", "installed": false}
        ],
        "installedAt": "2026-10-01T00:00:00.000Z",
        "lastUpdated": null,
        "rootPath": "/plugins/demo",
        "consent": {"required": false, "reasons": []},
        "code": {},
        "settings": {"keys": [], "hasSecret": false},
        "desktop": null,
        "desktopError": null
    });
    let row: EnginePluginRow = serde_json::from_value(host.clone()).expect("the host row reads");
    assert_eq!(row.install_id.as_deref(), Some("demo-plugin@market-a"));
    assert_eq!(row.source.marketplace.as_deref(), Some("market-a"));
    assert!(row.source.installed);
    assert_eq!(row.sources.len(), 2);
    assert_eq!(row.sources[1].version, "2.0.0");
    assert_eq!(row.sources[1].source_label, "demo-plugin@market-b");
    assert!(!row.sources[1].installed);

    // The page's shape: the same fields, minus the machine-local root path.
    let view = serde_json::to_value(PluginRowView::from(row)).expect("the view writes");
    assert_eq!(view["id"], "demo-plugin");
    assert_eq!(view["installId"], "demo-plugin@market-a");
    assert_eq!(view["source"]["marketplace"], "market-a");
    assert_eq!(view["source"]["installId"], "demo-plugin@market-a");
    assert_eq!(view["source"]["installed"], true);
    assert_eq!(view["sources"][0]["sourceLabel"], "demo-plugin@market-a");
    assert_eq!(view["sources"][1]["marketplace"], "market-b");
    assert!(
        view.get("rootPath").is_none(),
        "a machine path is not page material"
    );
}

/// A row from a host before `installId` and `sources` existed parses with both absent, and the
/// identity rule then reads the engine's handle out of `id` (`models::plugins::plugin_id`).
#[test]
fn a_row_from_before_the_identity_fields_still_parses() {
    let legacy = json!({
        "id": "demo-plugin@market-a",
        "name": "Demo",
        "scope": "user",
        "enabled": false,
        "source": {"kind": "marketplace", "label": "demo-plugin@market-a"},
        "consent": {"required": true, "reasons": ["hooks-dir"]}
    });
    let row: EnginePluginRow = serde_json::from_value(legacy).expect("an older host reads");
    assert!(row.install_id.is_none());
    assert!(row.sources.is_empty());
    assert!(row.source.marketplace.is_none());
    assert!(!row.source.installed);
    assert_eq!(identity::plugin_id(&row), "demo-plugin");
    assert_eq!(identity::install_spec(&row), "demo-plugin@market-a");
}

/// The update answer's field names are the frontend's, and both halves of it are read with a
/// default: a host from before the cross-market scan answers without `candidates`, and one that
/// cannot resolve a handle answers `installId`/`marketplace` as `null`.
#[test]
fn the_update_answer_reads_both_halves_and_keeps_their_names() {
    let answer = json!({
        "updates": [{
            "pluginId": "demo-plugin",
            "installId": "demo-plugin@market-b",
            "scope": "project",
            "from": "1.0.0",
            "to": "2.0.0",
            "marketplace": "market-b",
            "kind": "switch-source"
        }],
        "candidates": [{
            "pluginId": "demo-plugin",
            "scope": "project",
            "sources": [{"marketplace": "market-b", "version": "2.0.0"}]
        }]
    });
    let view: EnginePluginUpdatesView =
        serde_json::from_value(answer.clone()).expect("the host's answer reads");
    assert_eq!(view.updates[0].plugin_id, "demo-plugin");
    assert_eq!(
        view.updates[0].install_id.as_deref(),
        Some("demo-plugin@market-b")
    );
    assert_eq!(view.updates[0].kind, "switch-source");
    assert_eq!(view.candidates[0].sources[0].version, "2.0.0");
    assert_eq!(
        serde_json::to_value(&view).expect("the answer writes"),
        answer
    );

    let older: EnginePluginUpdatesView =
        serde_json::from_value(json!({"updates": []})).expect("a host without the scan reads");
    assert!(older.candidates.is_empty());

    let unresolved: updates::EnginePluginUpdate = serde_json::from_value(json!({
        "pluginId": "demo-plugin",
        "scope": "user",
        "from": "1.0.0",
        "to": "2.0.0",
        "kind": "in-place"
    }))
    .expect("a row with no handle reads");
    assert!(unresolved.install_id.is_none());
    assert!(unresolved.marketplace.is_none());
}

/// The switch answer is the list the other plugin commands answer with, plus what the switch moved -
/// the four fields the page reads, under the names it reads them by.
#[test]
fn the_switch_answer_is_a_plugin_list_and_what_moved() {
    let answer = PluginUpdateSwitchView {
        plugins: vec![view(None)],
        switched: PluginUpdateSwitch {
            from: "hello@official".to_owned(),
            to: "hello@other".to_owned(),
            marketplace: "other".to_owned(),
            rolled_back: false,
        },
    };
    let written = serde_json::to_value(&answer).expect("the answer writes");
    assert_eq!(written["plugins"][0]["id"], "hello@official");
    assert_eq!(written["switched"]["from"], "hello@official");
    assert_eq!(written["switched"]["to"], "hello@other");
    assert_eq!(written["switched"]["marketplace"], "other");
    assert_eq!(written["switched"]["rolledBack"], false);
}

// ---- theme content (plan §5, T1) ----

/// One theme declaring a stylesheet and an asset, with the permission pair the block needs.
fn themed_block() -> EngineDesktopBlock {
    let mut declared = block(true, None, &["ui.theme", "ui.theme.css"]);
    declared.themes = vec![EnginePluginTheme {
        id: "midnight".to_owned(),
        label: Some(json!({"en": "Midnight"})),
        dark: Some(true),
        tokens: BTreeMap::from([("--dsw-alias-bg-base".to_owned(), "#0b0f1a".to_owned())]),
        css: Some("desktop/themes/midnight.css".to_owned()),
        assets: vec!["desktop/themes/bg.svg".to_owned()],
        css_error: None,
    }];
    declared
}

/// One host row holding that block, at a scope and root path the caller chooses.
fn themed_row(enabled: bool, root: Option<&str>) -> EnginePluginRow {
    EnginePluginRow {
        id: "demo-plugin".to_owned(),
        name: "Demo".to_owned(),
        version: Some("1.0.0".to_owned()),
        scope: "user".to_owned(),
        enabled,
        root_path: root.map(str::to_owned),
        desktop: Some(themed_block()),
        ..EnginePluginRow::default()
    }
}

/// A scratch package holding the files the themed block declares.
fn theme_package(tag: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("omp-model-theme-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    for (relative, body) in [
        (
            "desktop/themes/midnight.css",
            "a{background:url(bg.svg)}".as_bytes(),
        ),
        ("desktop/themes/bg.svg", b"<svg/>".as_slice()),
    ] {
        let path = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("parent");
        std::fs::write(&path, body).expect("write");
    }
    root
}

/// The three fields travel under the names the frontend types declare, and a theme that declares
/// nothing parses with them absent.
#[test]
fn a_theme_carries_its_stylesheet_assets_and_refusal() {
    let host: EnginePluginTheme = serde_json::from_value(json!({
        "id": "midnight",
        "label": {"en": "Midnight"},
        "dark": true,
        "tokens": {"--dsw-alias-bg-base": "#0b0f1a"},
        "css": "desktop/themes/midnight.css",
        "assets": ["desktop/themes/bg.svg"],
        "cssError": "theme_css_invalid"
    }))
    .expect("the host theme reads");
    assert_eq!(host.css.as_deref(), Some("desktop/themes/midnight.css"));
    assert_eq!(host.assets, vec!["desktop/themes/bg.svg".to_owned()]);
    assert_eq!(host.css_error.as_deref(), Some("theme_css_invalid"));

    let written = serde_json::to_value(&host).expect("the theme writes");
    assert_eq!(written["css"], "desktop/themes/midnight.css");
    assert_eq!(written["assets"][0], "desktop/themes/bg.svg");
    assert_eq!(written["cssError"], "theme_css_invalid");

    let bare: EnginePluginTheme =
        serde_json::from_value(json!({"id": "plain", "tokens": {}})).expect("no content declared");
    assert!(bare.css.is_none());
    assert!(bare.assets.is_empty());
    assert!(bare.css_error.is_none());
}

/// A theme whose declared content is read is carried as text and URLs on the row the page receives -
/// never as the paths the host reported.
#[test]
fn a_theme_stylesheet_is_read_and_rewritten_on_the_row() {
    let root = theme_package("applied");
    let root_text = root.to_string_lossy().to_string();
    let desktop = PluginRowView::from(themed_row(true, Some(&root_text)))
        .desktop
        .expect("the block travels");
    let theme = &desktop.themes[0];
    let url =
        crate::services::plugins::pages::entry_url("demo-plugin", "user", "desktop/themes/bg.svg")
            .expect("the asset is addressable");
    assert_eq!(theme.assets, vec![url.clone()]);
    assert_eq!(
        theme.css.as_deref(),
        Some(format!("a{{background:url(\"{url}\")}}").as_str())
    );
    assert!(theme.css_error.is_none());
    assert_eq!(theme.tokens.len(), 1);
}

/// A disabled installation is served nothing, so its row carries no stylesheet to inject and no URL
/// to fetch - and it is not a refusal either: nothing was read, and `cssError` says nothing.
#[test]
fn a_disabled_installation_carries_no_theme_content() {
    let root = theme_package("disabled");
    let root_text = root.to_string_lossy().to_string();
    let desktop = PluginRowView::from(themed_row(false, Some(&root_text)))
        .desktop
        .expect("the block travels");
    let theme = &desktop.themes[0];
    assert!(theme.css.is_none());
    assert!(theme.assets.is_empty());
    assert!(theme.css_error.is_none());
    assert_eq!(theme.tokens.len(), 1, "the tokens stay usable");
}

/// Content that cannot be read is a per-theme refusal: the theme keeps its tokens, the block keeps
/// its pages, and the row names the reason instead of swallowing it.
#[test]
fn unreadable_theme_content_is_reported_per_theme() {
    let desktop = PluginRowView::from(themed_row(true, None))
        .desktop
        .expect("the block travels");
    assert!(
        desktop.valid,
        "a stylesheet a theme could not read is not a block refusal"
    );
    let theme = &desktop.themes[0];
    assert!(theme.css.is_none());
    assert!(theme.assets.is_empty());
    assert_eq!(theme.css_error.as_deref(), Some("theme_css_invalid"));
    assert_eq!(theme.tokens.len(), 1);
}

/// The two theme permissions are re-read here: a theme list without `ui.theme`, and declared content
/// without `ui.theme.css`, each refuse the block whole - the same answer a panel without `ui.panel`
/// gets, so a host that validated more loosely cannot grant the reach.
#[test]
fn a_theme_without_its_permissions_refuses_the_block() {
    let mut without_theme = themed_block();
    without_theme.permissions = vec!["ui.theme.css".to_owned()];
    let refused = view(Some(without_theme))
        .desktop
        .expect("the block travels");
    assert!(!refused.valid);
    assert_eq!(
        refused.reason.as_deref(),
        Some("entry_permission_missing:ui.theme")
    );

    let mut without_content = themed_block();
    without_content.permissions = vec!["ui.theme".to_owned()];
    let refused = view(Some(without_content))
        .desktop
        .expect("the block travels");
    assert!(!refused.valid);
    assert_eq!(
        refused.reason.as_deref(),
        Some("entry_permission_missing:ui.theme.css")
    );

    // Tokens alone need no content permission, so a token-only theme is still served.
    let mut tokens_only = themed_block();
    tokens_only.themes[0].css = None;
    tokens_only.themes[0].assets.clear();
    tokens_only.permissions = vec!["ui.theme".to_owned()];
    let carried = view(Some(tokens_only)).desktop.expect("the block travels");
    assert!(carried.valid);
    assert_eq!(carried.themes.len(), 1);
}

// ---- renderer slots (plan §7, T3) ----

/// The slot module a block declares, with the two whitelists these tests read.
fn renderer_block() -> EngineDesktopBlock {
    let mut declared = block(true, None, &["renderer.extension"]);
    declared.renderer = Some(EnginePluginRenderer {
        path: Some("desktop/renderer.mjs".to_owned()),
        actions: vec!["plugin.call".to_owned(), "composer.insertText".to_owned()],
        call_methods: vec!["listSnippets".to_owned(), "insert.snippet-1".to_owned()],
        ..EnginePluginRenderer::default()
    });
    declared
}

/// One host row holding that block, at the enabled state and root path the caller chooses.
fn renderer_row(enabled: bool, root: Option<&str>) -> EnginePluginRow {
    EnginePluginRow {
        id: "demo-plugin".to_owned(),
        name: "Demo".to_owned(),
        version: Some("1.0.0".to_owned()),
        scope: "user".to_owned(),
        enabled,
        root_path: root.map(str::to_owned),
        desktop: Some(renderer_block()),
        ..EnginePluginRow::default()
    }
}

/// A scratch package holding the module the block declares.
fn renderer_package(tag: &str) -> std::path::PathBuf {
    let root =
        std::env::temp_dir().join(format!("omp-model-renderer-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let module = root.join("desktop").join("renderer.mjs");
    std::fs::create_dir_all(module.parent().expect("a parent")).expect("parent");
    std::fs::write(&module, b"export function onLoad() {}\n").expect("write");
    root
}

/// The `url` is the fixed slot host's, derived from the installation's own key and never from the
/// declared path - and both dispatch whitelists travel exactly as the manifest wrote them.
#[test]
fn a_renderer_carries_its_lists_and_the_fixed_host_url() {
    let root = renderer_package("served");
    let root_text = root.to_string_lossy().to_string();
    let desktop = PluginRowView::from(renderer_row(true, Some(&root_text)))
        .desktop
        .expect("the block travels");
    assert!(desktop.valid);
    let renderer = desktop.renderer.expect("the module travels");
    assert!(renderer.available);
    assert_eq!(renderer.reason, None);
    assert_eq!(renderer.path.as_deref(), Some("desktop/renderer.mjs"));
    assert_eq!(
        renderer.actions,
        vec!["plugin.call".to_owned(), "composer.insertText".to_owned()]
    );
    assert_eq!(
        renderer.call_methods,
        vec!["listSnippets".to_owned(), "insert.snippet-1".to_owned()]
    );

    let key = crate::services::plugins::pages::origin_key("demo-plugin", "user");
    let expected = if cfg!(any(windows, target_os = "android")) {
        format!("http://omp-renderer.localhost/{key}/renderer.mjs")
    } else {
        format!("omp-renderer://{key}/renderer.mjs")
    };
    assert_eq!(renderer.url.as_deref(), Some(expected.as_str()));
    assert!(!expected.contains("demo-plugin"), "{expected}");

    // The page reads the fields by these names; `callMethods` is the contract's spelling, not the
    // struct's.
    let wire = serde_json::to_value(&renderer).expect("the renderer writes");
    assert_eq!(wire["callMethods"][0], "listSnippets");
    assert_eq!(wire["available"], true);
    assert_eq!(wire["reason"], serde_json::Value::Null);
    assert_eq!(wire["url"], expected);
}

/// The availability matrix: a disabled installation, and a module file that is not there, each keep
/// the declaration but get no address and their own reason token.
#[test]
fn a_renderer_is_available_only_when_enabled_present_and_permitted() {
    let root = renderer_package("matrix");
    let root_text = root.to_string_lossy().to_string();

    let disabled = PluginRowView::from(renderer_row(false, Some(&root_text)))
        .desktop
        .expect("the block travels");
    let renderer = disabled.renderer.expect("the module travels");
    assert!(!renderer.available);
    assert_eq!(
        renderer.reason.as_deref(),
        Some("renderer_module_unavailable")
    );
    assert_eq!(renderer.url, None);
    assert_eq!(renderer.call_methods.len(), 2, "the declaration travels");

    let mut missing_root = renderer_row(true, Some(&root_text));
    if let Some(declared) = missing_root
        .desktop
        .as_mut()
        .and_then(|b| b.renderer.as_mut())
    {
        declared.path = Some("desktop/absent.mjs".to_owned());
    }
    let renderer = PluginRowView::from(missing_root)
        .desktop
        .expect("the block travels")
        .renderer
        .expect("the module travels");
    assert!(!renderer.available);
    assert_eq!(renderer.reason.as_deref(), Some("renderer_module_missing"));
    assert_eq!(renderer.url, None);
    // No root at all is the same answer: there is nowhere to look.
    let no_root = PluginRowView::from(renderer_row(true, None))
        .desktop
        .expect("the block travels")
        .renderer
        .expect("the module travels");
    assert!(!no_root.available);
    assert_eq!(no_root.reason.as_deref(), Some("renderer_module_missing"));
}

/// The renderer block's own three refusal tokens: a path this layer would not serve, an action
/// outside the closed vocabulary, and a method list past its bound each refuse the block whole.
#[test]
fn the_renderer_block_is_re_read_here() {
    let mut bad_path = renderer_block();
    bad_path.renderer.as_mut().expect("declared").path = Some("desktop/renderer.txt".to_owned());
    let refused = view(Some(bad_path)).desktop.expect("the block travels");
    assert!(!refused.valid);
    assert_eq!(refused.reason.as_deref(), Some("invalid_renderer_path"));

    let mut bad_action = renderer_block();
    bad_action.renderer.as_mut().expect("declared").actions =
        vec!["composer.everything".to_owned()];
    let refused = view(Some(bad_action)).desktop.expect("the block travels");
    assert!(!refused.valid);
    assert_eq!(refused.reason.as_deref(), Some("invalid_renderer_actions"));

    // A duplicate is not the list its author wrote, and is refused for the same reason.
    let mut duplicate = renderer_block();
    duplicate.renderer.as_mut().expect("declared").actions =
        vec!["plugin.call".to_owned(), "plugin.call".to_owned()];
    assert_eq!(
        view(Some(duplicate))
            .desktop
            .expect("the block travels")
            .reason
            .as_deref(),
        Some("invalid_renderer_actions")
    );

    let mut too_many = renderer_block();
    too_many.renderer.as_mut().expect("declared").call_methods =
        (0..33).map(|index| format!("method{index}")).collect();
    let refused = view(Some(too_many)).desktop.expect("the block travels");
    assert!(!refused.valid);
    assert_eq!(
        refused.reason.as_deref(),
        Some("invalid_renderer_call_methods")
    );

    // A method that is not a method name is the same refusal as one past the bound.
    let mut bad_method = renderer_block();
    bad_method.renderer.as_mut().expect("declared").call_methods = vec!["not a method".to_owned()];
    assert_eq!(
        view(Some(bad_method))
            .desktop
            .expect("the block travels")
            .reason
            .as_deref(),
        Some("invalid_renderer_call_methods")
    );
}

/// The module's one permission is re-read here too: a block that declares a module, an action or a
/// method without `renderer.extension` is refused, and the row that asked for it reports the
/// permission as the reason rather than the shape.
#[test]
fn a_renderer_without_its_permission_refuses_the_block() {
    let mut unpermitted = renderer_block();
    unpermitted.permissions = Vec::new();
    let refused = PluginRowView::from(EnginePluginRow {
        id: "demo-plugin".to_owned(),
        scope: "user".to_owned(),
        enabled: true,
        root_path: Some(
            renderer_package("unpermitted")
                .to_string_lossy()
                .to_string(),
        ),
        desktop: Some(unpermitted),
        ..EnginePluginRow::default()
    })
    .desktop
    .expect("the block travels");
    assert!(!refused.valid);
    assert_eq!(
        refused.reason.as_deref(),
        Some("entry_permission_missing:renderer.extension")
    );
    let renderer = refused.renderer.expect("the declaration still travels");
    assert!(!renderer.available);
    assert_eq!(
        renderer.reason.as_deref(),
        Some("renderer_module_unavailable")
    );
    assert_eq!(renderer.url, None);
}

/// The two keys of `net.anyHost` (API 0.2.0), re-read on this side: the block's flag without the
/// permission is refused whole, so egress can never widen on a boolean the consent gate never saw.
#[test]
fn the_any_host_flag_without_its_permission_is_refused_whole() {
    let mut desktop = block(true, None, &["net.fetch"]);
    desktop.net_any_host = true;
    let refused = view(Some(desktop))
        .desktop
        .expect("a block the host reported");
    assert!(
        !refused.valid,
        "the pair is one declaration, and half of it loads nothing"
    );
    assert_eq!(
        refused.reason.as_deref(),
        Some("entry_permission_missing:net.anyHost")
    );

    let mut granted = block(true, None, &["net.fetch", "net.anyHost"]);
    granted.net_any_host = true;
    let kept = view(Some(granted))
        .desktop
        .expect("a block the host reported");
    assert!(
        kept.valid,
        "both keys together are a reach this build serves"
    );
    assert!(kept.net_any_host);
}
