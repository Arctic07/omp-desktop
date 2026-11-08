//! The built-in browser: one guest page per conversation tab, and the lifecycle the reference
//! desktop gives it.
//!
//! **Ownership.** A page is keyed by `(conversation, tab)`. The conversation is the engine's session
//! id - the same id the work panel stores tabs under - and the tab is either `default` (the first
//! Browser tab a conversation opens) or `tab-<n>` (a preview, which always gets a tab of its own).
//! The reader's chrome names the page it is showing (`show_tab`); the agent names the conversation
//! that asked, and reaches the tab it last connected to. No path can reach another conversation's
//! page.
//!
//! **Lifecycle.** A page exists from its first open until its tab closes, its conversation closes,
//! or the application exits. Closing is the only reclamation: the guest webview is destroyed, the
//! DevTools session detached, the live-reload watcher dropped and the page forgotten. There is no
//! absence timer and no LRU - a page stays alive exactly as long as its tab.
//!
//! **Presentation.** The native guest always paints above the application's document, so the React
//! chrome measures the hole and tells this side where to put it (`set_bounds`), and says whether it
//! is on screen (`set_visible`). A hidden page is parked in a hidden backing window so it keeps
//! running for the agent; a visible page is moved back into the main window.
//!
//! The state machine lives in `page`; the address rules in `policy`; the agent's protocol channel in
//! `cdp`. This module is the registry and the verbs the commands and the host lane call.

mod cdp;
mod live_reload;
mod page;
mod platform;
mod policy;
mod state;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, Position, Rect, Size,
    Window,
};

use crate::errors::{IpcError, IpcResult, BROWSER_UNAVAILABLE, INVALID_INPUT};
use crate::services::paths::DataPaths;

use self::page::Page;
use self::platform::backing_window;
pub(crate) use self::state::BrowserState;

/// The event the shell answers by opening or focusing a browser tab.
pub(crate) const REVEAL_EVENT: &str = "browser-reveal";

/// The label the main window carries (`services::presence::MAIN_WINDOW`).
pub(super) const MAIN_WINDOW: &str = "main";

/// The first tab a conversation opens; every preview gets its own `tab-<n>`.
const DEFAULT_TAB: &str = "default";

/// One tab's page, as the commands answer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserOpened {
    pub(crate) tab_id: String,
    pub(crate) state: Option<BrowserState>,
}

/// The hole the React chrome measured, in logical pixels relative to the window's client area.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrowserRect {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

impl BrowserRect {
    /// This rect as webview bounds, clamped to the window so a measurement bug cannot put the
    /// guest over the conversation or the title bar.
    fn bounds(self, window: &Window) -> Option<Rect> {
        let values = [self.x, self.y, self.width, self.height];
        if values.iter().any(|value| !value.is_finite()) {
            return None;
        }
        let scale = window.scale_factor().unwrap_or(1.0);
        let size = window.inner_size().ok()?;
        let max_width = size.width as f64 / scale;
        let max_height = size.height as f64 / scale;
        let x = self.x.max(0.0).min(max_width);
        let y = self.y.max(0.0).min(max_height);
        let width = self.width.max(0.0).min(max_width - x);
        let height = self.height.max(0.0).min(max_height - y);
        if width < 1.0 || height < 1.0 {
            return None;
        }
        Some(Rect {
            position: Position::Logical(LogicalPosition::new(x.round(), y.round())),
            size: Size::Logical(LogicalSize::new(width.round(), height.round())),
        })
    }
}

/// The browser this window owns: its pages, the one on screen, and the tab each conversation is
/// connected to.
pub(crate) struct BrowserService {
    app: AppHandle,
    main: Window,
    profile: PathBuf,
    scratch: PathBuf,
    pages: Mutex<HashMap<String, Arc<Page>>>,
    active: Mutex<Option<String>>,
    /// The newest `show_tab` report applied; two tab switches can cross on the wire.
    shown_order: Mutex<u64>,
    selected: Mutex<HashMap<String, String>>,
    connected: Mutex<HashMap<String, String>>,
    locations: Mutex<HashMap<String, String>>,
    sequence: AtomicU64,
    /// Serializes page creation: two opens that arrive together must not both build a page.
    page_gate: Mutex<()>,
    backing: Mutex<Option<Window>>,
}

impl BrowserService {
    pub(crate) fn new(app: &AppHandle, paths: &DataPaths) -> IpcResult<Self> {
        let main = app.get_window(MAIN_WINDOW).ok_or_else(|| {
            IpcError::new(
                BROWSER_UNAVAILABLE,
                "This application has no window to show a page in.",
            )
        })?;
        let profile = paths.browser_profile();
        std::fs::create_dir_all(&profile).map_err(|_| {
            IpcError::new(
                BROWSER_UNAVAILABLE,
                "The browser's profile directory could not be created.",
            )
        })?;
        Ok(Self {
            app: app.clone(),
            main,
            profile,
            scratch: paths.scratch.clone(),
            pages: Mutex::new(HashMap::new()),
            active: Mutex::new(None),
            shown_order: Mutex::new(0),
            selected: Mutex::new(HashMap::new()),
            connected: Mutex::new(HashMap::new()),
            locations: Mutex::new(HashMap::new()),
            sequence: AtomicU64::new(0),
            page_gate: Mutex::new(()),
            backing: Mutex::new(None),
        })
    }

    fn key(owner: &str, tab: &str) -> String {
        format!("{owner}\u{0}{tab}")
    }

    fn next_label(&self) -> String {
        format!(
            "omp-browser-{}",
            self.sequence.fetch_add(1, Ordering::Relaxed) + 1
        )
    }

    /// The page for one `(owner, tab)`, created on first use.
    ///
    /// `headless` is true for a page no conversation owns (`plugin_navigate`): every announcement a
    /// page makes names its owner to the shell, and the shell's work panel draws one browser tab per
    /// conversation (`src/state/panel-store.ts`) - so a headless page is announced to nobody.
    fn page(&self, owner: &str, tab: &str, roots: Vec<PathBuf>, headless: bool) -> Arc<Page> {
        let _gate = self
            .page_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let key = Self::key(owner, tab);
        if let Some(page) = self
            .pages
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&key)
            .cloned()
        {
            return page;
        }
        let backing = self.backing();
        let page = Arc::new(Page::new(
            self.app.clone(),
            self.main.clone(),
            backing,
            self.profile.clone(),
            owner.to_owned(),
            tab.to_owned(),
            roots,
            self.next_label(),
            headless,
        ));
        self.pages
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(key, Arc::clone(&page));
        page
    }

    /// The tab a plugin's own page lives in: the one it last navigated, else the one it is selected
    /// as, else the default tab - the same order `navigate` walks for a conversation.
    fn plugin_tab(&self, owner: &str) -> String {
        self.connected
            .lock()
            .ok()
            .and_then(|held| held.get(owner).cloned())
            .or_else(|| {
                self.selected
                    .lock()
                    .ok()
                    .and_then(|held| held.get(owner).cloned())
            })
            .unwrap_or_else(|| DEFAULT_TAB.to_owned())
    }

    /// One plugin's own page, navigated: `pi.browser.navigate` (`rules.md#plugin-system`).
    ///
    /// The `owner` is the *installation's* key, never a conversation id, which is what makes the
    /// plugin's browser its own: a conversation's page is keyed by its session id, so nothing a
    /// plugin sends can name one. The page is created on first use and parked off screen, and it is
    /// `headless` (`page`): the shell is told nothing about it at all - no `browser-state`, no
    /// `browser-open`, and no reveal - because an installation must not put a tab in the reader's
    /// work panel, or draw a conversation the reader does not have.
    ///
    /// Owner, bound and release point: the owner is the installation key (`owner` arrives as
    /// `pages::origin_key`), the bound is one page per installation - a plugin's tab id is derived
    /// from its own key (`plugin_tab`), so navigating again reuses the page, and installations are
    /// the manifests on disk - and the release points are an installation that stops or leaves the
    /// served list (`process::supervise::capabilities::release_capabilities`,
    /// `commands::plugin_pages::publish_pages`) plus this application's exit (`dispose_all`). A call
    /// that finds no page makes one, so a release costs a plugin nothing but the next call.
    pub(crate) async fn plugin_navigate(
        &self,
        owner: &str,
        url: &str,
    ) -> IpcResult<Option<BrowserState>> {
        let owner = owner.trim();
        if owner.is_empty() {
            return Err(IpcError::new(
                INVALID_INPUT,
                "Browser navigation requires an installation.",
            ));
        }
        let tab = self.plugin_tab(owner);
        let roots = self.roots(owner, None);
        let page = self.page(owner, &tab, roots.clone(), true);
        page.set_roots(roots.clone());
        self.connected
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(owner.to_owned(), tab.clone());
        self.selected
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(owner.to_owned(), tab);
        self.locations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(page.key(), url.to_owned());
        let _ = page.navigate(url, false, roots).await;
        self.refresh_visibility();
        Ok(Some(page.state()))
    }

    /// Answers one plugin's `browser.reveal` (`pi.browser.reveal`): whether this installation has a
    /// page it could drive.
    ///
    /// Nothing is shown and no event is sent. The work panel indexes its tabs by conversation
    /// (`src/state/panel-store.ts`), and an installation is not a conversation: the page is
    /// `headless` (`page`), so announcing it would materialise a tab for a conversation the reader
    /// does not have. A plugin draws what it reads in its own `views`/`sidebarTabs` pages
    /// (`rules.md#plugin-system`); `true` answers that the page exists, not that it is on screen.
    pub(crate) fn plugin_reveal(&self, owner: &str) -> bool {
        let Some(tab) = self
            .connected
            .lock()
            .ok()
            .and_then(|held| held.get(owner).cloned())
        else {
            return false;
        };
        self.get(owner, &tab).is_some()
    }

    /// One navigation action on a plugin's own page (`pi.browser.action`).
    pub(crate) fn plugin_action(&self, owner: &str, action: &str) -> IpcResult<()> {
        let tab = self.plugin_tab(owner);
        self.action(owner, &tab, action)
    }

    /// The hidden window a parked page lives in. Created on the first page, not at start-up.
    fn backing(&self) -> Option<Window> {
        let mut held = self
            .backing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(window) = held.as_ref() {
            return Some(window.clone());
        }
        let window = backing_window(&self.app);
        *held = window.clone();
        window
    }

    fn get(&self, owner: &str, tab: &str) -> Option<Arc<Page>> {
        self.pages.lock().ok()?.get(&Self::key(owner, tab)).cloned()
    }

    fn roots(&self, owner: &str, workspace_root: Option<&str>) -> Vec<PathBuf> {
        let mut roots = Vec::new();
        if let Some(root) = workspace_root
            .map(str::trim)
            .filter(|root| !root.is_empty())
        {
            roots.push(PathBuf::from(root));
        }
        roots.push(self.scratch.join(owner));
        roots
    }

    /// Tells the shell that one conversation's page exists, so its tab can be opened or focused.
    ///
    /// Every announcement on this channel names the page's conversation as `sessionId`: the shell's
    /// work panel draws its browser tabs per conversation (`src/state/panel-store.ts`), and an
    /// installation's own page is `headless` (`page`), so nothing about it is announced at all
    /// (`plugin_reveal`) - no installation key is ever read as a session id here.
    fn emit_reveal(&self, owner: &str, tab: &str, url: Option<&str>) {
        let mut payload = json!({ "sessionId": owner, "tabId": tab });
        if let Some(url) = url.filter(|url| !url.is_empty()) {
            payload["url"] = json!(url.chars().take(8_192).collect::<String>());
        }
        let _ = self
            .app
            .emit_to(EventTarget::webview(MAIN_WINDOW), REVEAL_EVENT, payload);
    }

    /// Open one tab for the conversation. A preview always gets a new tab; a plain open reuses the
    /// default tab when it exists.
    pub(crate) async fn open_tab(
        &self,
        owner: &str,
        workspace_root: Option<&str>,
        url: Option<&str>,
        path: Option<&str>,
        preview: bool,
    ) -> IpcResult<BrowserOpened> {
        let owner = owner.trim();
        if owner.is_empty() {
            return Err(IpcError::new(
                INVALID_INPUT,
                "Browser navigation requires a session.",
            ));
        }
        let raw = path
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or_else(|| url.map(str::trim).filter(|value| !value.is_empty()));
        let tab = if raw.is_some() || preview {
            format!("tab-{}", self.sequence.fetch_add(1, Ordering::Relaxed) + 1)
        } else {
            DEFAULT_TAB.to_owned()
        };
        let roots = self.roots(owner, workspace_root);
        let page = self.page(owner, &tab, roots.clone(), false);
        page.set_roots(roots.clone());
        self.selected
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(owner.to_owned(), tab.clone());
        // A preview (or a link's new tab) is what the agent is connected to; a plain open of an
        // empty tab is the reader's chrome, not a page the agent asked for.
        if raw.is_some() {
            self.connected
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(owner.to_owned(), tab.clone());
        }
        let state = match raw {
            Some(raw) => {
                self.locations
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .insert(page.key(), raw.to_owned());
                page.navigate(raw, preview, roots).await;
                Some(page.state())
            }
            None => Some(page.state()),
        };
        self.emit_reveal(owner, &tab, raw);
        self.refresh_visibility();
        Ok(BrowserOpened { tab_id: tab, state })
    }

    /// Resolve a `BrowserPreview` path against the session's project and scratch roots.
    ///
    /// The file resolves before a tab opens, so a missing or outside-root path is a refusal rather
    /// than a tab that lands on an HTTP guess.
    pub(crate) fn preview_path(
        &self,
        owner: &str,
        workspace_root: Option<&str>,
        raw: &str,
    ) -> IpcResult<PathBuf> {
        let roots = self.roots(owner, workspace_root);
        policy::resolve_local_file(raw, &roots).ok_or_else(|| {
            IpcError::from_message(
                INVALID_INPUT,
                format!(
                    "BrowserPreview: \"{raw}\" does not resolve to an existing file inside this session's project or scratch directory."
                ),
            )
        })
    }

    /// Navigate one page. Without a tab, the order is: connected, selected,
    /// default. A named tab that is closed is an error rather than a silent new page.
    pub(crate) async fn navigate(
        &self,
        owner: &str,
        tab: Option<&str>,
        workspace_root: Option<&str>,
        url: Option<&str>,
        path: Option<&str>,
    ) -> IpcResult<Option<BrowserState>> {
        let owner = owner.trim();
        if owner.is_empty() {
            return Err(IpcError::new(
                INVALID_INPUT,
                "Browser navigation requires a session.",
            ));
        }
        let named = tab.map(str::trim).filter(|tab| !tab.is_empty());
        let tab = named
            .map(str::to_owned)
            .or_else(|| {
                self.connected
                    .lock()
                    .ok()
                    .and_then(|held| held.get(owner).cloned())
            })
            .or_else(|| {
                self.selected
                    .lock()
                    .ok()
                    .and_then(|held| held.get(owner).cloned())
            })
            .unwrap_or_else(|| DEFAULT_TAB.to_owned());
        let existing = self.get(owner, &tab);
        if named.is_some() && existing.is_none() {
            return Err(IpcError::new(
                BROWSER_UNAVAILABLE,
                "The Browser tab is closed.",
            ));
        }
        let roots = self.roots(owner, workspace_root);
        let page = existing
            .clone()
            .unwrap_or_else(|| self.page(owner, &tab, roots.clone(), false));
        page.set_roots(roots.clone());
        if named.is_none() {
            self.connected
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(owner.to_owned(), tab.clone());
            if existing.is_none() {
                self.selected
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .insert(owner.to_owned(), tab.clone());
            }
        }
        let raw = path
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or_else(|| url.map(str::trim).filter(|value| !value.is_empty()));
        let Some(raw) = raw else {
            if existing.is_none() {
                self.emit_reveal(owner, &tab, None);
            }
            self.refresh_visibility();
            return Ok(Some(page.state()));
        };
        self.locations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(page.key(), raw.to_owned());
        if existing.is_none() {
            self.emit_reveal(owner, &tab, Some(raw));
        }
        let _ = page.navigate(raw, false, roots).await;
        self.refresh_visibility();
        Ok(Some(page.state()))
    }

    /// Tell the browser which page the mounted chrome is showing, and put it there.
    pub(crate) fn show_tab(
        &self,
        owner: Option<&str>,
        tab: Option<&str>,
        location: Option<&str>,
        workspace_root: Option<&str>,
        seq: Option<u64>,
    ) {
        if let Some(seq) = seq {
            let mut held = self
                .shown_order
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if seq <= *held {
                return;
            }
            *held = seq;
        }
        let owner = owner.map(str::trim).filter(|owner| !owner.is_empty());
        let previous = self
            .active
            .lock()
            .ok()
            .and_then(|held| held.clone())
            .and_then(|key| self.page_by_key(&key));
        if let Some(previous) = previous {
            previous.set_active(false);
            previous.hide_now();
        }
        let Some(owner) = owner else {
            if let Ok(mut active) = self.active.lock() {
                *active = None;
            }
            return;
        };
        let tab = tab
            .map(str::trim)
            .filter(|tab| !tab.is_empty())
            .map(str::to_owned)
            .or_else(|| {
                self.selected
                    .lock()
                    .ok()
                    .and_then(|held| held.get(owner).cloned())
            })
            .unwrap_or_else(|| DEFAULT_TAB.to_owned());
        let roots = self.roots(owner, workspace_root);
        let previous_key = self.active.lock().ok().and_then(|held| held.clone());
        let page = self.page(owner, &tab, roots.clone(), false);
        page.set_roots(roots.clone());
        // A different page on screen has not measured the new column yet; the panel's report is
        // what makes it drawable.
        if previous_key.as_deref() != Some(page.key().as_str()) {
            page.mark_bounds_stale();
        }
        if let Ok(mut selected) = self.selected.lock() {
            selected.insert(owner.to_owned(), tab.clone());
        }
        if let Ok(mut active) = self.active.lock() {
            *active = Some(page.key());
        }
        let target = location
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .or_else(|| {
                self.locations
                    .lock()
                    .ok()
                    .and_then(|held| held.get(&page.key()).cloned())
            });
        if let Some(target) = target.as_ref() {
            self.locations
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(page.key(), target.clone());
        }
        let started = page.is_started();
        if !started && !page.is_loading() {
            if let Some(target) = target {
                let page = Arc::clone(&page);
                let roots = roots.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = page.navigate(&target, false, roots).await;
                });
            }
        }
        // The React panel reports the hole and visibility on its next layout; until then the page
        // stays hidden: no hole, no guest.
        self.refresh_visibility();
    }

    fn page_by_key(&self, key: &str) -> Option<Arc<Page>> {
        self.pages
            .lock()
            .ok()?
            .values()
            .find(|page| page.key() == key)
            .cloned()
    }

    /// The page the chrome's geometry applies to.
    pub(crate) fn set_bounds(&self, owner: &str, tab: &str, rect: BrowserRect, seq: Option<u64>) {
        let Some(page) = self.get(owner, tab) else {
            return;
        };
        let Some(bounds) = rect.bounds(&self.main) else {
            // A zero/tiny hole is a transient layout (a closing panel, an overlay's first frame),
            // not an instruction to hide the page. The visibility report owns that decision; the
            // next valid rectangle is what this command is for.
            return;
        };
        page.set_bounds(bounds, seq);
        self.refresh_visibility();
    }

    pub(crate) fn set_visible(&self, owner: &str, tab: &str, visible: bool, seq: Option<u64>) {
        if let Some(page) = self.get(owner, tab) {
            page.set_visible(visible, seq);
            self.refresh_visibility();
        }
    }

    /// Exactly one page may be on screen: the active one, when its chrome says it is visible.
    fn refresh_visibility(&self) {
        let active = self.active.lock().ok().and_then(|held| held.clone());
        let pages: Vec<Arc<Page>> = self
            .pages
            .lock()
            .map(|held| held.values().cloned().collect())
            .unwrap_or_default();
        for page in pages {
            let is_active = active.as_deref() == Some(page.key().as_str());
            page.set_active(is_active);
            if is_active {
                page.apply_wish();
            } else {
                page.hide_now();
            }
        }
    }

    pub(crate) fn action(&self, owner: &str, tab: &str, action: &str) -> IpcResult<()> {
        let page = self
            .get(owner, tab)
            .ok_or_else(|| IpcError::new(BROWSER_UNAVAILABLE, "That Browser tab is not open."))?;
        page.action(action);
        Ok(())
    }

    pub(crate) fn state(&self, owner: &str, tab: &str) -> Option<BrowserState> {
        self.get(owner, tab).map(|page| page.state())
    }

    pub(crate) fn pages(&self, owner: &str) -> Vec<BrowserState> {
        let mut pages: Vec<BrowserState> = self
            .pages
            .lock()
            .map(|held| {
                held.values()
                    .filter(|page| page.owner == owner)
                    .map(|page| page.state())
                    .collect()
            })
            .unwrap_or_default();
        pages.sort_by(|left, right| left.tab_id.cmp(&right.tab_id));
        pages
    }

    pub(crate) fn open_external(&self, owner: &str, tab: &str) -> IpcResult<()> {
        let page = self
            .get(owner, tab)
            .ok_or_else(|| IpcError::new(BROWSER_UNAVAILABLE, "That Browser tab is not open."))?;
        if !page.is_started() {
            return Ok(());
        }
        page.open_external();
        Ok(())
    }

    pub(crate) fn close_tab(&self, owner: &str, tab: &str) {
        let key = Self::key(owner, tab);
        let page = self
            .pages
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&key);
        if let Some(page) = page {
            page.close();
        }
        self.locations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&key);
        if let Ok(mut selected) = self.selected.lock() {
            if selected.get(owner).is_some_and(|value| value == tab) {
                selected.remove(owner);
            }
        }
        if let Ok(mut connected) = self.connected.lock() {
            if connected.get(owner).is_some_and(|value| value == tab) {
                connected.remove(owner);
            }
        }
        if let Ok(mut active) = self.active.lock() {
            if active.as_deref() == Some(key.as_str()) {
                *active = None;
            }
        }
    }

    pub(crate) fn close_session(&self, owner: &str) {
        let tabs: Vec<String> = self
            .pages
            .lock()
            .map(|held| {
                held.values()
                    .filter(|page| page.owner == owner)
                    .map(|page| page.tab_id.clone())
                    .collect()
            })
            .unwrap_or_default();
        for tab in tabs {
            self.close_tab(owner, &tab);
        }
        self.selected
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(owner);
        self.connected
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(owner);
    }

    pub(crate) fn dispose_all(&self) {
        let pages: Vec<Arc<Page>> = self
            .pages
            .lock()
            .map(|held| held.values().cloned().collect())
            .unwrap_or_default();
        for page in pages {
            page.close();
        }
        self.pages
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        self.active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        self.selected
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        self.connected
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        self.locations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }

    /// The page an agent action is about: the tab it last connected to, else the selected tab.
    pub(crate) fn agent_page(&self, owner: &str) -> IpcResult<Arc<Page>> {
        let tab = self
            .connected
            .lock()
            .ok()
            .and_then(|held| held.get(owner).cloned())
            .or_else(|| {
                self.selected
                    .lock()
                    .ok()
                    .and_then(|held| held.get(owner).cloned())
            });
        let page = tab.and_then(|tab| self.get(owner, &tab));
        page.ok_or_else(|| {
            IpcError::new(
                BROWSER_UNAVAILABLE,
                "No Browser page is connected to this session. Navigate or open a preview first.",
            )
        })
    }

    /// The connected page, provided it has committed a document.
    fn started_page(&self, owner: &str) -> IpcResult<Arc<Page>> {
        let page = self.agent_page(owner)?;
        if !page.is_started() {
            return Err(IpcError::new(
                BROWSER_UNAVAILABLE,
                "browser guest is not available",
            ));
        }
        Ok(page)
    }

    pub(crate) fn snapshot(&self, owner: &str) -> IpcResult<Value> {
        let page = self.started_page(owner)?;
        self.refresh_visibility();
        page.prepare_capture();
        let webview = page
            .webview()
            .ok_or_else(|| IpcError::new(BROWSER_UNAVAILABLE, "browser guest is not available"))?;
        let result = page.cdp().snapshot(&webview).map_err(cdp_error);
        self.refresh_visibility();
        let (tree, url) = result?;
        let state = page.state();
        Ok(
            json!({ "tree": tree, "url": if url.is_empty() { state.url } else { url }, "title": state.title }),
        )
    }

    pub(crate) fn screenshot(&self, owner: &str, full_page: bool) -> IpcResult<Value> {
        let page = self.started_page(owner)?;
        self.refresh_visibility();
        page.prepare_capture();
        let webview = page
            .webview()
            .ok_or_else(|| IpcError::new(BROWSER_UNAVAILABLE, "browser guest is not available"))?;
        let result = page
            .cdp()
            .screenshot(&webview, full_page)
            .map_err(cdp_error);
        self.refresh_visibility();
        let (mime_type, data) = result?;
        let path = self.save_screenshot(owner, &data);
        Ok(match path {
            Some(path) => json!({ "mimeType": mime_type, "data": data, "path": path }),
            None => json!({ "mimeType": mime_type, "data": data }),
        })
    }

    fn save_screenshot(&self, owner: &str, data: &str) -> Option<String> {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .ok()?;
        let dir = self.scratch.join(owner);
        std::fs::create_dir_all(&dir).ok()?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_millis();
        let path = dir.join(format!("browser-screenshot-{stamp}.jpg"));
        std::fs::write(&path, bytes).ok()?;
        Some(path.to_string_lossy().into_owned())
    }

    pub(crate) fn click(&self, owner: &str, uid: &str) -> IpcResult<()> {
        let page = self.started_page(owner)?;
        self.refresh_visibility();
        page.prepare_capture();
        let webview = page
            .webview()
            .ok_or_else(|| IpcError::new(BROWSER_UNAVAILABLE, "browser guest is not available"))?;
        let result = page.cdp().click(&webview, uid).map_err(cdp_error);
        self.refresh_visibility();
        result
    }

    pub(crate) fn fill(&self, owner: &str, uid: &str, text: &str) -> IpcResult<()> {
        let page = self.started_page(owner)?;
        let webview = page
            .webview()
            .ok_or_else(|| IpcError::new(BROWSER_UNAVAILABLE, "browser guest is not available"))?;
        page.cdp().fill(&webview, uid, text).map_err(cdp_error)
    }

    pub(crate) fn evaluate(&self, owner: &str, expression: &str) -> IpcResult<Value> {
        let page = self.started_page(owner)?;
        let webview = page
            .webview()
            .ok_or_else(|| IpcError::new(BROWSER_UNAVAILABLE, "browser guest is not available"))?;
        page.cdp().evaluate(&webview, expression).map_err(cdp_error)
    }

    pub(crate) fn console(&self, owner: &str, limit: Option<usize>) -> IpcResult<Value> {
        let page = self.agent_page(owner)?;
        if !page.is_started() {
            return Ok(json!({ "messages": [] }));
        }
        let webview = page
            .webview()
            .ok_or_else(|| IpcError::new(BROWSER_UNAVAILABLE, "browser guest is not available"))?;
        let messages = page.cdp().console(&webview, limit).map_err(cdp_error)?;
        Ok(json!({ "messages": messages }))
    }

    pub(crate) fn cdp(
        &self,
        owner: &str,
        method: &str,
        params: Option<&Value>,
    ) -> IpcResult<Value> {
        let page = self.started_page(owner)?;
        self.refresh_visibility();
        page.prepare_capture();
        let webview = page
            .webview()
            .ok_or_else(|| IpcError::new(BROWSER_UNAVAILABLE, "browser guest is not available"))?;
        let result = page
            .cdp()
            .send(&webview, method, params.unwrap_or(&json!({})))
            .map_err(cdp_error);
        self.refresh_visibility();
        result
    }
}

fn cdp_error(error: cdp::CdpError) -> IpcError {
    IpcError::from_message(error.code, error.message)
}
