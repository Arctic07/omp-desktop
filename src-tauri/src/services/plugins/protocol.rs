//! The `omp-plugin://` protocol: the only way a plugin page's assets and bridge calls are answered.
//!
//! Registered once for every webview (spec §7.2) and answered off the webview's own thread, because
//! every answer here is a filesystem read. What it serves, and to whom, is decided entirely by
//! `services::plugins::pages`; this module is the thin half that turns one HTTP-shaped request into
//! the resolver's answer and that answer into a response - with the three headers that make the
//! boundary hold:
//!
//! - `X-Content-Type-Options: nosniff`, because a page whose script is fetched as a stylesheet is a
//!   page whose script runs anyway if the renderer is allowed to guess;
//! - `Cache-Control: no-store`, because a plugin's files change on upgrade and a cached script from
//!   the previous version is the one failure nobody can explain;
//! - a `Content-Security-Policy` that gives the page its own bundle and no network at all.
//!
//! **The request's own headers are deliberately not checked.** A guard on the `Origin` or `Referer`
//! of an asset request looks like a boundary and is not one: the requests this scheme really carries
//! do not have the headers such a check would want. A same-origin subresource request - the document
//! an iframe loads, a stylesheet, a script, a relative `fetch` - carries no `Origin` at all, because
//! the renderer sends one only on the cross-origin requests it initiates itself; and the docked
//! page's iframe is framed with `referrerpolicy="no-referrer"`, so not even a `Referer` names the
//! frame it came from. Checking either header would refuse the normal traffic of
//! every page - the bridge call included, which is a same-origin `fetch` - while admitting whatever a
//! caller chooses to claim, which is the opposite of a boundary. What holds the boundary is the
//! browser's own same-origin policy: each installation is served from its own origin
//! (`pages::origin_key`), so a document can read the files of no origin but its own, and the CSP
//! every answer carries confines that document to its own bundle and to no network.
//!
//! Refusals are answered with an empty body and a status (404 for a path that names nothing, 403 for
//! one that names something this application never serves), never with a page that explains itself:
//! the reader is a plugin's own document, and the reason belongs in the log, not in the response.

use tauri::http::{header, Request as HttpRequest, Response, StatusCode};
use tauri::{Emitter, Manager};

use crate::services::log;
use crate::services::plugins::audit;
use crate::services::plugins::bridge::{
    self, BridgeCall, BridgeEffects, NoticePayload, Refusal, RefusalOrRequest, NOTICE_EVENT,
    PROMPT_TIMEOUT,
};
use crate::services::plugins::gates::SessionGrant;
use crate::services::plugins::pages::{
    self, content_security_policy, content_type, AssetRefusal, PluginPage,
};
use crate::services::plugins::prompt::{PromptAnswer, PromptKind, PromptRequest, PROMPT_EVENT};
use crate::state::AppState;

/// The answer one request produced: a status, a content type, and the body to send.
///
/// `refusal` is the token of the refusal this answer is, for the caller's own log line: two
/// refusals share the `404` status (`pages::AssetRefusal`), and a log that reports only the status
/// cannot tell "no installation is served under that origin" from "the file is not there" - the two
/// answers whose causes are entirely different (a page registry that has not published the
/// installation yet, against a package whose files moved under it).
pub(crate) struct Answer {
    pub(crate) status: StatusCode,
    pub(crate) content_type: &'static str,
    pub(crate) body: Vec<u8>,
    pub(crate) refusal: Option<&'static str>,
    /// Whether this answer is a **declared theme asset** (`omp.desktop.themes[].assets`).
    ///
    /// It is the one response the *application's own document* fetches rather than the plugin's page:
    /// a theme's `@font-face` is a font, and a browser fetches a font in CORS mode. Every other plugin
    /// answer stays same-origin-only - a page's script, stylesheet or data being readable by another
    /// origin is exactly the reach this protocol avoids - so the header travels with this flag and
    /// not with the response builder (spec §14.5-2).
    pub(crate) theme_asset: bool,
}

impl Answer {
    fn text(status: StatusCode, body: &str) -> Self {
        Self {
            status,
            content_type: "text/plain; charset=utf-8",
            body: body.as_bytes().to_vec(),
            refusal: None,
            theme_asset: false,
        }
    }

    /// A JSON body, which is what every bridge answer carries (see `services::plugins::bridge`).
    fn json(status: StatusCode, body: serde_json::Value) -> Self {
        Self {
            status,
            content_type: "application/json; charset=utf-8",
            body: body.to_string().into_bytes(),
            refusal: None,
            theme_asset: false,
        }
    }

    fn refused(refusal: AssetRefusal) -> Self {
        let mut answer = Self::text(
            StatusCode::from_u16(refusal.status()).unwrap_or(StatusCode::FORBIDDEN),
            "",
        );
        answer.refusal = Some(refusal.code());
        answer
    }

    /// The response one answer becomes, with the headers every plugin answer carries.
    ///
    /// The builder cannot fail for the headers this module sets, but a construction failure is
    /// answered as an explicit `500` rather than a default `200`: a response that failed to build is
    /// not a success, and the fallback must not be the one status that reads as one.
    pub(crate) fn into_response(self) -> Response<Vec<u8>> {
        let builder = Response::builder()
            .status(self.status)
            .header(header::CONTENT_TYPE, self.content_type)
            .header("X-Content-Type-Options", "nosniff")
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::CONTENT_SECURITY_POLICY, content_security_policy());
        // One declared theme asset, one header: the application's document draws it (a background
        // image, a font) and a font is fetched in CORS mode. `renderer.rs` answers its module the
        // same way, for the same reason - the document, not the plugin's page, is the reader.
        let builder = if self.theme_asset {
            builder
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .header("Cross-Origin-Resource-Policy", "cross-origin")
        } else {
            builder
        };
        builder
            .body(self.body)
            .unwrap_or_else(|_| internal_error_response())
    }
}

/// The response a failed build falls back to: an explicit `500`, never the default `200`.
fn internal_error_response() -> Response<Vec<u8>> {
    let mut response = Response::new(Vec::new());
    *response.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
    response
}

/// The answer to one already-resolved request, as a decision over the resolver's answers.
///
/// Split from the incoming request so the dispatch can be tested without a webview: the answer
/// depends on which installation the origin belongs to, what the path names, and - for a bridge call -
/// on the judgement `services::plugins::bridge` reaches. That judgement is why the one thing this
/// function cannot decide alone arrives as [`BridgeEffects`]: the session's grants, the window the
/// caller is, and the question only the user can answer.
pub(crate) fn answer(
    page: Option<&PluginPage>,
    roots: &crate::services::plugins::gates::FsRoots,
    path: &str,
    call: Option<BridgeCall>,
    effects: &mut dyn BridgeEffects,
) -> Answer {
    let Some(page) = page else {
        return Answer::refused(AssetRefusal::UnknownOrigin);
    };
    if !page.enabled {
        return Answer::refused(AssetRefusal::Disabled);
    }
    if path == pages::BRIDGE_PATH {
        // A bridge request that names no method this build serves never was one: the answer is the
        // same `403` an asset path this application never hands out gets, and for the same reason -
        // the reader is a plugin's own document, and the reason belongs in the log.
        let Some(call) = call else {
            return Answer::refused(AssetRefusal::UnknownBridgeMethod);
        };
        return match bridge::answer(page, roots, &call, effects) {
            Ok(body) => Answer::json(StatusCode::OK, body),
            Err(RefusalOrRequest::Refused(refusal)) => {
                // A served method that failed a gate is logged here rather than in the caller: it is
                // a `200` to the page and a fact to the log, and the page's own document is not the
                // reader who can act on it.
                log::info(&format!(
                    "a plugin bridge call was refused: plugin={} code={}",
                    page.plugin_id, refusal.code
                ));
                Answer::json(StatusCode::OK, refusal.body())
            }
            Err(RefusalOrRequest::Request) => Answer::refused(AssetRefusal::UnknownBridgeMethod),
        };
    }
    match pages::resolve_asset(page, path) {
        Ok(resolved) => match pages::read_asset(&resolved) {
            Ok(body) => Answer {
                status: StatusCode::OK,
                content_type: content_type(path),
                body,
                refusal: None,
                theme_asset: page.theme_assets.iter().any(|asset| asset == path),
            },
            Err(refusal) => Answer::refused(refusal),
        },
        Err(refusal) => Answer::refused(refusal),
    }
}

/// The live half of a bridge call: the session's own facts, the window the caller is, and the one
/// question only a person can answer.
pub(crate) struct LiveEffects<'a> {
    app: &'a tauri::AppHandle,
    state: &'a AppState,
    /// The installation the request's origin belongs to, when it belongs to one.
    page: Option<&'a PluginPage>,
    key: &'a str,
    caller: &'a str,
}

impl<'a> LiveEffects<'a> {
    /// The same effects for a call that came from an installation's *process* rather than a page
    /// (`services::plugins::process::api`).
    ///
    /// A worker has no webview of its own, so the caller is the application's own document: that is
    /// the window a question is drawn in. Everything else - the grants, the delete brake, the
    /// notices - is the installation's, exactly as it is for a page.
    pub(crate) fn for_process(
        app: &'a tauri::AppHandle,
        state: &'a AppState,
        page: &'a PluginPage,
        key: &'a str,
        caller: &'a str,
    ) -> Self {
        Self {
            app,
            state,
            page: Some(page),
            key,
            caller,
        }
    }
}

impl BridgeEffects for LiveEffects<'_> {
    fn holds(&self, grant: &SessionGrant) -> bool {
        self.state.session_grants.holds(self.key, grant)
    }

    fn remember(&mut self, grant: SessionGrant) {
        self.state.session_grants.remember(self.key, grant);
    }

    fn ask(&mut self, kind: PromptKind, target: &str) -> Option<PromptAnswer> {
        let page = self.page?;
        ask_user(self.app, self.state, page, kind, target)
    }

    fn close_caller(&mut self) -> bool {
        self.state
            .panels
            .close_window(self.app, self.caller, self.key)
    }

    fn notify(&mut self, title: &str, body: &str) {
        let Some(page) = self.page else {
            return;
        };
        notice(self.app, page, title, body);
    }

    fn take_delete(&mut self) -> bool {
        self.state.delete_budget.take(self.key)
    }

    /// One line into this application's log, in the plugin's own words.
    ///
    /// The installation is named in the line - a log the user reads has to say who wrote it - and
    /// control characters are replaced rather than escaped, so one call is one line: a plugin cannot
    /// forge another plugin's line, or a line of this application's own, by writing a newline.
    fn log_line(&mut self, level: &'static str, message: &str) {
        let Some(page) = self.page else {
            return;
        };
        let line = format!(
            "plugin[{}] {level}: {}",
            page.plugin_id,
            strip_control_characters(message)
        );
        match level {
            "warn" => crate::services::log::warn(&line),
            "error" => crate::services::log::error(&line),
            // `debug` is kept as a word in the line: this application's log has three levels, and a
            // line an author marked as debug is still worth reading when something is wrong.
            _ => crate::services::log::info(&line),
        }
    }

    /// One P1 read, completed or socket operation: the host frames and the budgets live in
    /// `services::plugins::capabilities_io`, which is the one implementation of what these four
    /// methods do (`omp.desktop` API 0.2.0).
    fn plugin_data(
        &mut self,
        request: &crate::services::plugins::bridge::DataRequest,
    ) -> Result<serde_json::Value, Refusal> {
        crate::services::plugins::capabilities_io::plugin_data(
            self.state, self.page, self.key, request,
        )
    }

    fn bus_publish(
        &mut self,
        topic: &str,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, Refusal> {
        crate::services::plugins::capabilities_io::bus_publish(
            self.state, self.page, self.key, topic, payload,
        )
    }

    fn bus_subscribe(&mut self, topics: &[String]) -> Result<serde_json::Value, Refusal> {
        crate::services::plugins::capabilities_io::bus_subscribe(
            self.state, self.page, self.key, topics,
        )
    }

    fn open_external_url(&mut self, url: &str) -> Result<(), Refusal> {
        crate::services::plugins::capabilities_io::open_external(url)
    }

    /// Creates the installation's own directory and answers with it.
    ///
    /// Created on the way in rather than at start-up: a plugin that never asks for one never gets
    /// one, and a plugin that does cannot be handed a path it has to create itself before it can use
    /// it. A failure to create it is `internal` - the plugin asked where to put its files and there
    /// is no answer - rather than a path that does not exist.
    fn data_dir(&mut self) -> Result<String, Refusal> {
        let Some(page) = self.page else {
            return Err(bridge::INTERNAL);
        };
        let paths =
            crate::services::paths::DataPaths::resolve(self.app).map_err(|_| bridge::INTERNAL)?;
        let directory = paths.plugin_data_dir(&page.plugin_id, &page.scope);
        std::fs::create_dir_all(&directory).map_err(|_| bridge::INTERNAL)?;
        Ok(directory.to_string_lossy().into_owned())
    }

    /// One already-resolved path for the system's own default program, and one for this machine's
    /// file manager: the two launchers this application already owns (`services::system_open`,
    /// `services::open_in_app`), never a process spawned here.
    fn open_default(&mut self, path: &str) -> Result<(), Refusal> {
        crate::services::plugins::capabilities_io::open_default(path)
    }

    fn reveal(&mut self, path: &str) -> Result<(), Refusal> {
        crate::services::plugins::capabilities_io::reveal(path)
    }

    /// One browser verb on the page this installation owns.
    ///
    /// The key is this call's own - the origin key for a page, the installation's key for a worker -
    /// so the browser a plugin drives is its own and never the reader's tab.
    fn browser(
        &mut self,
        request: &crate::services::plugins::bridge::BrowserRequest,
    ) -> Result<serde_json::Value, Refusal> {
        crate::services::plugins::capabilities_io::browser(self.state, self.key, request)
    }
}

/// One line's text with everything that would make it more than one line replaced by a space.
///
/// It is a replacement rather than an escape on purpose: the reader of this file is a person looking
/// for what a plugin did, and `\n` in the middle of a line is noise - while a newline that survives
/// is a line this application did not write.
fn strip_control_characters(text: &str) -> String {
    text.chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect()
}

/// Shows one notice: in this application always, and through the system's own notifications when the
/// main window is not what the user is looking at.
///
/// The two are one call because they are one intent - a plugin wants to say something - and the split
/// is about *where the user is*: a line in a corner is enough while they are in this application, and
/// is invisible when they are not, which is the case the system's own notification exists for. A
/// notification the system refuses (permission, focus assist, a platform without a backend) is logged
/// and dropped: the in-app line has already been drawn, and the plugin's call is not about delivery.
fn notice(app: &tauri::AppHandle, page: &PluginPage, title: &str, body: &str) {
    let payload = NoticePayload {
        plugin_id: page.plugin_id.clone(),
        plugin_name: page.name.clone(),
        title: title.to_owned(),
        body: body.to_owned(),
    };
    if let Err(error) = app.emit_to("main", NOTICE_EVENT, payload) {
        log::info(&format!(
            "a plugin notice could not be delivered to this application: plugin={} error={error}",
            page.plugin_id
        ));
    }
    let focused = crate::services::presence::main_window(app)
        .and_then(|window| window.is_focused().ok())
        .unwrap_or(false);
    if focused {
        return;
    }
    use tauri_plugin_notification::NotificationExt;
    let shown = app.notification().builder().title(title).body(body).show();
    if let Err(error) = shown {
        log::info(&format!(
            "a plugin notice was not shown by the system: plugin={} error={error}",
            page.plugin_id
        ));
    }
}

/// Puts one question to the user and waits for the answer, or for the wait to end the question.
///
/// The answer arrives through `commands::plugin_pages::plugin_prompt_answer`, which resolves the
/// registry entry this call parked; everything that is not an answer - a full table, no window to
/// ask, the timeout - reads as *no answer*, which the caller turns into a denial (spec §6.1-1: a
/// host that cannot ask does not allow). The main window is focused first, because the card is drawn
/// there and a plugin window may well be the one on top.
fn ask_user(
    app: &tauri::AppHandle,
    state: &AppState,
    page: &PluginPage,
    kind: PromptKind,
    target: &str,
) -> Option<PromptAnswer> {
    let (id, receiver) = state
        .prompts
        .open(&pages::origin_key(&page.plugin_id, &page.scope))?;
    let request = PromptRequest {
        id,
        plugin_id: page.plugin_id.clone(),
        plugin_name: page.name.clone(),
        scope: page.scope.clone(),
        kind: kind.as_str(),
        target: target.to_owned(),
    };
    // The card is drawn in the main window. A window that is not there at all - the user closed it
    // and the residency setting let it close, while a plugin panel is still open - has nobody to ask,
    // and the call is denied here rather than after a minute of waiting (spec §6.1-1: a host that
    // cannot ask does not allow). `emit_to` answers `Ok` for a label no window carries, so the window
    // itself is what gets checked.
    if crate::services::presence::main_window(app).is_none() {
        state.prompts.drop_question(id);
        log::info(&format!(
            "a plugin question has no window to be shown in: plugin={}",
            page.plugin_id
        ));
        return None;
    }
    // A window that *is* there may be minimized or hidden behind the tray (close-to-tray residency,
    // `services::presence`): focusing alone would leave a question nobody can see. Bringing it up is
    // what the application's own "show the window" path does, so it is reused rather than restated.
    crate::services::presence::show_main_window(app);
    if let Err(error) = app.emit_to("main", PROMPT_EVENT, request) {
        // A question nobody can be shown is not an answer, and leaving the entry behind would keep
        // one of the bounded slots occupied until the process ended.
        state.prompts.drop_question(id);
        log::info(&format!(
            "a plugin question could not be delivered: plugin={} error={error}",
            page.plugin_id
        ));
        return None;
    }
    match receiver.recv_timeout(PROMPT_TIMEOUT) {
        Ok(answer) => {
            if answer == PromptAnswer::Deny {
                audit::permission_denied(&page.plugin_id, Some(&page.scope));
            } else {
                audit::permission_granted(&page.plugin_id, Some(&page.scope));
            }
            Some(answer)
        }
        Err(_) => {
            state.prompts.drop_question(id);
            audit::permission_denied(&page.plugin_id, Some(&page.scope));
            log::info(&format!(
                "a plugin question went unanswered: plugin={} kind={}",
                page.plugin_id,
                kind.as_str()
            ));
            None
        }
    }
}

/// How much of a refused request path the log line keeps.
const LOG_PATH_MAX: usize = 256;

/// One request path as a log line: control characters become spaces and the text is clipped.
///
/// The path is attacker-controlled - a plugin page chooses the URL it fetches, and the resolver has
/// already percent-decoded it - so a `%0a` in the URI would otherwise put a second line in the log
/// and let a page forge entries. The path is still logged, rather than dropped, because it is what
/// says which request was refused.
fn log_safe_path(path: &str) -> String {
    let one_line: String = path
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect();
    one_line.chars().take(LOG_PATH_MAX).collect()
}

/// One incoming request, answered.
///
/// The runtime hands this the request as wry read it, which is always the `omp-plugin://<key>/<path>`
/// form: on Windows the scheme is rewritten on the way in and back on the way out, so this side does
/// not have to know which platform it is running on (see [`pages::origin`]).
pub(crate) fn handle(
    app: &tauri::AppHandle,
    webview_label: &str,
    request: &HttpRequest<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    // The runtime hands the request over in the scheme's own form on every platform: wry rewrites a
    // custom scheme into the `http(s)` form WebView2 needs on the way in, and back on the way out
    // (`wry`'s workaround), so parsing it as a URL gives the same `omp-plugin://<key>/<path>` shape
    // here as it does on macOS and Linux.
    let Ok(uri) = tauri::Url::parse(&request.uri().to_string()) else {
        responder.respond(Answer::refused(AssetRefusal::UnknownOrigin).into_response());
        return;
    };
    let Some(parsed) = pages::parse_request(&uri) else {
        responder.respond(Answer::refused(AssetRefusal::UnknownOrigin).into_response());
        return;
    };
    let page = app
        .try_state::<AppState>()
        .and_then(|state| state.pages.get(&parsed.key));
    let app = app.clone();
    let caller = webview_label.to_owned();
    let key = parsed.key;
    let path = parsed.path;
    let call = bridge_call(
        request.method().as_str(),
        uri.query().map(str::to_owned),
        request.body(),
    );

    // The answer is a filesystem read - and, for a bridge call, whatever the judgement behind it
    // performs - so it is produced off the webview's thread and handed back through the responder
    // the runtime gave this call.
    tauri::async_runtime::spawn_blocking(move || {
        let answer = match app.try_state::<AppState>() {
            Some(state) => {
                let mut effects = LiveEffects {
                    app: &app,
                    state: &state,
                    page: page.as_deref(),
                    key: &key,
                    caller: &caller,
                };
                // The roots this call's file gates resolve against (spec §6.3): the workspace the
                // page belongs to, and the installation's own package.
                let roots = match page.as_deref() {
                    Some(page) => state.plugin_roots(&caller, page),
                    None => crate::services::plugins::gates::FsRoots {
                        workspace: None,
                        plugin: std::path::PathBuf::new(),
                    },
                };
                answer(page.as_deref(), &roots, &path, call, &mut effects)
            }
            // The state is gone, which only happens while the application is shutting down.
            None => Answer::text(StatusCode::SERVICE_UNAVAILABLE, ""),
        };
        if answer.status != StatusCode::OK {
            // The reason and the root are logged because the status alone is ambiguous: `404` is
            // both "no installation is served under that origin" and "the file is not there", and
            // the two have nothing to do with each other (`pages::AssetRefusal::code`).
            log::info(&format!(
                "a plugin page request was refused: path={} status={} reason={} plugin={} root={}",
                log_safe_path(&path),
                answer.status.as_u16(),
                answer.refusal.unwrap_or("unknown"),
                page.as_ref()
                    .map(|page| page.plugin_id.as_str())
                    .unwrap_or("-"),
                page.as_ref()
                    .map(|page| log_safe_path(&page.root.display().to_string()))
                    .unwrap_or_else(|| "-".to_owned()),
            ));
        }
        responder.respond(answer.into_response());
    });
}

/// The bridge call one request carries, or `None` when it carries none.
///
/// The two shapes the endpoint has are a `GET` with the method in its query (everything without
/// parameters) and a `POST` with the method in a JSON body (everything with them). Anything else -
/// another verb, a `POST` with an empty body, a `GET` naming a method that needs parameters - is
/// answered like a method this build does not serve, because there is no reading of the request that
/// names one.
fn bridge_call(method: &str, query: Option<String>, body: &[u8]) -> Option<BridgeCall> {
    match method {
        "GET" => Some(BridgeCall::Query(query.unwrap_or_default())),
        "POST" => Some(BridgeCall::Body(body.to_vec())),
        _ => None,
    }
}

#[cfg(test)]
mod tests;
