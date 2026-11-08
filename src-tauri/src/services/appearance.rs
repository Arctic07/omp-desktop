//! The color the window is painted in before any document exists.
//!
//! The window is created by the configuration and painted from its first frame on, so its
//! background has to be decided before the front end has run at all: a window whose color is left
//! to the platform opens white, which is the flash a dark desktop shows on every start.
//!
//! The document's own base color comes from the appearance preference the front end keeps in the
//! webview's storage, and that storage is inside the webview - nothing outside it can read it. The
//! same preference is therefore pushed here by the front end and recorded a second time, in the
//! store this process can read before any webview exists.
//!
//! What is recorded is the setting, not the color it resolves to: `system` has to be resolved
//! against the operating system's theme at the moment the window is opened, and a color recorded
//! days earlier would freeze whatever the theme was then. The record is only a best guess for the
//! one frame before the document loads - a missing, unreadable or unknown value falls back to
//! `system`, and the document paints over the window as soon as it runs - so nothing here can leave
//! the window in the wrong color for longer than that.

use crate::errors::IpcResult;
use crate::services::store::{self, Store};

/// Whether the operating system's theme is dark, as a window sees it.
///
/// `System` resolves against this; the two explicit settings ignore it.
pub(crate) fn system_dark(window: &tauri::Window) -> bool {
    matches!(window.theme(), Ok(tauri::Theme::Dark))
}

/// The `preferences` key (`app.sqlite`) the appearance setting is recorded under.
pub(crate) const STARTUP_THEME_PREFERENCE: &str = "startup_theme";

/// The document's light base color, one of the two values `--omp-startup-bg` holds in
/// `src/index.html` (the `:root` rule, which is `--background` from `src/src/index.css`).
const LIGHT_BACKGROUND: tauri::window::Color = tauri::window::Color(255, 255, 255, 255);

/// The document's dark base color, the other value `--omp-startup-bg` holds in `src/index.html`
/// (the `html[data-omp-startup-theme='dark']` rule: `oklch(0.145 0 0)`, the `.dark`
/// `--background` of `src/src/index.css`, which is #0a0a0a in sRGB).
const DARK_BACKGROUND: tauri::window::Color = tauri::window::Color(10, 10, 10, 255);

/// The appearance setting as the front end stores it: what the user picked, not what it resolves
/// to. `System` is a real answer here rather than an absence, because only the window knows the
/// operating system's theme, and it knows it at the moment the window opens.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum StartupTheme {
    Light,
    Dark,
    System,
}

impl StartupTheme {
    /// The setting a pushed string names, or `None` for anything else. The front end sends the
    /// same three values the setting page offers, so an unknown one is a caller that does not
    /// match this build rather than a case to guess at.
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "light" => Some(Self::Light),
            "dark" => Some(Self::Dark),
            "system" => Some(Self::System),
            _ => None,
        }
    }

    /// The value this setting is recorded as; the inverse of [`Self::parse`].
    pub(crate) fn encode(self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Dark => "dark",
            Self::System => "system",
        }
    }

    /// The color the window opens in. `system_dark` is the operating system's theme, which is what
    /// `System` resolves against and what the two explicit settings ignore.
    pub(crate) fn background(self, system_dark: bool) -> tauri::window::Color {
        match self {
            Self::Light => LIGHT_BACKGROUND,
            Self::Dark => DARK_BACKGROUND,
            Self::System if system_dark => DARK_BACKGROUND,
            Self::System => LIGHT_BACKGROUND,
        }
    }
}

/// Reads the recorded setting once, on the start-up path (`Store::get_preference_blocking`).
///
/// Everything that is not a recognized value leaves `System` in place: no record at all, a record
/// that is not a JSON string, and a store that cannot be read. The value only decides the color of
/// the frame before the document loads, so a store problem must not keep the window from opening,
/// and the operating system's theme is the answer that is never wrong for long.
pub(crate) fn load(store: &Store) -> StartupTheme {
    match store.get_preference_blocking(STARTUP_THEME_PREFERENCE) {
        Ok(Some(encoded)) => match serde_json::from_str::<String>(&encoded) {
            Ok(value) => match StartupTheme::parse(&value) {
                Some(theme) => theme,
                None => StartupTheme::System,
            },
            Err(_) => StartupTheme::System,
        },
        Ok(None) => StartupTheme::System,
        Err(error) => {
            crate::services::log::warn(&format!(
                "the recorded startup theme could not be read; the system theme applies: {}",
                error.message
            ));
            StartupTheme::System
        }
    }
}

/// The setting as it was last recorded, or `None` when nothing usable was.
///
/// [`load`] answers with `system` for every state it cannot read, because the window needs a color
/// either way; this answers with the absence itself. The difference matters to the document: it asks
/// only when its own storage holds no theme, and a shell that answered a guess would have that guess
/// written back into the storage as the user's choice.
pub(crate) fn recorded(store: &Store) -> Option<StartupTheme> {
    let encoded = store
        .get_preference_blocking(STARTUP_THEME_PREFERENCE)
        .ok()??;
    let value = serde_json::from_str::<String>(&encoded).ok()?;
    StartupTheme::parse(&value)
}

/// Records the setting the front end is drawing with, so the next start can paint the window
/// before the document exists.
///
/// The write is the whole call: nothing in this process reads the value again until the next start
/// reads it back from the store, so there is no in-memory copy that could disagree with the record.
pub(crate) async fn remember(store: &Store, theme: StartupTheme) -> IpcResult<()> {
    let encoded = serde_json::Value::String(theme.encode().to_owned()).to_string();
    store
        .set_preference(STARTUP_THEME_PREFERENCE, &encoded, store::now_ms())
        .await
}
