//! One browser page: a native guest webview, its document state, and the rules that keep it alive
//! while nobody is looking at it.
//!
//! The shell here is a React panel around a child webview, expressed with Tauri's multiwebview API
//! instead of Electron's `WebContentsView`:
//!
//! - **The page is a child webview of the main window.** The chrome around it is React
//!   (`components/workspace/BrowserPanel.tsx`), which measures the hole and tells this side where to
//!   put the guest. A child webview is the one surface here that can show arbitrary pages: an iframe
//!   is refused by sites that set `X-Frame-Options`, and the application's own CSP forbids framing.
//! - **A hidden page is parked, not destroyed.** It is reparented into a hidden backing window —
//!   the same idea as parking a `WebContentsView` in a hidden `BrowserWindow` — so Chromium
//!   keeps running and the agent can drive a page in a conversation the reader is not looking at.
//! - **The state is the document's own.** Navigation starts, commits, titles, history and failures
//!   are read from WebView2's events on Windows; the page publishes one `browser-state` event per
//!   change, and the chrome never polls.
//! - **Closing is the only reclamation.** A tab closed by the reader, a conversation closed by the
//!   shell, or the application exiting destroys the guest; nothing keeps an unused page warm on a
//!   timer. That rule is why this module has no sweep.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use tauri::webview::{NewWindowResponse, PermissionResponse, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Position, Rect, Size, Url,
    Webview, WebviewUrl, Window,
};
use tokio::sync::oneshot;

use super::cdp::CdpSession;
use super::live_reload::LiveReload;
use super::policy::{allowed_file_url, target_for, target_url, Target, TargetError, START_URL};
use super::state::{BrowserState, Document, NavigationOutcome, PendingNavigation};

mod document;
mod navigation;

/// The event the chrome and the work panel listen on: one page's whole visible state.
pub(crate) const STATE_EVENT: &str = "browser-state";

/// The event a guest's `window.open` asks the shell to answer: open this address in a new tab.
pub(crate) const OPEN_EVENT: &str = "browser-open";

/// How long one managed navigation waits for a commit before reporting a timeout.
const NAVIGATION_TIMEOUT: Duration = Duration::from_secs(30);

/// The console capture installed before any page script runs.
///
/// The DevTools protocol's event stream is the usual way to read console output. Tauri's
/// WebView2 integration exposes the protocol calls but not its event receivers on this side, so the
/// same information is collected where it is produced: `console.*` is wrapped once per document and
/// the last hundred lines are kept in the page. `Browser`'s `console` action reads that buffer.
const CONSOLE_CAPTURE: &str = r#"
(() => {
  if (window.__ompBrowserConsole) return;
  // A guest's `window.close()` would ask the platform to destroy its own container; a browser tab
  // is closed by its tab strip, not by the page.
  try { window.close = () => {}; } catch {}
  const buffer = [];
  const stringify = (value) => {
    if (typeof value === 'string') return value;
    try {
      if (value instanceof Error) return value.stack || value.message || String(value);
      const json = JSON.stringify(value);
      return json === undefined ? String(value) : json;
    } catch {
      return String(value);
    }
  };
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level];
    console[level] = function (...args) {
      try {
        buffer.push({ type: level, text: args.map(stringify).join(' '), timestamp: Date.now() });
        if (buffer.length > 100) buffer.shift();
      } catch {}
      return original.apply(console, args);
    };
  }
  Object.defineProperty(window, '__ompBrowserConsole', { value: buffer });
})();
"#;

/// One page: one conversation's tab, and the guest webview behind it.
///
/// Owner/bound/release: the page is owned by the conversation and tab that name it (a plugin's own
/// page is owned by the installation instead), its guest is one webview, and `close` is the only
/// release. The page itself may exist before its guest (the chrome shows an empty tab, and the first
/// navigation creates the webview).
pub(crate) struct Page {
    pub(crate) owner: String,
    pub(crate) tab_id: String,
    /// A plugin's own page (`pi.browser.navigate`): nothing about it reaches the shell (`publish`,
    /// `on_new_window`, `BrowserService::plugin_reveal`).
    headless: bool,
    roots: Mutex<Vec<PathBuf>>,
    document: Mutex<Document>,
    webview: Mutex<Option<Webview>>,
    cdp: Arc<CdpSession>,
    visible: AtomicBool,
    active: AtomicBool,
    /// Whether a bounds report for *this* activation has arrived. A page woken by a tab switch
    /// must not be shown at the rectangle it had before the column moved.
    bounds_ready: AtomicBool,
    parked: AtomicBool,
    closed: AtomicBool,
    bounds: Mutex<Option<Rect>>,
    /// The newest bounds report applied for this page.
    bounds_order: Mutex<u64>,
    /// The newest visibility report applied for this page.
    visibility_order: Mutex<u64>,
    watcher: Mutex<Option<LiveReload>>,
    pending: Mutex<Option<PendingNavigation>>,
    /// Serializes guest creation for this page: two navigations that arrive together must not both
    /// build a webview under two labels.
    creation: Mutex<()>,
    app: AppHandle,
    main: Window,
    backing: Option<Window>,
    profile: PathBuf,
    label: String,
}

impl Page {
    pub(crate) fn new(
        app: AppHandle,
        main: Window,
        backing: Option<Window>,
        profile: PathBuf,
        owner: String,
        tab_id: String,
        roots: Vec<PathBuf>,
        label: String,
        headless: bool,
    ) -> Self {
        Self {
            owner,
            tab_id,
            headless,
            roots: Mutex::new(roots),
            document: Mutex::new(Document::default()),
            webview: Mutex::new(None),
            cdp: Arc::new(CdpSession::new()),
            visible: AtomicBool::new(false),
            active: AtomicBool::new(false),
            bounds_ready: AtomicBool::new(false),
            parked: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            bounds: Mutex::new(None),
            bounds_order: Mutex::new(0),
            visibility_order: Mutex::new(0),
            watcher: Mutex::new(None),
            pending: Mutex::new(None),
            creation: Mutex::new(()),
            app,
            main,
            backing,
            profile,
            label,
        }
    }

    pub(crate) fn key(&self) -> String {
        format!("{}\u{0}{}", self.owner, self.tab_id)
    }

    pub(crate) fn webview(&self) -> Option<Webview> {
        self.webview
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub(crate) fn cdp(&self) -> &CdpSession {
        self.cdp.as_ref()
    }

    pub(crate) fn publish(&self) {
        if self.headless {
            return;
        }
        let _ = self.app.emit_to(
            EventTarget::webview(super::MAIN_WINDOW),
            STATE_EVENT,
            self.state(),
        );
    }

    pub(crate) fn set_roots(&self, roots: Vec<PathBuf>) {
        if let Ok(mut held) = self.roots.lock() {
            *held = roots;
        }
    }

    fn roots(&self) -> Vec<PathBuf> {
        self.roots
            .lock()
            .map(|held| held.clone())
            .unwrap_or_default()
    }

    /// The guest webview, created on the first navigation and reused for the page's whole life.
    fn ensure_webview(self: &Arc<Self>) -> Result<(), String> {
        let _gate = self
            .creation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        {
            let mut held = self
                .webview
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(webview) = held.as_ref() {
                // A closed webview answers `url()` with an error; the slot is then stale.
                if webview.url().is_ok() {
                    return Ok(());
                }
                *held = None;
            }
        }
        let weak = Arc::downgrade(self);
        let start = Url::parse(START_URL).map_err(|error| error.to_string())?;
        let navigation = {
            let weak = weak.clone();
            move |url: &Url| {
                weak.upgrade()
                    .map(|page| page.allow_navigation(url))
                    .unwrap_or(false)
            }
        };
        let new_window = {
            let weak = weak.clone();
            move |url: Url, _features| {
                if let Some(page) = weak.upgrade() {
                    page.on_new_window(url);
                }
                NewWindowResponse::Deny
            }
        };
        let title = {
            let weak = weak.clone();
            move |_webview: Webview, title: String| {
                if let Some(page) = weak.upgrade() {
                    page.set_title(title);
                }
            }
        };
        let page_load = {
            let weak = weak.clone();
            move |_webview: Webview, payload: tauri::webview::PageLoadPayload<'_>| {
                if let Some(page) = weak.upgrade() {
                    page.on_page_load(payload.event(), payload.url());
                }
            }
        };
        let builder = WebviewBuilder::new(self.label.clone(), WebviewUrl::External(start))
            .data_directory(self.profile.clone())
            .devtools(false)
            .focused(false)
            .initialization_script(CONSOLE_CAPTURE)
            .on_navigation(navigation)
            .on_new_window(new_window)
            .on_document_title_changed(title)
            .on_page_load(page_load)
            .on_permission_request(|_webview, _kind| PermissionResponse::Deny);
        let webview = self
            .main
            .add_child(
                builder,
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(1.0, 1.0),
            )
            .map_err(|error| error.to_string())?;
        if self.closed.load(Ordering::SeqCst) {
            let _ = webview.close();
            return Err("browser guest was closed".to_owned());
        }
        let _ = webview.hide();
        crate::services::webview_keys::release_find_keys_on(&webview, "the browser guest");
        self.install_document_events(&webview);
        let mut held = self
            .webview
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *held = Some(webview);
        drop(held);
        self.apply();
        Ok(())
    }

    /// The guest's own document events, where the platform exposes them.
    ///
    /// Windows (WebView2) is the platform this build's agent lane targets; the other platforms keep
    /// the chrome working through Tauri's `on_page_load` and simply answer the CDP actions as
    /// unsupported.
    #[cfg(windows)]
    fn install_document_events(self: &Arc<Self>, webview: &Webview) {
        use webview2_com::{
            HistoryChangedEventHandler, NavigationCompletedEventHandler,
            NavigationStartingEventHandler, SourceChangedEventHandler,
        };
        use windows::core::{BOOL, PWSTR};

        fn text(value: PWSTR) -> String {
            if value.is_null() {
                return String::new();
            }
            unsafe { value.to_string().unwrap_or_default() }
        }

        let weak = Arc::downgrade(self);
        let installed = webview.with_webview(move |platform| {
            let controller = platform.controller();
            // The top-level backing window is hidden; keep the controller itself visible so the
            // guest keeps laying out, painting and exposing an accessibility tree.
            let _ = unsafe { controller.SetIsVisible(true) };
            let Ok(core) = (unsafe { controller.CoreWebView2() }) else {
                return;
            };
            let mut token = 0i64;
            let starting = {
                let weak = weak.clone();
                NavigationStartingEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut uri = PWSTR::null();
                    unsafe { args.Uri(&mut uri)? };
                    let mut navigation_id = 0u64;
                    let _ = unsafe { args.NavigationId(&mut navigation_id) };
                    if let Some(page) = weak.upgrade() {
                        page.on_navigation_started(text(uri), navigation_id);
                    }
                    Ok(())
                }))
            };
            let completed = {
                let weak = weak.clone();
                NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut success = BOOL(0);
                    unsafe { args.IsSuccess(&mut success)? };
                    let mut status = webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN;
                    let _ = unsafe { args.WebErrorStatus(&mut status) };
                    let mut navigation_id = 0u64;
                    let _ = unsafe { args.NavigationId(&mut navigation_id) };
                    let mut url = PWSTR::null();
                    if let Some(sender) = sender.as_ref() {
                        let _ = unsafe { sender.Source(&mut url) };
                    }
                    let mut back = BOOL(0);
                    let mut forward = BOOL(0);
                    if let Some(sender) = sender.as_ref() {
                        let _ = unsafe { sender.CanGoBack(&mut back) };
                        let _ = unsafe { sender.CanGoForward(&mut forward) };
                    }
                    if let Some(page) = weak.upgrade() {
                        let address = text(url);
                        page.on_navigation_completed(
                            success.as_bool(),
                            super::platform::web_error_label(status.0),
                            address.clone(),
                            back.as_bool(),
                            forward.as_bool(),
                            navigation_id,
                        );
                        // A local page may follow a link to another file; the live-reload watcher
                        // follows the document's own directory, not the one the tab opened with.
                        if success.as_bool() {
                            if let Ok(parsed) = Url::parse(&address) {
                                if parsed.scheme() == "file" {
                                    if let Ok(path) = parsed.to_file_path() {
                                        page.watch_file(&path, weak.clone());
                                    }
                                } else {
                                    page.clear_watcher();
                                }
                            }
                        }
                    }
                    Ok(())
                }))
            };
            let source = {
                let weak = weak.clone();
                SourceChangedEventHandler::create(Box::new(move |sender, _| {
                    let Some(sender) = sender else { return Ok(()) };
                    let mut url = PWSTR::null();
                    let _ = unsafe { sender.Source(&mut url) };
                    if let Some(page) = weak.upgrade() {
                        page.on_source_changed(text(url));
                    }
                    Ok(())
                }))
            };
            let history = {
                let weak = weak.clone();
                HistoryChangedEventHandler::create(Box::new(move |sender, _| {
                    let Some(sender) = sender else { return Ok(()) };
                    let mut back = BOOL(0);
                    let mut forward = BOOL(0);
                    let _ = unsafe { sender.CanGoBack(&mut back) };
                    let _ = unsafe { sender.CanGoForward(&mut forward) };
                    if let Some(page) = weak.upgrade() {
                        page.set_history(back.as_bool(), forward.as_bool());
                    }
                    Ok(())
                }))
            };
            unsafe {
                let _ = core.add_NavigationStarting(&starting, &mut token);
                let _ = core.add_NavigationCompleted(&completed, &mut token);
                let _ = core.add_SourceChanged(&source, &mut token);
                let _ = core.add_HistoryChanged(&history, &mut token);
            }
        });
        if let Err(error) = installed {
            crate::services::log::warn(&format!(
                "browser page events could not be installed; the chrome will not follow this page: {error}"
            ));
        }
    }

    #[cfg(not(windows))]
    fn install_document_events(self: &Arc<Self>, _webview: &Webview) {}

    fn allow_navigation(&self, url: &Url) -> bool {
        let raw = url.as_str();
        if raw == START_URL {
            return true;
        }
        if matches!(url.scheme(), "http" | "https") {
            return true;
        }
        if url.scheme() == "file" {
            let current_is_file = self
                .document
                .lock()
                .map(|document| document.url.starts_with("file:"))
                .unwrap_or(false);
            return allowed_file_url(raw, &self.roots(), current_is_file);
        }
        false
    }

    fn on_new_window(&self, url: Url) {
        if !matches!(url.scheme(), "http" | "https") || url.as_str().chars().count() > 8_192 {
            return;
        }
        // A plugin's own page asks the shell for no tab: `browser.navigate` moves it itself.
        if self.headless {
            return;
        }
        let _ = self.app.emit_to(
            EventTarget::webview(super::MAIN_WINDOW),
            OPEN_EVENT,
            serde_json::json!({ "sessionId": self.owner, "url": url.as_str() }),
        );
    }

    /// One managed navigation: resolve the input, create the guest if needed, and wait for the
    /// document to commit (or fail) within [`NAVIGATION_TIMEOUT`].
    pub(crate) async fn navigate(
        self: &Arc<Self>,
        raw: &str,
        preview: bool,
        roots: Vec<PathBuf>,
    ) -> Option<BrowserState> {
        if self.closed.load(Ordering::SeqCst) {
            return None;
        }
        self.set_roots(roots);
        let roots = self.roots();
        let target = match target_for(raw, &roots, preview) {
            Ok(target) => target,
            Err(error) => {
                self.fail_before_load(raw, error);
                return None;
            }
        };
        let Some(url) = target_url(&target) else {
            self.fail_before_load(raw, TargetError::InvalidUrl);
            return None;
        };
        let address = url.as_str().to_owned();
        let epoch = self.begin_navigation(&address);
        if let Err(error) = self.ensure_webview() {
            self.fail_navigation(&address, error);
            return None;
        }
        match &target {
            Target::File(path) => self.watch_file(path, Arc::downgrade(self)),
            Target::Web(_) => self.clear_watcher(),
        }
        let (tx, rx) = oneshot::channel();
        if let Ok(mut held) = self.pending.lock() {
            *held = Some(PendingNavigation {
                epoch,
                target: address.clone(),
                redirects: Vec::new(),
                tx,
            });
        }
        let webview = {
            let held = self
                .webview
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            held.clone()
        };
        let Some(webview) = webview else {
            self.fail_navigation(&address, "browser guest is not available".to_owned());
            return None;
        };
        if let Err(error) = webview.navigate(url) {
            self.fail_navigation(&address, error.to_string());
            return None;
        }
        match tokio::time::timeout(NAVIGATION_TIMEOUT, rx).await {
            Ok(Ok(outcome)) => {
                if !outcome.success {
                    return None;
                }
                Some(self.state())
            }
            Ok(Err(_)) => None,
            Err(_) => {
                // The wait ended without a commit. The document answers whether this epoch is still
                // its own - a later navigation has replaced it - and drops the wait if it is.
                if self.timed_out(epoch) {
                    self.publish();
                    self.apply();
                }
                None
            }
        }
    }

    pub(crate) fn action(&self, action: &str) {
        let webview = {
            let held = self
                .webview
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            held.clone()
        };
        let Some(webview) = webview else {
            return;
        };
        let pending_stop = action == "stop"
            && self
                .document
                .lock()
                .map(|document| document.pending_target.is_some())
                .unwrap_or(false);
        if pending_stop {
            let epoch = {
                let mut document = self
                    .document
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                document.loading = false;
                document.started = false;
                document.load_error = Some("ERR_ABORTED".to_owned());
                document.pending_target = None;
                document.epoch
            };
            self.publish();
            self.apply();
            self.resolve_pending(epoch, NavigationOutcome { success: false });
        }
        #[cfg(windows)]
        {
            let action = action.to_owned();
            let _ = webview.with_webview(move |platform| {
                let Ok(core) = (unsafe { platform.controller().CoreWebView2() }) else {
                    return;
                };
                unsafe {
                    match action.as_str() {
                        "back" => {
                            let _ = core.GoBack();
                        }
                        "forward" => {
                            let _ = core.GoForward();
                        }
                        "reload" => {
                            let _ = core.Reload();
                        }
                        "stop" => {
                            let _ = core.Stop();
                        }
                        _ => {}
                    }
                }
            });
        }
        #[cfg(not(windows))]
        {
            match action {
                "back" => {
                    let _ = webview.eval("history.back()");
                }
                "forward" => {
                    let _ = webview.eval("history.forward()");
                }
                "reload" => {
                    let _ = webview.reload();
                }
                "stop" => {
                    let _ = webview.eval("window.stop()");
                }
                _ => {}
            }
        }
    }

    pub(crate) fn open_external(&self) {
        let url = self.state().url;
        if url.is_empty() {
            return;
        }
        if let Ok(parsed) = Url::parse(&url) {
            if matches!(parsed.scheme(), "http" | "https") {
                let _ = crate::services::system_open::open_web_address(&url);
                return;
            }
            if parsed.scheme() == "file" {
                if let Ok(path) = parsed.to_file_path() {
                    let _ = crate::services::system_open::open_path(&path);
                }
            }
        }
    }

    pub(crate) fn set_bounds(&self, rect: Rect, seq: Option<u64>) {
        if let Some(seq) = seq {
            let mut held = self
                .bounds_order
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if seq <= *held {
                return;
            }
            *held = seq;
        }
        if let Ok(mut held) = self.bounds.lock() {
            *held = Some(rect);
        }
        self.bounds_ready.store(true, Ordering::SeqCst);
    }

    /// A page the chrome has just started showing has no trustworthy rectangle yet.
    pub(crate) fn mark_bounds_stale(&self) {
        self.bounds_ready.store(false, Ordering::SeqCst);
    }

    pub(crate) fn set_visible(&self, visible: bool, seq: Option<u64>) {
        if let Some(seq) = seq {
            let mut held = self
                .visibility_order
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if seq <= *held {
                return;
            }
            *held = seq;
        }
        self.visible.store(visible, Ordering::SeqCst);
    }

    /// Whether the chrome is showing this page. The registry is the only caller.
    pub(crate) fn set_active(&self, active: bool) {
        self.active.store(active, Ordering::SeqCst);
    }

    /// Put a page the agent is about to read into the hidden backing window, where it keeps
    /// rendering. A page hidden in the main window has no accessible tree and no pixels to capture.
    pub(crate) fn prepare_capture(&self) {
        let webview = {
            let held = self
                .webview
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            held.clone()
        };
        if let Some(webview) = webview {
            if !self.visible.load(Ordering::SeqCst) || !self.active.load(Ordering::SeqCst) {
                self.park(&webview);
            } else if self.bounds_ready.load(Ordering::SeqCst) {
                // A page the reader is looking at is already where it belongs; a page that was left
                // parked by an earlier capture is put back. Before the chrome's first report there
                // is no trustworthy rectangle to put it at.
                self.apply();
            }
        }
    }

    /// Re-read the page's wish after the registry changed which page is on screen.
    pub(crate) fn apply_wish(&self) {
        self.apply();
    }

    /// Put the guest away without changing the page's visibility wish.
    ///
    /// The registry calls this for the pages that are not on screen; a wish the chrome already
    /// expressed must survive, or a `set_visible(true)` that raced the tab switch would be lost.
    pub(crate) fn hide_now(&self) {
        let webview = {
            let held = self
                .webview
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            held.clone()
        };
        if let Some(webview) = webview {
            self.park(&webview);
        }
    }

    fn apply(&self) {
        let visible = self.visible.load(Ordering::SeqCst)
            && self.active.load(Ordering::SeqCst)
            && self.bounds_ready.load(Ordering::SeqCst);
        let started = self
            .document
            .lock()
            .map(|document| document.started)
            .unwrap_or(false);
        let bounds = self.bounds.lock().ok().and_then(|held| *held);
        let webview = {
            let held = self
                .webview
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            held.clone()
        };
        let Some(webview) = webview else {
            return;
        };
        if visible && started {
            if let Some(bounds) = bounds {
                if self.parked.load(Ordering::SeqCst) {
                    if webview.reparent(&self.main).is_err() {
                        return;
                    }
                    self.parked.store(false, Ordering::SeqCst);
                }
                let _ = webview.set_bounds(bounds);
                let _ = webview.show();
            }
            return;
        }
        self.park(&webview);
    }

    fn park(&self, webview: &Webview) {
        if self.parked.load(Ordering::SeqCst) {
            return;
        }
        if let Some(backing) = &self.backing {
            if webview.reparent(backing).is_ok() {
                let _ = webview.set_bounds(Rect {
                    position: Position::Logical(LogicalPosition::new(0.0, 0.0)),
                    size: Size::Logical(LogicalSize::new(1024.0, 768.0)),
                });
                let _ = webview.show();
                self.parked.store(true, Ordering::SeqCst);
                return;
            }
        }
        let _ = webview.hide();
    }

    fn watch_file(&self, path: &Path, weak: Weak<Page>) {
        let Some(dir) = path.parent() else {
            return;
        };
        let reload = move || {
            if let Some(page) = weak.upgrade() {
                page.reload_ignoring_cache();
            }
        };
        let next = LiveReload::new(dir, reload);
        if let Ok(mut held) = self.watcher.lock() {
            *held = next;
        }
    }

    fn clear_watcher(&self) {
        if let Ok(mut held) = self.watcher.lock() {
            *held = None;
        }
    }

    fn reload_ignoring_cache(&self) {
        let webview = {
            let held = self
                .webview
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            held.clone()
        };
        if let Some(webview) = webview {
            if !self.cdp.reload_ignoring_cache(&webview) {
                let _ = webview.reload();
            }
        }
    }

    pub(crate) fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.visible.store(false, Ordering::SeqCst);
        self.clear_watcher();
        self.cdp.detach();
        let epoch = self
            .document
            .lock()
            .map(|document| document.epoch)
            .unwrap_or_default();
        self.resolve_pending(epoch, NavigationOutcome { success: false });
        if let Some(webview) = self
            .webview
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            let _ = webview.close();
        }
    }
}
