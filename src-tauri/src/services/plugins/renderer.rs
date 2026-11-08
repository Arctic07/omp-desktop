//! The `omp-renderer://` protocol: the one fixed host a slot module is fetched from (plan D2, T3).
//!
//! A plugin's slot module runs in this application's own document, so the page imports it as a
//! module. The import address cannot be derived from the plugin's own origins: on Windows a plugin's
//! page origin is `http://omp-plugin.<key>`, and a CSP host source cannot wildcard a middle label -
//! so a fixed host serves exactly one file per installation instead. The address is
//! `http://omp-renderer.localhost/<key>/renderer.mjs` on Windows, and `omp-renderer://<key>/renderer.mjs`
//! everywhere else, where `<key>` is the same opaque install key the page origins use
//! (`pages::origin_key`).
//!
//! **Both spellings are in the CSP for one reason.** `src-tauri/tauri.conf.json` carries a single
//! `script-src` for every platform, and the address a document may import differs by platform: the
//! Windows form is an `http` origin (`http://omp-renderer.localhost`) while the other platforms use
//! the custom scheme (`omp-renderer:`). One spelling alone would leave the other platform's import
//! blocked. The sources are added to `script-src` only - a module import is a script fetch - and
//! nothing about `style-src`, `unsafe-eval` or framing changes.
//!
//! **What is served is one fixed name, not a path.** The handler answers `/<key>/renderer.mjs`
//! (Windows keeps the key as the first path segment because the authority is the fixed host) for an
//! installation that is enabled and declared a `renderer`, reading the one module file the manifest
//! declared. Every other path - a second file, a `..`, a listing - is a `404`; a key this process
//! serves but the engine has disabled is a `403`. The file itself is resolved against the plugin
//! root, canonicalised, and checked to still be inside it, so a symlink cannot relocate it.
//!
//! **Cross-origin, deliberately.** The app document's origin is not the renderer host, so the
//! module is fetched in CORS mode: the `200` carries `Access-Control-Allow-Origin: *` and
//! `Cross-Origin-Resource-Policy: cross-origin`. Every response carries `nosniff` and `no-store`
//! (a cached module from the previous package is the failure nobody can explain), and none carries
//! a CSP - this is a script, not a document.
//!
//! **A served module is one audit line** (`plugin.renderer.load`): the module bytes are already in
//! hand, so the digest of exactly those bytes is the module revision the trail dedupes by. Reading
//! the same file twice is not two loads; replacing its content is.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tauri::http::{header, Request as HttpRequest, Response, StatusCode};
use tauri::{Manager, Url};

use crate::errors::{PLUGIN_ACTION_UNDECLARED, PLUGIN_ACTION_UNKNOWN};
use crate::services::log;
use crate::services::plugins::audit;
use crate::services::plugins::gates;
use crate::services::plugins::pages::{self, PluginPage};
use crate::services::plugins::validate::validate_renderer_method;
use crate::state::AppState;

/// The scheme the fixed slot host answers on. Registered next to `pages::PLUGIN_SCHEME` in `lib.rs`.
pub(crate) const SCHEME: &str = "omp-renderer";

/// The fixed name a module is addressed by. The declared package-relative path never appears in a
/// URL: the handler maps this one name to the file the manifest declared.
pub(crate) const MODULE_FILE: &str = "renderer.mjs";

/// The authority Windows requests arrive under (`http://omp-renderer.localhost/...`). On the other
/// platforms the key is the authority and there is no second label.
const LOCALHOST: &str = "localhost";

/// Why an installation may not load its module: the engine is not running it, or this build did not
/// grant it the permission.
pub(crate) const REASON_MODULE_UNAVAILABLE: &str = "renderer_module_unavailable";

/// Why an installation may not load its module: it is enabled and permitted, but the declared file
/// is not there (or the row carries no root to look in).
pub(crate) const REASON_MODULE_MISSING: &str = "renderer_module_missing";

/// Ceiling on one module's bytes. A slot module is code that runs in the application document; this
/// bound keeps a declared file from being read into memory without end.
const MAX_MODULE_BYTES: u64 = 8 * 1024 * 1024;

/// The longest key the origin derivation produces: sixteen bytes as lowercase hex.
const KEY_LEN: usize = 32;

/// The one URL a module is loaded from, for the platform this build runs on.
///
/// The platform split mirrors [`pages::origin`] and for the same reason: Windows (and Android) only
/// ever sees the `http` form its webview stack rewrites a custom scheme into, while the other
/// platforms load the scheme directly.
pub(crate) fn module_url(plugin_id: &str, scope: &str) -> String {
    module_url_for(plugin_id, scope, cfg!(any(windows, target_os = "android")))
}

/// The same address for a named platform.
///
/// The `cfg!` in [`module_url`] can only be exercised on the machine the tests run on, so the choice
/// itself is a parameter here: both spellings are then decided by one function, and the test below
/// proves the one this machine cannot run. What it does not prove - and cannot, without a macOS or
/// Linux host - is that those platforms register and serve the custom scheme the way `lib.rs` asks
/// them to.
fn module_url_for(plugin_id: &str, scope: &str, rewritten_scheme: bool) -> String {
    let key = pages::origin_key(plugin_id, scope);
    if rewritten_scheme {
        format!("http://{SCHEME}.{LOCALHOST}/{key}/{MODULE_FILE}")
    } else {
        format!("{SCHEME}://{key}/{MODULE_FILE}")
    }
}

/// One request for a slot module: the installation it names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ModuleRequest {
    pub(crate) key: String,
}

/// The request one incoming URI spells, or `None` when it is not a request for a module.
///
/// The URI is read **before** it is parsed, because the URL parser removes dot segments: a
/// `..../renderer.mjs` request would otherwise arrive here as the very path this function serves.
/// The text the webview sent is the only place a traversal is still visible, so it is where the
/// refusal happens ([`is_dot_segment`]).
///
/// The URI arrives in the scheme's own form on every platform (wry rewrites the Windows `http` form
/// on the way in and back on the way out), so both shapes are read here: the Windows one carries the
/// fixed authority and the key as its first path segment, and the other one carries the key as its
/// authority. Exactly one name below that is answered; anything else - another file, a traversal, an
/// encoded segment - is not a module request at all.
pub(crate) fn parse_request(uri: &str) -> Option<ModuleRequest> {
    let path = uri.split(['?', '#']).next().unwrap_or_default();
    if path.split('/').any(is_dot_segment) {
        return None;
    }
    let uri = Url::parse(uri).ok()?;
    if uri.scheme() != SCHEME {
        return None;
    }
    let authority = uri.host_str()?;
    let path = uri.path().trim_start_matches('/');
    let (key, rest) = if authority.eq_ignore_ascii_case(LOCALHOST) {
        let mut segments = path.splitn(2, '/');
        (segments.next()?, segments.next().unwrap_or_default())
    } else {
        (authority, path)
    };
    if rest != MODULE_FILE {
        return None;
    }
    let key = key.to_ascii_lowercase();
    if key.len() != KEY_LEN
        || !key
            .chars()
            .all(|character| character.is_ascii_digit() || ('a'..='f').contains(&character))
    {
        return None;
    }
    Some(ModuleRequest { key })
}

/// Whether one raw path segment is a dot segment, spelled or percent-encoded.
///
/// The URL parser treats `%2e` as `.` when it looks for dot segments, so a segment that survives
/// this check as `..` in any spelling would be normalised away before [`parse_request`] sees the
/// path. Both spellings are refused here for that reason.
fn is_dot_segment(segment: &str) -> bool {
    let lowered = segment.to_ascii_lowercase().replace("%2e", ".");
    lowered == "." || lowered == ".."
}

/// Whether one method may be called for an installation whose declaration is `declared`.
///
/// Shape first, declaration second: a word that is not a method name at all is
/// [`PLUGIN_ACTION_UNKNOWN`], and one that is well formed but was never whitelisted is
/// [`PLUGIN_ACTION_UNDECLARED`]. The same rule the slot host applies before it crosses IPC
/// (`src/src/state/plugin-slot-rules.ts`), re-applied here so a caller that skips the page cannot
/// reach a method the manifest did not declare.
pub(crate) fn method_refusal(declared: &[String], method: &str) -> Option<&'static str> {
    if !validate_renderer_method(method) {
        return Some(PLUGIN_ACTION_UNKNOWN);
    }
    if !declared.iter().any(|name| name == method) {
        return Some(PLUGIN_ACTION_UNDECLARED);
    }
    None
}

/// The module file one declared path names, when it is a file inside the plugin root.
///
/// `Ok` is the absolute path to read. Every refusal is the same `404` and carries no detail: the
/// caller is a browser import, and the reason belongs in the log. A path this application never
/// serves (`gates::is_rejected_path`) is refused before it is looked for; a canonicalised path that
/// left the root - a symlink or junction - is refused too.
fn resolve_module(root: &Path, declared: &str) -> Option<PathBuf> {
    if gates::is_rejected_path(declared) {
        return None;
    }
    let candidate = root.join(declared.replace('/', std::path::MAIN_SEPARATOR_STR));
    let resolved = std::fs::canonicalize(&candidate).ok()?;
    let root = std::fs::canonicalize(root).ok()?;
    if !crate::services::paths::is_within(&root, &resolved) || !resolved.is_file() {
        return None;
    }
    Some(resolved)
}

/// Whether one declared module path names a readable-size file inside the plugin root.
///
/// The row projection's `available` asks exactly the question the handler answers before it serves
/// (`resolve_module`), so a rendered `url` is one the protocol will honour - a page never imports an
/// address that answers `404`.
pub(crate) fn module_exists(root: &Path, declared: &str) -> bool {
    resolve_module(root, declared).is_some()
}

/// The module's bytes, when the file is one this build will read.
fn read_module(path: &Path) -> Option<Vec<u8>> {
    let metadata = std::fs::metadata(path).ok()?;
    if metadata.len() > MAX_MODULE_BYTES {
        return None;
    }
    std::fs::read(path).ok()
}

/// One answer the handler produces: a status, a content type and the body.
///
/// `refusal` is the token logged beside a non-`200` - "no installation is served under that key",
/// "the installation is disabled", "it declared no module" and "the file is not there" are four
/// different facts that three statuses cannot tell apart.
pub(crate) struct Answer {
    pub(crate) status: StatusCode,
    pub(crate) content_type: &'static str,
    pub(crate) body: Vec<u8>,
    pub(crate) refusal: Option<&'static str>,
}

impl Answer {
    fn refused(status: StatusCode, refusal: &'static str) -> Self {
        Self {
            status,
            content_type: "text/plain; charset=utf-8",
            body: Vec::new(),
            refusal: Some(refusal),
        }
    }

    /// The response one answer becomes.
    ///
    /// The `200` is the cross-origin module fetch, so it carries CORS and a cross-origin resource
    /// policy; every response carries the two headers that make the bytes inert if they are not what
    /// they claim to be (`nosniff`) and uncacheable (`no-store`). A build failure is an explicit
    /// `500`, never the default `200` a bare `Response::new` would give.
    pub(crate) fn into_response(self) -> Response<Vec<u8>> {
        let success = self.status == StatusCode::OK;
        let mut builder = Response::builder()
            .status(self.status)
            .header(header::CONTENT_TYPE, self.content_type)
            .header("X-Content-Type-Options", "nosniff")
            .header(header::CACHE_CONTROL, "no-store");
        if success {
            builder = builder
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .header("Cross-Origin-Resource-Policy", "cross-origin");
        }
        builder.body(self.body).unwrap_or_else(|_| {
            let mut response = Response::new(Vec::new());
            *response.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
            response
        })
    }
}

/// The answer to one already-resolved request, as a decision over the registry's answers.
///
/// Split from the incoming request so the dispatch is testable without a webview: `None` is a key
/// this process serves no installation under, an installation the engine has disabled answers
/// `403`, and everything else about an enabled installation - the declaration and the file - answers
/// `404` when it names nothing.
pub(crate) fn answer(page: Option<&PluginPage>) -> Answer {
    let Some(page) = page else {
        return Answer::refused(StatusCode::NOT_FOUND, "unknown_origin");
    };
    if !page.enabled {
        return Answer::refused(StatusCode::FORBIDDEN, "disabled");
    }
    let Some(declared) = page.renderer_module.as_deref() else {
        return Answer::refused(StatusCode::NOT_FOUND, "not_declared");
    };
    let Some(path) = resolve_module(&page.root, declared) else {
        return Answer::refused(StatusCode::NOT_FOUND, "module_missing");
    };
    let Some(body) = read_module(&path) else {
        return Answer::refused(StatusCode::NOT_FOUND, "module_unreadable");
    };
    audit::renderer_load(&page.plugin_id, &page.scope, &digest(&body));
    Answer {
        status: StatusCode::OK,
        content_type: "text/javascript; charset=utf-8",
        body,
        refusal: None,
    }
}

/// The revision of exactly the bytes that were served: the module content's identity.
///
/// A server that dedupes by metadata would miss a same-size rewrite of the same mtime tick; the
/// bytes are already in hand, so hashing them is the one honest revision this handler can name.
fn digest(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// One incoming request, answered off the webview's thread.
pub(crate) fn handle(
    app: &tauri::AppHandle,
    request: &HttpRequest<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let parsed = parse_request(&request.uri().to_string());
    let Some(parsed) = parsed else {
        responder.respond(Answer::refused(StatusCode::NOT_FOUND, "unknown_path").into_response());
        return;
    };
    let app = app.clone();
    // The answer is a filesystem read, so it is produced off the webview's thread; the registry is
    // read first because `State` is not `Send` and the page is the one fact the read needs.
    let page = app
        .try_state::<AppState>()
        .and_then(|state| state.pages.get(&parsed.key));
    tauri::async_runtime::spawn_blocking(move || {
        let answer = answer(page.as_deref());
        if answer.status != StatusCode::OK {
            log::info(&format!(
                "a plugin renderer request was refused: reason={} status={} plugin={}",
                answer.refusal.unwrap_or("unknown"),
                answer.status.as_u16(),
                page.as_ref()
                    .map(|page| page.plugin_id.as_str())
                    .unwrap_or("-"),
            ));
        }
        responder.respond(answer.into_response());
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::plugins::pages::{PageGrants, PluginPage};
    use std::path::PathBuf;

    /// A scratch package holding the module file the fixture page declares.
    fn fixture(tag: &str) -> PathBuf {
        static SEQUENCE: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let sequence = SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!(
            "omp-renderer-{tag}-{}-{sequence}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let module = root.join("desktop").join("renderer.mjs");
        std::fs::create_dir_all(module.parent().expect("a parent")).expect("parent");
        std::fs::write(&module, b"export function onLoad() {}\n").expect("write");
        root
    }

    fn page(root: Option<PathBuf>, enabled: bool, module: Option<&str>) -> PluginPage {
        PluginPage {
            plugin_id: "demo-plugin".to_owned(),
            name: "Demo".to_owned(),
            scope: "user".to_owned(),
            root: root.unwrap_or_else(std::env::temp_dir),
            enabled,
            revision: "rev:test".to_owned(),
            pages: Vec::new(),
            theme_assets: Vec::new(),
            renderer_module: module.map(str::to_owned),
            grants: PageGrants::default(),
        }
    }

    /// The address is the fixed host, the key and one file name - per platform - and never the
    /// declared path.
    #[test]
    fn a_module_url_is_the_fixed_host_and_the_install_key() {
        let key = pages::origin_key("demo-plugin", "user");
        let rewritten = module_url_for("demo-plugin", "user", true);
        let scheme = module_url_for("demo-plugin", "user", false);
        // Both spellings are decided here, so the branch this machine cannot run is still proved: the
        // Windows/Android form is an `http` origin, the other platforms load the custom scheme.
        assert_eq!(
            rewritten,
            format!("http://omp-renderer.localhost/{key}/renderer.mjs")
        );
        assert_eq!(scheme, format!("omp-renderer://{key}/renderer.mjs"));
        assert_eq!(
            module_url("demo-plugin", "user"),
            if cfg!(any(windows, target_os = "android")) {
                rewritten.clone()
            } else {
                scheme.clone()
            }
        );
        for url in [&rewritten, &scheme] {
            assert!(!url.contains("demo-plugin"), "{url}");
        }
    }

    /// Only one name below the key is a request: another file, a traversal, a second segment and an
    /// unserved scheme all answer nothing.
    #[test]
    fn only_the_module_name_is_a_request() {
        let key = pages::origin_key("demo-plugin", "user");
        assert_eq!(
            parse_request(&format!("omp-renderer://{key}/renderer.mjs")),
            Some(ModuleRequest { key: key.clone() })
        );
        assert_eq!(
            parse_request(&format!("omp-renderer://localhost/{key}/renderer.mjs")),
            Some(ModuleRequest { key })
        );
        for rejected in [
            "omp-renderer://0123456789abcdef0123456789abcdef/other.mjs",
            "omp-renderer://0123456789abcdef0123456789abcdef/../renderer.mjs",
            "omp-renderer://0123456789abcdef0123456789abcdef/%2e%2e/renderer.mjs",
            "omp-renderer://0123456789abcdef0123456789abcdef/desktop/renderer.mjs",
            "omp-renderer://0123456789abcdef0123456789abcdef/renderer.mjs/extra",
            "omp-plugin://0123456789abcdef0123456789abcdef/renderer.mjs",
        ] {
            assert!(parse_request(rejected).is_none(), "{rejected}");
        }
        assert!(
            parse_request("omp-renderer://short/renderer.mjs").is_none(),
            "a key is the derived label"
        );
        assert!(
            parse_request("not a url").is_none(),
            "text that is not a URL is not a request"
        );
    }

    /// An enabled installation's declared module is served as JavaScript, cross-origin, uncached and
    /// nosniffed - and nothing else gets those headers.
    #[test]
    fn an_enabled_installation_serves_its_module_with_the_boundary_headers() {
        let root = fixture("served");
        let served = page(Some(root), true, Some("desktop/renderer.mjs"));
        let answer = answer(Some(&served));
        assert_eq!(answer.status, StatusCode::OK);
        assert_eq!(answer.content_type, "text/javascript; charset=utf-8");
        assert_eq!(answer.refusal, None);
        let response = answer.into_response();
        let headers = response.headers();
        assert_eq!(
            headers[header::CONTENT_TYPE],
            "text/javascript; charset=utf-8"
        );
        assert_eq!(headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        assert_eq!(headers["Cross-Origin-Resource-Policy"], "cross-origin");
        assert_eq!(headers["X-Content-Type-Options"], "nosniff");
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");

        let refused = Answer::refused(StatusCode::FORBIDDEN, "disabled").into_response();
        assert!(
            !refused
                .headers()
                .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN),
            "a refusal is not a cross-origin resource"
        );
        assert_eq!(refused.headers()["X-Content-Type-Options"], "nosniff");
    }

    /// The refusal matrix: unknown key and undeclared module are `404`, disabled is `403`, and a
    /// declared file that is not there is `404` as well.
    #[test]
    fn only_an_enabled_declared_present_module_is_served() {
        let root = fixture("matrix");
        assert_eq!(
            answer(None).status,
            StatusCode::NOT_FOUND,
            "a key nothing is served under"
        );
        assert_eq!(
            answer(Some(&page(
                Some(root.clone()),
                false,
                Some("desktop/renderer.mjs")
            )))
            .status,
            StatusCode::FORBIDDEN,
            "a disabled installation"
        );
        assert_eq!(
            answer(Some(&page(Some(root.clone()), true, None))).status,
            StatusCode::NOT_FOUND,
            "an installation that declared no module"
        );
        assert_eq!(
            answer(Some(&page(
                Some(root.clone()),
                true,
                Some("desktop/missing.mjs")
            )))
            .status,
            StatusCode::NOT_FOUND,
            "a declared file that is not there"
        );
        assert_eq!(
            answer(Some(&page(None, true, Some("desktop/renderer.mjs")))).status,
            StatusCode::NOT_FOUND,
            "no root to look in"
        );
        assert_eq!(
            answer(Some(&page(Some(root), true, Some("../outside.mjs")))).status,
            StatusCode::NOT_FOUND,
            "the declared path is resolved below the root"
        );
    }

    /// The call whitelist: a declared method passes, a well-formed undeclared word is refused as
    /// undeclared, and a word that is not a method name at all is refused as unknown.
    #[test]
    fn the_call_whitelist_separates_unknown_from_undeclared() {
        let declared = vec!["listSnippets".to_owned(), "insert.snippet-1".to_owned()];
        assert_eq!(method_refusal(&declared, "listSnippets"), None);
        assert_eq!(method_refusal(&declared, "insert.snippet-1"), None);
        assert_eq!(
            method_refusal(&declared, "deleteEverything"),
            Some(PLUGIN_ACTION_UNDECLARED)
        );
        assert_eq!(
            method_refusal(&declared, "not a method"),
            Some(PLUGIN_ACTION_UNKNOWN)
        );
        assert_eq!(method_refusal(&declared, ""), Some(PLUGIN_ACTION_UNKNOWN));
    }
}
