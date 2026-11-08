use super::*;
use crate::services::plugins::bridge::INTERNAL;
use crate::services::plugins::pages::{Page, PageGrants, PageKind};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// The roots a test's bridge calls resolve against: no workspace, and the fixture package.
fn test_roots() -> crate::services::plugins::gates::FsRoots {
    crate::services::plugins::gates::FsRoots {
        workspace: None,
        plugin: std::path::PathBuf::from("."),
    }
}

fn page(enabled: bool, entries: &[&str]) -> PluginPage {
    PluginPage {
        plugin_id: "smoke-plugin".to_owned(),
        name: "Smoke Plugin".to_owned(),
        scope: "user".to_owned(),
        root: PathBuf::from("."),
        enabled,
        revision: "rev:test".to_owned(),
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

/// A fake caller: no session grants, no window, no user - the "cannot ask" case, which is also
/// the case every one of these tests is about.
#[derive(Default)]
struct Nobody {
    closable: bool,
}

impl BridgeEffects for Nobody {
    fn holds(&self, _grant: &SessionGrant) -> bool {
        false
    }
    fn remember(&mut self, _grant: SessionGrant) {}
    fn ask(&mut self, _kind: PromptKind, _target: &str) -> Option<PromptAnswer> {
        None
    }
    fn close_caller(&mut self) -> bool {
        self.closable
    }
    fn notify(&mut self, _title: &str, _body: &str) {}
    fn take_delete(&mut self) -> bool {
        true
    }
    fn log_line(&mut self, _level: &'static str, _message: &str) {}
    // The P1 capabilities need an application these tests do not have: each answers the refusal a
    // caller with no host behind it would see.
    fn plugin_data(
        &mut self,
        _request: &crate::services::plugins::bridge::DataRequest,
    ) -> Result<serde_json::Value, Refusal> {
        Err(INTERNAL)
    }
    fn bus_publish(
        &mut self,
        _topic: &str,
        _payload: &serde_json::Value,
    ) -> Result<serde_json::Value, Refusal> {
        Err(INTERNAL)
    }
    fn bus_subscribe(&mut self, _topics: &[String]) -> Result<serde_json::Value, Refusal> {
        Err(INTERNAL)
    }
    fn open_external_url(&mut self, _url: &str) -> Result<(), Refusal> {
        Err(INTERNAL)
    }
    fn data_dir(&mut self) -> Result<String, Refusal> {
        Err(INTERNAL)
    }
    fn open_default(&mut self, _path: &str) -> Result<(), Refusal> {
        Err(INTERNAL)
    }
    fn reveal(&mut self, _path: &str) -> Result<(), Refusal> {
        Err(INTERNAL)
    }
    fn browser(
        &mut self,
        _request: &crate::services::plugins::bridge::BrowserRequest,
    ) -> Result<serde_json::Value, Refusal> {
        Err(INTERNAL)
    }
}

/// A request for an origin nothing is served under is refused before any lookup, and a disabled
/// installation refuses everything it declared.
#[test]
fn unknown_and_disabled_installations_are_refused() {
    let mut nobody = Nobody::default();
    assert_eq!(
        answer(None, &test_roots(), "index.html", None, &mut nobody).status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        answer(
            Some(&page(false, &["index.html"])),
            &test_roots(),
            "index.html",
            None,
            &mut nobody
        )
        .status,
        StatusCode::FORBIDDEN
    );
}

/// The bridge answers its served methods and nothing else, and `close` only for a window that
/// belongs to the installation. A call that names a method this build does not serve is a `403`
/// with no body, exactly like an asset path this application never hands out.
#[test]
fn the_bridge_serves_a_closed_set_of_methods() {
    let served = page(true, &["index.html"]);
    let query = |value: &str| Some(BridgeCall::Query(value.to_owned()));
    let mut owner = Nobody { closable: true };
    let mut docked = Nobody::default();
    assert_eq!(
        answer(
            Some(&served),
            &test_roots(),
            "__bridge",
            query("m=ready"),
            &mut owner
        )
        .status,
        StatusCode::OK
    );
    assert_eq!(
        answer(
            Some(&served),
            &test_roots(),
            "__bridge",
            query("m=close"),
            &mut owner
        )
        .status,
        StatusCode::OK
    );
    assert_eq!(
        answer(
            Some(&served),
            &test_roots(),
            "__bridge",
            query("m=close"),
            &mut docked
        )
        .status,
        StatusCode::OK,
        "a refused close is an envelope, not a transport failure"
    );
    assert_eq!(
        docked_refusal(&served, "m=close"),
        "permission_denied",
        "a docked page may not close a window it does not own"
    );
    assert_eq!(
        answer(
            Some(&served),
            &test_roots(),
            "__bridge",
            query("m=nope"),
            &mut owner
        )
        .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        answer(Some(&served), &test_roots(), "__bridge", None, &mut owner).status,
        StatusCode::FORBIDDEN,
        "a bridge request that names no method never was one"
    );
}

/// One bridge call answered through the real dispatch, with a caller that cannot be asked, so a
/// test can read the envelope a page would.
fn docked_refusal(page: &PluginPage, query: &str) -> String {
    let mut asker = Nobody::default();
    let answer = answer(
        Some(page),
        &test_roots(),
        "__bridge",
        Some(BridgeCall::Query(query.to_owned())),
        &mut asker,
    );
    let body: serde_json::Value = serde_json::from_slice(&answer.body).expect("an envelope");
    body["code"].as_str().unwrap_or_default().to_owned()
}

/// The bridge's success body for a method with no result is the fixed `{"ok":true}`: it carries
/// no caller text, so nothing a page sends can reach it.
#[test]
fn the_bridge_success_body_is_a_constant() {
    let served = page(true, &["index.html"]);
    let mut nobody = Nobody::default();
    let answer = answer(
        Some(&served),
        &test_roots(),
        "__bridge",
        Some(BridgeCall::Query("m=ready".to_owned())),
        &mut nobody,
    );
    assert_eq!(answer.status, StatusCode::OK);
    assert_eq!(answer.body, b"{\"ok\":true}".to_vec());
}

/// A response that fails to build is a `500`, never the default `200` a bare `Response::new`
/// would give.
#[test]
fn a_failed_response_build_is_a_server_error() {
    let fallback = internal_error_response();
    assert_eq!(fallback.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(!fallback.status().is_success());
}

/// A refused request's path is logged on one line: a decoded `%0a` cannot forge a second entry,
/// and a long path is clipped rather than written whole.
#[test]
fn a_refused_path_is_logged_on_one_line() {
    let decoded = pages::percent_decode("a%0aINFO fake").expect("decodes");
    let logged = log_safe_path(&decoded);
    assert!(!logged.contains('\n'), "{logged:?}");
    assert!(!logged.contains('\r'), "{logged:?}");
    assert_eq!(logged, "a INFO fake");

    let long = "x".repeat(LOG_PATH_MAX + 50);
    assert_eq!(log_safe_path(&long).chars().count(), LOG_PATH_MAX);
}

/// A page the installation declared is answered with the content type its extension names; a
/// path outside the declared entry's directory is not answered at all.
#[test]
fn declared_assets_are_answered_and_the_rest_is_not() {
    let root = std::env::temp_dir().join("omp-desktop-page-fixture");
    let _ = std::fs::create_dir_all(root.join("desktop/panel"));
    let _ = std::fs::write(root.join("desktop/panel/index.html"), b"<html></html>");
    let _ = std::fs::write(root.join("secret.txt"), b"no");
    let mut served = page(true, &["desktop/panel/index.html"]);
    served.root = root.clone();

    let mut nobody = Nobody::default();
    let document = answer(
        Some(&served),
        &test_roots(),
        "desktop/panel/index.html",
        None,
        &mut nobody,
    );
    assert_eq!(document.status, StatusCode::OK);
    assert!(document.content_type.starts_with("text/html"));

    assert_eq!(
        answer(
            Some(&served),
            &test_roots(),
            "secret.txt",
            None,
            &mut nobody
        )
        .status,
        StatusCode::NOT_FOUND,
        "a file outside the declared entry's directory is not served"
    );
    assert_eq!(
        answer(
            Some(&served),
            &test_roots(),
            "desktop/panel/../index.html",
            None,
            &mut nobody
        )
        .status,
        StatusCode::FORBIDDEN
    );
    let _ = std::fs::remove_dir_all(root);
}

/// The headers every answer carries are the boundary: no sniffing, no cache, no network for the
/// page's own fetches.
#[test]
fn every_answer_carries_the_boundary_headers() {
    let response = Answer::text(StatusCode::OK, "hi").into_response();
    let headers = response.headers();
    assert_eq!(headers.get("X-Content-Type-Options").unwrap(), "nosniff");
    assert_eq!(headers.get(header::CACHE_CONTROL).unwrap(), "no-store");
    assert!(headers
        .get(header::CONTENT_SECURITY_POLICY)
        .unwrap()
        .to_str()
        .expect("ascii")
        .contains("connect-src 'self'"));
}

/// A title‑carrying page is the shape `pages_of` reads; the bridge's parameter spelling is a
/// small vocabulary, so it is asserted here rather than assumed.
#[test]
fn a_page_title_is_the_pages_own() {
    let mut titles = BTreeMap::new();
    titles.insert("zh".to_owned(), "冒烟面板".to_owned());
    let served = PluginPage {
        pages: vec![Page {
            id: "main".to_owned(),
            kind: PageKind::Panel,
            entry: "desktop/panel/index.html".to_owned(),
            title: Some(titles.clone()),
            width: Some(480),
            height: Some(360),
            resizable: Some(false),
        }],
        ..page(true, &[])
    };
    assert_eq!(
        served
            .page(PageKind::Panel, "main")
            .and_then(|page| page.title.clone()),
        Some(titles)
    );
    assert!(served.page(PageKind::View, "main").is_none());
}

/// One line is one line: a plugin's own words reach this application's log with everything that
/// would make them more than a line replaced, so nothing a page writes can forge a second line -
/// of its own, of another plugin's, or of this application's.
#[test]
fn a_plugins_line_cannot_become_two() {
    assert_eq!(strip_control_characters("one\ntwo"), "one two");
    assert_eq!(strip_control_characters("a\r\nb"), "a  b");
    assert_eq!(strip_control_characters("tab\there"), "tab here");
    assert_eq!(strip_control_characters("plain text"), "plain text");
    assert_eq!(
        strip_control_characters("emoji ok \u{1F41F}"),
        "emoji ok \u{1F41F}"
    );
}

/// One declared theme asset is the only plugin file another origin may read.
///
/// The application's own document draws a theme's background image and its `@font-face` text, and a
/// browser fetches a font in CORS mode - so the answer for a file the manifest listed in
/// `themes[].assets` carries `Access-Control-Allow-Origin`. A page's own asset does not: making a
/// plugin page's script or stylesheet readable by another origin is reach the protocol never grants
/// (`renderer.rs` answers its module the same way, for the same reason).
#[test]
fn only_a_declared_theme_asset_is_readable_from_another_origin() {
    let directory = std::env::temp_dir().join(format!(
        "omp-protocol-theme-asset-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default()
    ));
    std::fs::create_dir_all(directory.join("desktop/themes")).expect("a fixture directory");
    std::fs::create_dir_all(directory.join("desktop/panel")).expect("a fixture page directory");
    std::fs::write(directory.join("desktop/themes/ui.woff2"), b"wOF2").expect("a fixture font");
    std::fs::write(
        directory.join("desktop/panel/index.html"),
        b"<!doctype html>",
    )
    .expect("a page");

    let served = PluginPage {
        root: directory.clone(),
        theme_assets: vec!["desktop/themes/ui.woff2".to_owned()],
        ..page(true, &["desktop/panel/index.html"])
    };

    let font = answer(
        Some(&served),
        &test_roots(),
        "desktop/themes/ui.woff2",
        None,
        &mut Nobody::default(),
    )
    .into_response();
    assert_eq!(font.headers()["Access-Control-Allow-Origin"], "*");
    assert_eq!(
        font.headers()["Cross-Origin-Resource-Policy"],
        "cross-origin"
    );
    assert_eq!(font.headers()["X-Content-Type-Options"], "nosniff");

    let page_asset = answer(
        Some(&served),
        &test_roots(),
        "desktop/panel/index.html",
        None,
        &mut Nobody::default(),
    )
    .into_response();
    assert!(
        page_asset
            .headers()
            .get("Access-Control-Allow-Origin")
            .is_none(),
        "a page's own asset stays same-origin only"
    );

    let _ = std::fs::remove_dir_all(&directory);
}
