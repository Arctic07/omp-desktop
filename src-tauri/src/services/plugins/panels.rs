//! The panel windows: one per open plugin panel, and the bookkeeping that closes them again.
//!
//! A panel is the one desktop contribution that is a window of its own (spec §7.1/§7.2). That window
//! is created here and nowhere else, so three properties hold by construction: its label is derived
//! from the installation and the panel id (two windows for one panel are impossible), it loads a URL
//! this process built (never one a caller sent), and it matches no capability - the application's
//! own capabilities name the `main` window, so a plugin window has no command surface at all, which
//! is the second half of the sandbox on top of the page having no IPC injected into it.
//!
//! **Owner / bound / release.** The open windows are owned here, one entry per window label, bounded
//! by [`MAX_PANEL_WINDOWS`], and released on every close - the window's own destruction event calls
//! [`PluginPanels::forget`], and disabling, uninstalling or upgrading an installation calls
//! [`PluginPanels::close_all_for_key`] from the same response that reports the new state, so a panel
//! of a plugin that no longer runs cannot outlive its plugin.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::webview::NewWindowResponse;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use crate::errors::{IpcError, IpcResult, PLUGIN_PAGE_UNAVAILABLE};
use crate::services::log;
use crate::services::plugins::pages::{self, PageKind, PluginPage};

/// How many plugin windows may be open at once.
///
/// A panel is a window and windows are not free: this is the bound on the whole feature rather than a
/// per-plugin one, because a plugin that opens a dozen windows is the same problem as a dozen plugins
/// opening one each.
pub(crate) const MAX_PANEL_WINDOWS: usize = 8;

/// Longest title a panel window is created with, and the size range it is created in.
const TITLE_MAX: usize = 120;
/// The smallest and largest size a panel window may be created with. The range mirrors the host's
/// own bound on a manifest's `width`/`height` (`host/src/constants.ts`
/// `PLUGIN_DESKTOP_PANEL_WIDTH_MIN/MAX` = 320/2048, `PLUGIN_DESKTOP_PANEL_HEIGHT_MIN/MAX` =
/// 240/1600), applied again where the window is actually built: a window is a platform object and
/// not a payload, so it does not inherit the host's check.
const MIN_WIDTH: f64 = 320.0;
const MAX_WIDTH: f64 = 2048.0;
const MIN_HEIGHT: f64 = 240.0;
const MAX_HEIGHT: f64 = 1600.0;

/// Whether one navigation stays on the installation's own origin.
///
/// The comparison is the browser's own - scheme, host and port - because that is what decides whether
/// a document is the same origin: a page navigating to another path of its own bundle is the ordinary
/// case, and anything else, the application's own origin included, is refused before the request is
/// made. The port is compared by its *effective* value, so an address that names the scheme's default
/// port and one that leaves it out are the same origin.
fn same_origin(base: &str, target: &tauri::Url) -> bool {
    let Ok(base) = tauri::Url::parse(base) else {
        return false;
    };
    base.scheme() == target.scheme()
        && base.host_str() == target.host_str()
        && base.port_or_known_default() == target.port_or_known_default()
}

/// One open plugin window: the installation that owns it, and the workspace it was opened from.
///
/// The workspace travels with the window rather than with the installation because it is a fact about
/// *this* window: the same panel opened from two workspaces is two windows, and each of them reads the
/// files of the workspace the user opened it in (spec §6.3). It is `None` when the shell had no
/// workspace at the time, which leaves the file gates with the installation's own package.
#[derive(Debug, Clone)]
pub(crate) struct PanelWindow {
    pub(crate) key: String,
    pub(crate) workspace: Option<PathBuf>,
}

/// The windows this process has open: label → the window that label names.
pub(crate) struct PluginPanels {
    open: Mutex<HashMap<String, PanelWindow>>,
}

impl PluginPanels {
    pub(crate) fn new() -> Self {
        Self {
            open: Mutex::new(HashMap::new()),
        }
    }

    /// The label one panel window is created under.
    ///
    /// It starts with the scheme's name and carries the origin key and the panel id, so a label says
    /// which plugin and which panel it is - which is what makes the destroy handler below able to
    /// answer "was this one of ours" without a second registry, and what the capability files can
    /// exclude by prefix.
    pub(crate) fn label(key: &str, panel_id: &str) -> String {
        format!("{}-{key}-{panel_id}", pages::PLUGIN_SCHEME)
    }

    /// How many plugin windows are open. Used by this module's own tests only, which is why it is
    /// compiled with them and not into the application.
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.lock().len()
    }

    /// Records one window as open, or refuses when the ceiling is reached.
    fn claim(&self, label: &str, key: &str, workspace: Option<PathBuf>) -> IpcResult<()> {
        let mut open = self.lock();
        if !open.contains_key(label) && open.len() >= MAX_PANEL_WINDOWS {
            return Err(IpcError::from_message(
                PLUGIN_PAGE_UNAVAILABLE,
                format!("At most {MAX_PANEL_WINDOWS} plugin windows can be open at once; close one first."),
            ));
        }
        open.insert(
            label.to_owned(),
            PanelWindow {
                key: key.to_owned(),
                workspace,
            },
        );
        Ok(())
    }

    /// Forgets one window, whatever became of it. Called from the window's own destroy event and
    /// from every close this service performs, so a stale label cannot keep the ceiling occupied.
    pub(crate) fn forget(&self, label: &str) {
        self.lock().remove(label);
    }

    /// The origin key one open window belongs to, when it is one of ours.
    pub(crate) fn key_of(&self, label: &str) -> Option<String> {
        self.lock().get(label).map(|window| window.key.clone())
    }

    /// The workspace one open window was opened from.
    ///
    /// `None` covers both "no such window" and "a window opened with no workspace": the caller is the
    /// bridge, which falls back to the shell's current workspace either way.
    pub(crate) fn workspace_of(&self, label: &str) -> Option<PathBuf> {
        self.lock()
            .get(label)
            .and_then(|window| window.workspace.clone())
    }

    /// Closes every window one installation opened, and forgets them.
    ///
    /// Called from the same place the state that closed them arrives - a plugin that was disabled,
    /// uninstalled or upgraded - so the windows go with the state change rather than at the next
    /// launch. A window that refuses to close is logged and dropped from the registry anyway: what
    /// matters is that it is not counted as open and cannot be addressed, and the user still has its
    /// own close button.
    pub(crate) fn close_all_for_key(&self, app: &tauri::AppHandle, key: &str) {
        let labels: Vec<String> = self
            .lock()
            .iter()
            .filter(|(_, window)| window.key == key)
            .map(|(label, _)| label.clone())
            .collect();
        for label in labels {
            self.forget(&label);
            if let Some(window) = app.get_webview_window(&label) {
                if let Err(error) = window.close() {
                    log::warn(&format!(
                        "a plugin window could not be closed after its plugin changed state: {error}"
                    ));
                }
            }
        }
    }

    /// Closes the window that asked to be closed, when this process opened it.
    ///
    /// The request comes from the page itself (the bridge's `close` method), so it is accepted only
    /// for a *window* of that installation: a docked page - a view, a settings page, a sidebar tab -
    /// is part of this application's own window and has no such move, and its bridge call is refused
    /// with `permission_denied` rather than closing the window it is embedded in.
    pub(crate) fn close_window(&self, app: &tauri::AppHandle, label: &str, key: &str) -> bool {
        if self.key_of(label).as_deref() != Some(key) {
            return false;
        }
        self.forget(label);
        match app.get_webview_window(label) {
            Some(window) => window.close().is_ok(),
            None => true,
        }
    }

    /// Opens one panel window for an installation that may serve it.
    ///
    /// Everything the window is made of comes from the manifest the host validated and this process
    /// re-checked: the size it asked for (bounded again here, to the same range the host allows,
    /// because a window is a platform object and not a payload), whether it may be resized, and its
    /// title. A window that already exists
    /// under the same label is brought to the front instead of being built twice.
    pub(crate) fn open(
        &self,
        app: &tauri::AppHandle,
        page: &PluginPage,
        panel_id: &str,
        title: String,
        workspace: Option<PathBuf>,
    ) -> IpcResult<String> {
        if !page.enabled {
            return Err(IpcError::new(
                PLUGIN_PAGE_UNAVAILABLE,
                "This plugin is disabled; enable it to open its panels.",
            ));
        }
        let Some(panel) = page.page(PageKind::Panel, panel_id) else {
            return Err(IpcError::from_message(
                PLUGIN_PAGE_UNAVAILABLE,
                format!("This plugin declares no panel \"{panel_id}\"."),
            ));
        };
        let Some(url) = pages::page_url(&page.origin(), &panel.entry) else {
            return Err(IpcError::new(
                PLUGIN_PAGE_UNAVAILABLE,
                "This plugin's panel entry is not a path this build serves.",
            ));
        };
        let key = pages::origin_key(&page.plugin_id, &page.scope);
        let label = Self::label(&key, &panel.id);
        if let Some(existing) = app.get_webview_window(&label) {
            let _ = existing.set_focus();
            return Ok(label);
        }
        let target = tauri::Url::parse(&url).map_err(|_| {
            IpcError::new(
                PLUGIN_PAGE_UNAVAILABLE,
                "This plugin's panel entry could not be addressed.",
            )
        })?;
        self.claim(&label, &key, workspace)?;
        let width = panel_dimension(panel.width, 720, MIN_WIDTH, MAX_WIDTH);
        let height = panel_dimension(panel.height, 560, MIN_HEIGHT, MAX_HEIGHT);
        // The page's own origin, captured before the builder moves on: a panel may navigate within
        // its own bundle (its own documents and routes) and nowhere else.
        let origin = page.origin();
        let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::CustomProtocol(target))
            .title(title)
            .inner_size(width, height)
            .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
            .resizable(panel.resizable.unwrap_or(true))
            // Two request-level refusals (spec §6.4, §7.2.1): a navigation that leaves the page's own
            // origin never reaches the network - including the one escape the sandbox cannot stop, a
            // frame navigating *itself* to the application's own origin - and a window the page tries
            // to open is refused rather than followed. The sandbox's `allow-popups` absence already
            // says the same thing; this is the same answer at the layer that owns the request.
            .on_navigation(move |url| same_origin(&origin, url))
            .on_new_window(|_, _| NewWindowResponse::Deny)
            // The third request-level refusal (spec §6.4): a plugin's own window is granted no
            // browser permission at all - a microphone, a camera, a location, a screen capture, a
            // clipboard read, a notification, MIDI, a sensor. What a plugin legitimately needs has a
            // gated channel (the bridge), so the platform never gets to ask on the plugin's behalf.
            .on_permission_request(|_webview, kind| {
                crate::services::permissions::for_plugin_window(kind)
            })
            .build();
        match built {
            Ok(window) => {
                crate::services::webview_keys::release_find_keys_on(
                    window.as_ref(),
                    "a plugin window",
                );
                log::info(&format!(
                    "plugin panel window opened: plugin={} panel={}",
                    page.plugin_id, panel.id
                ));
                Ok(label)
            }
            Err(error) => {
                self.forget(&label);
                Err(IpcError::from_message(
                    PLUGIN_PAGE_UNAVAILABLE,
                    format!("The plugin window could not be opened: {error}"),
                ))
            }
        }
    }

    /// Every origin key that has a window open, for the caller that just learned which installs are
    /// still servable.
    pub(crate) fn keys(&self) -> HashSet<String> {
        self.lock()
            .values()
            .map(|window| window.key.clone())
            .collect()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, PanelWindow>> {
        self.open
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// One requested window dimension as this build creates it.
///
/// The manifest's value when it declared one, the fallback otherwise, bounded below so the window is
/// usable and above so a manifest cannot ask for a window larger than the host's own bound allows
/// (see [`MAX_WIDTH`] / [`MAX_HEIGHT`]). `u32` cannot be NaN, so the clamp is total.
fn panel_dimension(requested: Option<u32>, fallback: u32, min: f64, max: f64) -> f64 {
    f64::from(requested.unwrap_or(fallback)).clamp(min, max)
}

/// The title one panel window is created with.
///
/// The caller passes the title the page would have drawn, because the language is the page's own
/// choice and nothing in this process knows it; what this function adds is the fallback chain - that
/// title, then the panel's own titles from the manifest, then the plugin's display name, then its id -
/// and the bound. A title with control characters in it is dropped rather than sanitised: a window
/// title is text a user reads, and a caller that sends one with a newline in it is not describing a
/// window this build wants to open.
pub(crate) fn panel_title(
    requested: Option<&str>,
    panel: Option<&std::collections::BTreeMap<String, String>>,
    plugin_name: &str,
    plugin_id: &str,
) -> String {
    fn usable(text: &str) -> Option<&str> {
        let trimmed = text.trim();
        if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
            return None;
        }
        Some(trimmed)
    }
    // The manifest's own rule for a language the caller did not name (spec §3.2): `en` is the
    // fallback the rest of this application reads, so a window opened without a title the page
    // resolved shows the English one rather than whichever locale happened to sort first.
    let declared = panel.and_then(|titles| {
        titles
            .get("en")
            .or_else(|| titles.get("zh"))
            .or_else(|| titles.values().next())
    });
    let name = requested
        .and_then(usable)
        .or_else(|| declared.and_then(|text| usable(text)))
        .unwrap_or(if plugin_name.trim().is_empty() {
            plugin_id
        } else {
            plugin_name
        });
    name.chars().take(TITLE_MAX).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A navigation stays on the installation's own origin: another path of its own bundle is the
    /// ordinary case, and every other address - another origin, another scheme, the application's
    /// own - is refused before the request is made.
    #[test]
    fn a_panel_may_navigate_inside_its_own_origin_only() {
        let origin = pages::origin("0123456789abcdef0123456789abcdef");
        let same = tauri::Url::parse(&format!("{origin}/desktop/panel/other.html")).expect("a url");
        assert!(same_origin(&origin, &same));
        let elsewhere = tauri::Url::parse("https://example.test/x").expect("a url");
        assert!(!same_origin(&origin, &elsewhere));
        let application = tauri::Url::parse("tauri://localhost/index.html").expect("a url");
        assert!(!same_origin(&origin, &application));
        let other_key = pages::origin("ffffffffffffffffffffffffffffffff");
        let sibling = tauri::Url::parse(&format!("{other_key}/index.html")).expect("a url");
        assert!(
            !same_origin(&origin, &sibling),
            "another installation is another origin"
        );
        assert!(!same_origin("not a base", &same));
    }

    /// A window is addressed by the installation it belongs to and the panel it shows, so one panel
    /// cannot be opened twice under two labels.
    #[test]
    fn a_label_names_the_plugin_and_the_panel() {
        let key = pages::origin_key("smoke-plugin", "user");
        let label = PluginPanels::label(&key, "main");
        assert!(label.starts_with("omp-plugin-"), "{label}");
        assert!(label.ends_with(&format!("-{key}-main")), "{label}");
        assert!(label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
        assert_ne!(label, PluginPanels::label(&key, "second"));
    }

    /// The ceiling counts windows, not plugins: a window already open is not claimed twice.
    #[test]
    fn the_window_ceiling_is_a_count_of_windows() {
        let panels = PluginPanels::new();
        for index in 0..MAX_PANEL_WINDOWS {
            assert!(panels
                .claim(&format!("omp-plugin-k{index}"), "k", None)
                .is_ok());
        }
        assert!(
            panels.claim("omp-plugin-k0", "k", None).is_ok(),
            "an open window is not a second one"
        );
        assert!(panels.claim("omp-plugin-extra", "k", None).is_err());
        panels.forget("omp-plugin-k0");
        assert!(panels.claim("omp-plugin-extra", "k", None).is_ok());
        assert_eq!(panels.len(), MAX_PANEL_WINDOWS);
    }

    /// A window's title falls back from what the page asked for to the manifest and then the plugin.
    #[test]
    fn a_panel_title_falls_back_to_the_plugin() {
        let mut titles = std::collections::BTreeMap::new();
        titles.insert("en".to_owned(), "Git Log".to_owned());
        titles.insert("zh".to_owned(), "Git 日志".to_owned());
        assert_eq!(
            panel_title(Some("日志"), Some(&titles), "Git Helper", "git-helper"),
            "日志"
        );
        assert_eq!(
            panel_title(None, Some(&titles), "Git Helper", "git-helper"),
            "Git Log",
            "a language the caller did not name falls back the way the manifest rules say"
        );
        assert_eq!(
            panel_title(None, None, "Git Helper", "git-helper"),
            "Git Helper"
        );
        assert_eq!(
            panel_title(Some("  "), None, "  ", "git-helper"),
            "git-helper"
        );
        assert_eq!(
            panel_title(Some("a\nb"), None, "Git Helper", "git-helper"),
            "Git Helper",
            "a title carrying a control character is not one to put in a window"
        );
    }

    /// A panel's requested size is bounded on both sides: below so the window is usable, above so a
    /// manifest cannot ask for a window larger than the host allows.
    #[test]
    fn a_panel_size_is_bounded_on_both_sides() {
        assert_eq!(
            panel_dimension(Some(0), 720, MIN_WIDTH, MAX_WIDTH),
            MIN_WIDTH
        );
        assert_eq!(
            panel_dimension(Some(u32::MAX), 720, MIN_WIDTH, MAX_WIDTH),
            MAX_WIDTH
        );
        assert_eq!(
            panel_dimension(Some(0), 560, MIN_HEIGHT, MAX_HEIGHT),
            MIN_HEIGHT
        );
        assert_eq!(
            panel_dimension(Some(u32::MAX), 560, MIN_HEIGHT, MAX_HEIGHT),
            MAX_HEIGHT
        );
        assert_eq!(panel_dimension(None, 720, MIN_WIDTH, MAX_WIDTH), 720.0);
        assert_eq!(
            panel_dimension(Some(1024), 720, MIN_WIDTH, MAX_WIDTH),
            1024.0
        );
    }
}
