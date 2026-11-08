//! The page and theme-asset resolver, rule by rule: what one installation serves, and what every
//! other request is refused with.
//!
//! Split out of `pages.rs` when it outgrew one file (`rules.md#single-file-line-limit`): the assertions and the paths
//! inside them are unchanged - these are the only lines of that module the application does not
//! carry into the binary.

use super::*;

fn page(id: &str, scope: &str, entries: &[&str]) -> PluginPage {
    PluginPage {
        plugin_id: id.to_owned(),
        name: id.to_owned(),
        scope: scope.to_owned(),
        root: std::env::temp_dir(),
        enabled: true,
        revision: format!("rev:{}", entries.join("|")),
        pages: entries
            .iter()
            .map(|entry| Page {
                id: "main".to_owned(),
                kind: PageKind::Panel,
                entry: (*entry).to_owned(),
                title: None,
                width: None,
                height: None,
                resizable: None,
            })
            .collect(),
        theme_assets: Vec::new(),
        renderer_module: None,
        grants: PageGrants::default(),
    }
}

/// The key is what a URL's authority carries: ASCII, lowercase, one label, and never the id.
#[test]
fn an_origin_key_is_a_host_label_and_not_an_id() {
    let key = origin_key("@scope/pkg", "user");
    assert_eq!(key.len(), 32);
    assert!(key.chars().all(|c| c.is_ascii_hexdigit()));
    assert!(!key.contains("@"));
    assert_ne!(
        key,
        origin_key("@scope/pkg", "project"),
        "the scope is part of the identity"
    );
    assert_ne!(key, origin_key("@scope/pkg2", "user"));
    assert_eq!(
        key,
        origin_key("@scope/pkg", "user"),
        "the same install keeps its origin"
    );
}

/// A page is addressed under its own origin, with the entry's segments escaped and no `..`.
#[test]
fn a_page_url_is_its_origin_plus_the_entry() {
    let served = page("smoke-plugin", "user", &["desktop/panel/index.html"]);
    let origin = served.origin();
    let url =
        page_url(&origin, "desktop/panel/index.html").expect("a declared entry is addressable");
    assert!(url.starts_with(&origin), "{url}");
    assert!(url.ends_with("/desktop/panel/index.html"), "{url}");
    assert!(page_url(&origin, "../outside.html").is_none());
    assert!(page_url(&origin, "/etc/passwd").is_none());
    assert!(page_url(&origin, "desktop\\panel\\index.html").is_none());
    assert_eq!(
        page_url(&origin, "desktop/panel/a b#c.html").as_deref(),
        Some(format!("{origin}/desktop/panel/a%20b%23c.html").as_str()),
        "a filename with a space or a fragment marker survives the round trip"
    );
    assert!(
        entry_url("smoke-plugin", "user", "index.html").is_some(),
        "the same origin is derived from the installation's identity"
    );
}

/// The request one plugin page makes is read as the origin key and the path below it.
#[test]
fn a_request_is_read_back_into_a_key_and_a_path() {
    let uri = Url::parse("omp-plugin://abc123/desktop/panel/index.html").expect("a url");
    let request = parse_request(&uri).expect("a plugin request");
    assert_eq!(request.key, "abc123");
    assert_eq!(request.path, "desktop/panel/index.html");

    let encoded = Url::parse("omp-plugin://abc/a%20b/c.html").expect("a url");
    assert_eq!(parse_request(&encoded).expect("decoded").path, "a b/c.html");

    assert!(parse_request(&Url::parse("omp-plugin://abc/%2e%2e/secret").expect("a url")).is_some());
    assert!(parse_request(&Url::parse("tauri://localhost/index.html").expect("a url")).is_none());
    assert!(parse_request(&Url::parse("omp-plugin://a/b%zz").expect("a url")).is_none());
}

/// Only a page's own bundle is reachable: a sibling directory of the declared entry is not.
#[test]
fn only_a_declared_entries_directory_is_served() {
    assert!(lies_under_entry_directory(
        "desktop/panel/index.html",
        "desktop/panel/app.js"
    ));
    assert!(lies_under_entry_directory(
        "desktop/panel/index.html",
        "desktop/panel/sub/a.css"
    ));
    assert!(!lies_under_entry_directory(
        "desktop/panel/index.html",
        "desktop/other/a.js"
    ));
    assert!(!lies_under_entry_directory(
        "desktop/panel/index.html",
        "desktop/panels/x"
    ));
    // An entry at the package root serves the package: that is the plugin that ships one page.
    assert!(lies_under_entry_directory("index.html", "lib/app.js"));
}

/// The path shape every lookup shares refuses traversal, absolute paths and separators the
/// renderer would resolve differently than the filesystem does.
#[test]
fn a_relative_path_is_all_the_resolver_accepts() {
    assert!(is_safe_relative("desktop/panel/index.html"));
    assert!(is_safe_relative("index.html"));
    assert!(!is_safe_relative(""));
    assert!(!is_safe_relative("/etc/passwd"));
    assert!(!is_safe_relative("a/../b"));
    assert!(!is_safe_relative("a//b"));
    assert!(!is_safe_relative("a\\b"));
    assert!(!is_safe_relative("C:/windows/system32"));
    assert!(!is_safe_relative("a\0b"));
}

/// A disabled installation is refused before anything is looked up, and a valid one is not.
#[test]
fn a_disabled_installation_serves_nothing() {
    let mut disabled = page("smoke-plugin", "user", &["index.html"]);
    disabled.enabled = false;
    assert_eq!(
        resolve_asset(&disabled, "index.html"),
        Err(AssetRefusal::Disabled)
    );
}

/// The content type map answers by extension and never guesses past it.
#[test]
fn content_types_are_a_closed_map() {
    assert!(content_type("a/b/index.html").starts_with("text/html"));
    assert_eq!(content_type("a/B.JS"), "text/javascript; charset=utf-8");
    assert_eq!(
        content_type("a/thing.unknownext"),
        "application/octet-stream"
    );
    assert_eq!(content_type("a/no-extension"), "application/octet-stream");
}

/// The served policy allows the page its own files and no network at all.
#[test]
fn the_page_policy_blocks_the_network() {
    let policy = content_security_policy();
    assert!(policy.contains("connect-src 'self'"));
    assert!(policy.contains("default-src 'none'"));
    assert!(!policy.contains("http:"));
}

/// The registry is replaced wholesale, so a list that no longer holds an installation stops
/// serving it.
#[test]
fn publishing_replaces_what_is_served() {
    let registry = PluginPages::new();
    registry.publish(vec![page("smoke-plugin", "user", &["index.html"])]);
    assert_eq!(registry.len(), 1);
    assert!(registry.find("smoke-plugin", "user").is_some());
    assert!(registry.find("smoke-plugin", "project").is_none());

    registry.publish(Vec::new());
    assert_eq!(registry.len(), 0);
    assert!(registry.get(&origin_key("smoke-plugin", "user")).is_none());
}

/// `publish` answers the keys whose document set changed: a key it did not serve before, and a
/// key whose revision moved - the upgrade case, where id, scope and enabled state all stay put.
/// An unchanged revision is not a change, so a plain re-read closes nothing.
#[test]
fn publishing_answers_the_keys_whose_revision_changed() {
    let registry = PluginPages::new();
    let key = origin_key("smoke-plugin", "user");

    let mut first = page("smoke-plugin", "user", &["index.html"]);
    first.revision = "one".to_owned();
    assert_eq!(
        registry.publish(vec![first]),
        vec![key.clone()],
        "a key that was not served is new"
    );

    let mut same = page("smoke-plugin", "user", &["index.html"]);
    same.revision = "one".to_owned();
    assert!(
        registry.publish(vec![same]).is_empty(),
        "the same revision is not a change"
    );

    let mut upgraded = page("smoke-plugin", "user", &["index.html"]);
    upgraded.revision = "two".to_owned();
    assert_eq!(
        registry.publish(vec![upgraded]),
        vec![key],
        "a new revision is the upgrade a window has to be closed for"
    );
}

/// The revision covers the version and the declared entry set, in a stable order, and nothing
/// else: the same document set under another listing order is the same revision.
#[test]
fn the_revision_follows_the_version_and_the_entry_set() {
    let row = |version: &str, entries: &[&str]| {
        let mut row = crate::models::plugins::EnginePluginRow {
            id: "smoke-plugin".to_owned(),
            scope: "user".to_owned(),
            version: Some(version.to_owned()),
            ..crate::models::plugins::EnginePluginRow::default()
        };
        row.desktop = Some(crate::models::plugins::EngineDesktopBlock {
            valid: true,
            panels: entries
                .iter()
                .map(|entry| crate::models::plugins::EngineDesktopPage {
                    id: "main".to_owned(),
                    entry: (*entry).to_owned(),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        });
        row
    };

    // One row is parsed once, exactly as a list read does it: the pages this answers with are
    // what the revision is derived from.
    let revision = |version: &str, entries: &[&str]| {
        revision_from(version, &pages_of(&row(version, entries)), None)
    };

    let base = revision("1.0.0", &["a.html", "b.html"]);
    assert_eq!(
        base,
        revision("1.0.0", &["b.html", "a.html"]),
        "the entry order does not change the document set"
    );
    assert_ne!(
        base,
        revision("1.1.0", &["a.html", "b.html"]),
        "a new version is a new revision"
    );
    assert_ne!(
        base,
        revision("1.0.0", &["a.html"]),
        "a dropped entry is a new revision"
    );
    assert_eq!(
        base,
        revision("1.0.0", &["a.html", "b.html"]),
        "the same facts keep the same revision"
    );
}

/// A refused block contributes no pages at all, whatever it lists.
#[test]
fn a_refused_block_declares_nothing() {
    let mut row = crate::models::plugins::EnginePluginRow {
        id: "smoke-plugin".to_owned(),
        scope: "user".to_owned(),
        ..crate::models::plugins::EnginePluginRow::default()
    };
    row.desktop = Some(crate::models::plugins::EngineDesktopBlock {
        valid: false,
        panels: vec![crate::models::plugins::EngineDesktopPage {
            id: "main".to_owned(),
            entry: "index.html".to_owned(),
            ..Default::default()
        }],
        ..Default::default()
    });
    assert!(pages_of(&row).is_empty());

    row.desktop = Some(crate::models::plugins::EngineDesktopBlock {
        valid: true,
        panels: vec![crate::models::plugins::EngineDesktopPage {
            id: "main".to_owned(),
            entry: "desktop/panel/index.html".to_owned(),
            ..Default::default()
        }],
        ..Default::default()
    });
    let pages = pages_of(&row);
    assert_eq!(pages.len(), 1);
    assert_eq!(pages[0].entry, "desktop/panel/index.html");
}

/// A scratch plugin root for one test: the page's own bundle, a theme asset a theme declared, and one
/// file beside it that no theme declared.
fn theme_package(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("omp-pages-theme-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    for relative in [
        "desktop/panel/index.html",
        "desktop/themes/bg.svg",
        "desktop/themes/hidden.png",
    ] {
        let path = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("parent");
        std::fs::write(&path, b"<svg/>").expect("write");
    }
    root
}

/// One installation declaring a panel and one theme asset, both real files.
fn theme_page(tag: &str) -> PluginPage {
    let mut served = page("smoke-plugin", "user", &["desktop/panel/index.html"]);
    served.root = theme_package(tag);
    served.theme_assets = vec!["desktop/themes/bg.svg".to_owned()];
    served
}

/// A theme asset is served from the installation's own origin, with the type its extension names -
/// and it is served although it lies outside the declared entry's directory, which is why the theme
/// list has to be its own branch of the resolver.
#[test]
fn a_declared_theme_asset_is_served_with_its_type() {
    let served = theme_page("served");
    let path = resolve_asset(&served, "desktop/themes/bg.svg").expect("a declared theme asset");
    assert!(path.ends_with("bg.svg"), "{}", path.display());
    assert_eq!(read_asset(&path).expect("bytes"), b"<svg/>");
    assert_eq!(content_type("desktop/themes/bg.svg"), "image/svg+xml");
    assert_eq!(content_type("desktop/themes/bg.avif"), "image/avif");
    assert_eq!(content_type("desktop/themes/bg.woff2"), "font/woff2");
}

/// A file beside a declared asset is not served: a theme may paint with what it declared, exactly.
/// The refusal is a policy one (`403`) because the request names an asset this installation never
/// declared, while a path of another shape outside every bundle stays the `404` it always was.
#[test]
fn a_path_beside_a_theme_asset_is_forbidden() {
    let served = theme_page("undeclared");
    assert_eq!(
        resolve_asset(&served, "desktop/themes/hidden.png"),
        Err(AssetRefusal::Forbidden)
    );
    assert_eq!(
        resolve_asset(&served, "desktop/themes/notes.md"),
        Err(AssetRefusal::NotFound)
    );
}

/// A disabled installation serves no theme asset, exactly as it serves no page.
#[test]
fn a_disabled_installation_serves_no_theme_asset() {
    let mut served = theme_page("disabled");
    served.enabled = false;
    assert_eq!(
        resolve_asset(&served, "desktop/themes/bg.svg"),
        Err(AssetRefusal::Disabled)
    );
}

/// An asset path that climbs out of the package, or names an absolute one, is refused before any
/// file is looked at.
#[test]
fn a_theme_asset_path_that_escapes_is_forbidden() {
    let served = theme_page("escape");
    for requested in [
        "../bg.svg",
        "desktop/themes/../../bg.svg",
        "/desktop/themes/bg.svg",
        "desktop\\themes\\bg.svg",
    ] {
        assert_eq!(
            resolve_asset(&served, requested),
            Err(AssetRefusal::Forbidden),
            "{requested}"
        );
    }
}

/// One installation cannot read another's theme asset: the origin decides which installation is
/// asked, and its own declared list decides which files it answers with.
#[test]
fn another_installations_theme_asset_is_forbidden() {
    let mut other = page("other-plugin", "user", &["desktop/panel/index.html"]);
    other.root = theme_package("other");
    other.theme_assets = vec!["desktop/themes/other.svg".to_owned()];
    assert_eq!(
        resolve_asset(&other, "desktop/themes/bg.svg"),
        Err(AssetRefusal::Forbidden),
        "the first installation's declared asset is not this one's"
    );
}

/// The files a page may never reach, whatever a manifest declares (spec §6.3).
#[test]
fn credential_files_and_private_directories_are_never_served() {
    assert!(gates::is_rejected_path(".env"));
    assert!(gates::is_rejected_path("desktop/.env.local"));
    assert!(gates::is_rejected_path(".ssh/id_rsa"));
    assert!(gates::is_rejected_path("keys/id_rsa.pub"));
    assert!(gates::is_rejected_path("certs/server.pem"));
    assert!(gates::is_rejected_path("a/b/.git/config"));
    assert!(gates::is_rejected_path(".docker/config.json"));
    assert!(gates::is_rejected_path("deploy/keystore.p12"));
    assert!(!gates::is_rejected_path("desktop/panel/index.html"));
    assert!(!gates::is_rejected_path("desktop/panel/env.js"));
    assert!(!gates::is_rejected_path("desktop/git/notes.md"));
}
