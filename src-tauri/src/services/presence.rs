//! Whether closing the window ends the application, and the operating-system surface that makes
//! the other answer possible.
//!
//! The user's choice is one boolean. With it on, the close button hides the window and the
//! application keeps running: the engine host, the sessions and the shell tabs all live in this
//! process, so hiding is what keeps a running turn from being killed by a click on the frame. The
//! tray menu is then both the way back to the window and the way out. With it off, closing the
//! window is what it always was - the application exits.
//!
//! Hiding only works when there is a way back. A tray that could not be created, or a platform
//! that keeps none (this application builds one on Windows and Linux, not on macOS - the Dock
//! plays that part there), would turn "close" into a process the user can neither see nor click,
//! so [`hides_on_close`] refuses to hide in that case and the close goes through.
//!
//! Two of the tray's entries start a session and add a workspace - actions the window owns, and
//! the same two the window's own buttons run. The tray does not repeat them: it brings the window
//! up and hands the command to the page as [`DESKTOP_COMMAND_EVENT`], so there is one
//! implementation of each action and the tray is another way to reach it.
//!
//! The language of the tray's entries is the one piece of text this module owns. It starts as the
//! system's own language ([`Language::from_system`]) because no window has told this module
//! anything yet, and the frontend pushes the application's language afterwards (the settings page
//! switches it), so the tray follows what the window is drawing.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Emitter;
use tauri::Manager;

use crate::errors::IpcResult;
use crate::services::log;
use crate::services::store::{self, Store};

/// The tray icon's id. Tauri keeps the icon in its own registry under this name, so the icon can
/// be found again later (the language rebuild) without this module holding a handle of its own.
pub(crate) const TRAY_ID: &str = "omp-presence";

/// The `preferences` key (`app.sqlite`) the user's choice is recorded under.
pub(crate) const CLOSE_TO_TRAY_PREFERENCE: &str = "presence_close_to_tray";

/// The answer when nothing was ever recorded: the application stays resident, which is the
/// behavior every existing installation already has after this round's build.
pub(crate) const DEFAULT_CLOSE_TO_TRAY: bool = true;

/// The main window's label, as `tauri.conf.json` declares it. The tray and the Dock click are the
/// only ways back to a hidden window, and both have to name it.
pub(crate) const MAIN_WINDOW: &str = "main";

/// The tray icon's hover text. The product's own name, so it reads the same in both languages.
const TRAY_TOOLTIP: &str = "OMP Desktop";

/// Menu ids of the tray's entries. Stable strings: the menu event carries the id, and the id is
/// what tells the entries apart.
const MENU_SHOW: &str = "presence-show-window";
const MENU_NEW_SESSION: &str = "presence-new-session";
const MENU_OPEN_WORKSPACE: &str = "presence-open-workspace";
const MENU_QUIT: &str = "presence-quit";

/// The event the tray's two forwarding entries carry to the window. The payload is one of the two
/// strings below, and the frontend runs the action the window's own button runs.
pub(crate) const DESKTOP_COMMAND_EVENT: &str = "omp:desktop";

/// The payloads of [`DESKTOP_COMMAND_EVENT`], one per forwarding entry.
const COMMAND_NEW_SESSION: &str = "new-session";
const COMMAND_OPEN_WORKSPACE: &str = "open-workspace";

/// The languages the tray can be drawn in: the same two the window is drawn in.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Language {
    Zh,
    En,
}

impl Language {
    /// `"zh" | "en"`, and `None` for anything else - the command layer refuses the rest rather
    /// than falling back silently, so a typo in the frontend cannot look like a working push.
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "zh" => Some(Self::Zh),
            "en" => Some(Self::En),
            _ => None,
        }
    }

    /// The language the system is being used in, as far as this application can tell. There is
    /// nothing to ask before the window exists, so the tray starts here and the frontend corrects
    /// it. A system this platform cannot name gives [`Language::En`].
    pub(crate) fn from_system() -> Self {
        #[cfg(target_os = "windows")]
        return system_language_windows();
        #[cfg(not(target_os = "windows"))]
        return system_language_environment();
    }
}

/// The system language on Windows, from `GetUserDefaultUILanguage()`.
///
/// The primary language id is the low ten bits of the LANGID, and the value keeps the sublanguage
/// (Simplified and Traditional Chinese both sit under `0x04`) out of it, so one comparison covers
/// every Chinese locale.
#[cfg(target_os = "windows")]
fn system_language_windows() -> Language {
    // SAFETY: the call takes no arguments and returns the current user's UI language id, which is
    // what the user-facing menus of this application should be drawn in.
    let langid = unsafe { windows_sys::Win32::Globalization::GetUserDefaultUILanguage() };
    if langid & 0x03ff == 0x04 {
        Language::Zh
    } else {
        Language::En
    }
}

/// The system language elsewhere, from the POSIX locale variables in the order the C library
/// consults them; `zh_CN.UTF-8` and `zh-TW` both start with `zh`.
#[cfg(not(target_os = "windows"))]
fn system_language_environment() -> Language {
    for name in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        let Ok(value) = std::env::var(name) else {
            continue;
        };
        let chinese = value
            .trim()
            .get(..2)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("zh"));
        if chinese {
            return Language::Zh;
        }
    }
    Language::En
}

/// Whether this platform gets a tray icon at all. macOS keeps none: the Dock already brings a
/// hidden window back (`RunEvent::Reopen`), and a second icon there is not the platform's idea of
/// this application.
const fn builds_tray() -> bool {
    cfg!(any(target_os = "windows", target_os = "linux"))
}

/// The tray menu's labels in one language. One field per entry, so an entry cannot be added to
/// the menu without the compiler asking for its text - in both languages.
struct TrayLabels {
    show: &'static str,
    new_session: &'static str,
    open_workspace: &'static str,
    quit: &'static str,
}

/// The tray's labels in `language`.
fn menu_labels(language: Language) -> TrayLabels {
    match language {
        Language::Zh => TrayLabels {
            show: "显示主窗口",
            new_session: "新建会话",
            open_workspace: "添加工作区",
            quit: "退出",
        },
        Language::En => TrayLabels {
            show: "Show Main Window",
            new_session: "New Session",
            open_workspace: "Add Workspace",
            quit: "Quit",
        },
    }
}

/// Whether a close request leaves the application running.
///
/// `close_to_tray` is the user's choice, but a hidden window is only acceptable when the user can
/// bring it back: `tray_ready` says a tray icon exists, and `dock_reopen` says this platform has a
/// Dock to click. With neither, hiding would leave a process that is invisible and unreachable -
/// the close therefore goes through as the ordinary exit.
pub(crate) fn hides_on_close(close_to_tray: bool, tray_ready: bool, dock_reopen: bool) -> bool {
    close_to_tray && (tray_ready || dock_reopen)
}

/// The residency decision and the OS surface behind it, in one place the window-event hook and the
/// two preference commands all read from.
///
/// Every field is written on one thread and read on another - the preference commands run on a
/// worker, the close hook on the main thread - so the two flags are atomics and the language, the
/// only value with more than one bit of shape, sits behind a lock held for the length of a copy.
pub(crate) struct Presence {
    close_to_tray: AtomicBool,
    /// Whether a tray icon exists to return to. False until [`install_tray`] has built one, and
    /// false forever when it could not be.
    tray_ready: AtomicBool,
    language: Mutex<Language>,
}

impl Presence {
    /// Reads the recorded choice once, on the start-up path (`Store::get_preference_blocking`).
    ///
    /// A store that cannot be read and a value that is not a boolean both leave the default in
    /// place: the preference is a convenience, and refusing to start over it would be worse than
    /// starting with the product's own answer.
    pub(crate) fn load(store: &Store) -> Self {
        let close_to_tray = match store.get_preference_blocking(CLOSE_TO_TRAY_PREFERENCE) {
            Ok(Some(encoded)) => match serde_json::from_str::<bool>(&encoded) {
                Ok(value) => value,
                Err(_) => {
                    log::warn(&format!(
                        "the recorded close-to-tray preference is not a boolean; {DEFAULT_CLOSE_TO_TRAY} applies"
                    ));
                    DEFAULT_CLOSE_TO_TRAY
                }
            },
            Ok(None) => DEFAULT_CLOSE_TO_TRAY,
            Err(error) => {
                log::warn(&format!(
                    "the close-to-tray preference could not be read; {DEFAULT_CLOSE_TO_TRAY} applies: {}",
                    error.message
                ));
                DEFAULT_CLOSE_TO_TRAY
            }
        };
        Self {
            close_to_tray: AtomicBool::new(close_to_tray),
            tray_ready: AtomicBool::new(false),
            language: Mutex::new(Language::from_system()),
        }
    }

    pub(crate) fn close_to_tray(&self) -> bool {
        self.close_to_tray.load(Ordering::Relaxed)
    }

    pub(crate) fn tray_ready(&self) -> bool {
        self.tray_ready.load(Ordering::Relaxed)
    }

    /// The decision for a close request on this machine: the recorded preference, whether a tray
    /// exists to return to, and the Dock - which only macOS has to click back from.
    pub(crate) fn hides_on_close(&self) -> bool {
        hides_on_close(
            self.close_to_tray(),
            self.tray_ready(),
            cfg!(target_os = "macos"),
        )
    }

    pub(crate) fn set_close_to_tray(&self, value: bool) {
        self.close_to_tray.store(value, Ordering::Relaxed);
    }

    /// Records the choice, then makes it the answer this process gives.
    ///
    /// The order is the point: a record that landed while the in-memory value did not is corrected
    /// by the next start, while an in-memory value with no record would silently revert at that
    /// start. A write that does not land therefore fails the whole call, and nothing has changed on
    /// either side.
    pub(crate) async fn remember_close_to_tray(&self, store: &Store, value: bool) -> IpcResult<()> {
        let encoded = serde_json::Value::Bool(value).to_string();
        store
            .set_preference(CLOSE_TO_TRAY_PREFERENCE, &encoded, store::now_ms())
            .await?;
        self.set_close_to_tray(value);
        Ok(())
    }

    pub(crate) fn language(&self) -> Language {
        // A poisoned lock is not a reason to take the application down: the value behind it is a
        // two-variant enum that cannot be left half-written.
        *self
            .language
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn set_language(&self, language: Language) {
        *self
            .language
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = language;
    }

    /// Marks the tray as built. Only [`install_tray`] calls this, and only after the icon really
    /// exists - the close hook trusts the flag to mean "there is a way back".
    fn set_tray_ready(&self, value: bool) {
        self.tray_ready.store(value, Ordering::Relaxed);
    }
}

/// Builds the tray icon: the way back to a window that was closed with the preference on, and the
/// only place the application can be left from then on.
///
/// Called once from `setup`, on the main thread the menus want. A failure is not fatal - the
/// preference still reads what the user chose, but with no tray to return to a close request falls
/// through to the ordinary exit (see [`hides_on_close`]), which is the state this application had
/// before the tray existed.
pub(crate) fn install_tray(app: &tauri::AppHandle, presence: &Presence) {
    if !builds_tray() {
        return;
    }
    let Some(icon) = app.default_window_icon().cloned() else {
        log::warn("the tray icon was not created: the application has no window icon to show");
        return;
    };
    let menu = match tray_menu(app, presence.language()) {
        Ok(menu) => menu,
        Err(error) => {
            log::warn(&format!("the tray menu could not be built: {error}"));
            return;
        }
    };
    let built = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip(TRAY_TOOLTIP)
        .menu(&menu)
        // The left click is the way back, so it must not open the menu (which is the right
        // click's job on Windows).
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_SHOW => show_main_window(app),
            MENU_NEW_SESSION => forward_command(app, COMMAND_NEW_SESSION),
            MENU_OPEN_WORKSPACE => forward_command(app, COMMAND_OPEN_WORKSPACE),
            // Quitting from here is an explicit exit: the exit request the runtime gets is what
            // the host shutdown and the pty cleanup run on, exactly as a close would have been.
            MENU_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app);
    match built {
        Ok(_) => {
            presence.set_tray_ready(true);
            log::info("the tray icon is ready");
        }
        Err(error) => log::warn(&format!("the tray icon could not be created: {error}")),
    }
}

/// Rebuilds the tray's menu and tooltip in `presence`'s language.
///
/// The command layer calls this from a worker thread while the menu objects belong to the main
/// thread, so the lookup and the two updates are handed to tauri's own dispatch instead of being
/// done from here. Nothing to relabel means nothing to do: without a tray (and on macOS, where
/// there never is one) the call returns without touching anything.
pub(crate) fn apply_tray_language(app: &tauri::AppHandle, presence: &Presence) {
    if !presence.tray_ready() {
        return;
    }
    let language = presence.language();
    let handle = app.clone();
    let dispatched = app.run_on_main_thread(move || {
        let Some(tray) = handle.tray_by_id(TRAY_ID) else {
            log::warn("the tray language was not applied: the tray icon is missing");
            return;
        };
        match tray_menu(&handle, language) {
            Ok(menu) => {
                if let Err(error) = tray.set_menu(Some(menu)) {
                    log::warn(&format!("the tray menu could not be relabeled: {error}"));
                }
            }
            Err(error) => log::warn(&format!("the tray menu could not be built: {error}")),
        }
        if let Err(error) = tray.set_tooltip(Some(TRAY_TOOLTIP)) {
            log::warn(&format!("the tray tooltip could not be set: {error}"));
        }
    });
    if let Err(error) = dispatched {
        log::warn(&format!("the tray language could not be applied: {error}"));
    }
}

/// The main window, looked up as a window rather than as a webview window.
///
/// A plugin page's own window is a separate webview window, and a lookup by webview window would
/// answer only for a window whose every webview carries its label. The window itself is registered
/// once under [`MAIN_WINDOW`] and stays there, so that is what every path that needs it - the tray,
/// the Dock, the taskbar flash, the plugin bridge - looks up.
pub(crate) fn main_window(app: &tauri::AppHandle) -> Option<tauri::Window> {
    app.get_window(MAIN_WINDOW)
}

/// The same window looked up as its webview window, for the calls that have to reach the webview
/// itself.
///
/// `tauri::Window::set_background_color` paints the Win32 window's brush only, and the webview
/// covers that brush entirely: only this handle's `set_background_color` also sets WebView2's own
/// default surface, which is what the client area shows until the document's first frame.
pub(crate) fn main_webview_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW)
}

/// Shows and focuses the main window: the tray's left click, its "show" entry, and macOS's Dock
/// click all end here. A missing window is recorded and nothing else - the caller is a click on a
/// tray icon, which has no way to report an error.
pub(crate) fn show_main_window(app: &tauri::AppHandle) {
    let Some(window) = main_window(app) else {
        log::warn("the main window could not be shown: it is not there");
        return;
    };
    // A window can have been minimized before it was hidden; undoing both is what brings it up in
    // front instead of leaving it behind the next window.
    if let Err(error) = window.unminimize() {
        log::warn(&format!("unminimizing the main window failed: {error}"));
    }
    if let Err(error) = window.show() {
        log::warn(&format!("showing the main window failed: {error}"));
    }
    if let Err(error) = window.set_focus() {
        log::warn(&format!("focusing the main window failed: {error}"));
    }
}

/// Flashes the taskbar button for a turn that finished away from the reader.
///
/// Only the window knows who was watching, so the front end asks for this: an ending it watched —
/// the conversation on screen *and* the window focused — is already known, and a stop the reader
/// pressed themselves is their own act; neither asks. A completion that arrives while they are in
/// another application, or looking at another conversation, is what this mark is for.
///
/// Windows' own attention request is not enough for the in-app case: tao returns without flashing
/// when the window is already active (`tao/window.rs::request_user_attention`), and the reader who
/// switched conversations is exactly that case. `flash_taskbar` calls `FlashWindowEx` directly with
/// a finite count, which flashes the taskbar button whether or not the window is foreground.
///
/// **No overlay badge.** This used to leave a green dot on the taskbar icon; the reader asked for
/// the flash alone (2026-10-21), so nothing is set on the icon and nothing has to be cleared there.
pub(crate) fn flash_finished(app: &tauri::AppHandle) {
    let Some(window) = main_window(app) else {
        return;
    };
    log::info("taskbar: a turn finished away from the reader");
    #[cfg(target_os = "windows")]
    flash_taskbar(&window);
    #[cfg(not(target_os = "windows"))]
    if let Err(error) = window.request_user_attention(Some(tauri::UserAttentionType::Informational))
    {
        log::warn(&format!("the taskbar button could not be flashed: {error}"));
    }
}

/// Flashes the window's taskbar button a finite number of times, foreground or not.
///
/// `FLASHW_ALL` is the caption and the taskbar button, `FLASHW_TRAY` the button alone; together with
/// a `uCount` and no `FLASHW_TIMER` the flash ends on its own instead of waiting for activation
/// (which may never come when the reader stays in the application).
#[cfg(target_os = "windows")]
fn flash_taskbar(window: &tauri::Window) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FlashWindowEx, FLASHWINFO, FLASHW_ALL, FLASHW_TRAY,
    };
    let Ok(hwnd) = window.hwnd() else {
        log::warn("the taskbar button could not be flashed: the window has no handle");
        return;
    };
    let info = FLASHWINFO {
        cbSize: std::mem::size_of::<FLASHWINFO>() as u32,
        hwnd: hwnd.0,
        dwFlags: FLASHW_ALL | FLASHW_TRAY,
        uCount: 4,
        dwTimeout: 0,
    };
    // SAFETY: `info` is a fully initialized FLASHWINFO for a live window handle owned by this
    // process, and the call neither retains the pointer nor takes ownership of the window.
    unsafe {
        FlashWindowEx(&info);
    }
}

/// Cancels a platform attention request that is still running.
///
/// Windows flashes a fixed count and leaves no badge, so there is nothing to cancel there. Other
/// platforms use the runtime's request, which stays until it is cleared or the window is activated.
pub(crate) fn clear_attention(app: &tauri::AppHandle) {
    #[cfg(target_os = "windows")]
    let _ = app;
    #[cfg(not(target_os = "windows"))]
    {
        let Some(window) = main_window(app) else {
            return;
        };
        if let Err(error) = window.request_user_attention(None) {
            log::warn(&format!(
                "the taskbar attention request could not be cleared: {error}"
            ));
        }
    }
}

/// How long a start may stay hidden waiting for its document to say the shell has painted.
///
/// Short on purpose: the document that says it is the same embedded/local one the window was created
/// to load, so the answer is a bundle's parse away. The ceiling is only the answer for a bundle that
/// never runs - and the document is parsed by then, so it opens on the shell rather than on nothing.
const MAIN_WINDOW_READY_CEILING: std::time::Duration = std::time::Duration::from_millis(1500);

/// Arms the ceiling above: shows the main window if its document has not done so by then.
///
/// The window starts hidden because showing it before its webview has anything to paint puts
/// WebView2's own white on screen (the flash every start opened on, 2026-10-20); the document
/// raises it through the `main_window_ready` command as soon as it is parsed. This is the one path
/// that cannot be skipped: without it a start whose bundle fails would run with no window at all.
pub(crate) fn arm_main_window_ceiling(app: &tauri::AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(MAIN_WINDOW_READY_CEILING);
        let Some(window) = main_window(&handle) else {
            return;
        };
        if matches!(window.is_visible(), Ok(true)) {
            return;
        }
        log::info("the window was shown by the start-up ceiling: its document did not raise it");
        show_main_window(&handle);
    });
}

/// Hands one of the window's own actions to the frontend, as `command` (one of the payloads of
/// [`DESKTOP_COMMAND_EVENT`]).
///
/// The window is brought up first, and the command follows: the action is then carried out on the
/// page the user is about to look at, and a hidden window does not run it out of sight. A failed
/// emit is recorded and nothing else - the caller is a click on a menu entry, which has no way to
/// report an error, and the frontend would have nothing to undo.
fn forward_command(app: &tauri::AppHandle, command: &'static str) {
    show_main_window(app);
    // Addressed to the main document alone: this is the application's own action, not something a
    // plugin page is meant to hear.
    if let Err(error) = app.emit_to(MAIN_WINDOW, DESKTOP_COMMAND_EVENT, command) {
        log::warn(&format!(
            "the tray command {command} could not be delivered to the window: {error}"
        ));
    }
}

/// The tray's menu in `language`: the way back to the window, the two entries that forward to it,
/// then the way out of the application.
fn tray_menu(app: &tauri::AppHandle, language: Language) -> tauri::Result<Menu<tauri::Wry>> {
    let labels = menu_labels(language);
    let show = MenuItem::with_id(app, MENU_SHOW, labels.show, true, None::<&str>)?;
    let before_forwarding = PredefinedMenuItem::separator(app)?;
    let new_session = MenuItem::with_id(
        app,
        MENU_NEW_SESSION,
        labels.new_session,
        true,
        None::<&str>,
    )?;
    let open_workspace = MenuItem::with_id(
        app,
        MENU_OPEN_WORKSPACE,
        labels.open_workspace,
        true,
        None::<&str>,
    )?;
    let before_quit = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, labels.quit, true, None::<&str>)?;
    Menu::with_items(
        app,
        &[
            &show,
            &before_forwarding,
            &new_session,
            &open_workspace,
            &before_quit,
            &quit,
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_close_hides_only_when_there_is_a_way_back() {
        // A tray, a Dock, or both: with the preference on, the window goes away and the process
        // stays.
        assert!(hides_on_close(true, true, false));
        assert!(hides_on_close(true, false, true));
        // Neither: hiding would leave a process the user cannot see or reach, so the close has to
        // go through as the ordinary exit.
        assert!(!hides_on_close(true, false, false));
        // The preference off answers the same way whatever is available.
        assert!(!hides_on_close(false, true, true));
    }

    #[test]
    fn the_command_layer_accepts_exactly_two_languages() {
        assert_eq!(Language::parse("zh"), Some(Language::Zh));
        assert_eq!(Language::parse("en"), Some(Language::En));
        assert_eq!(Language::parse("EN"), None);
        assert_eq!(Language::parse(""), None);
    }
}
