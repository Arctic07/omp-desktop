//! The one command behind the window's opening color.
//!
//! The preference the user sees is the document's own, kept in the webview's storage; this command
//! only receives a copy of it so the next start can paint the window before that document exists
//! (see `services::appearance`). A write that fails is reported to the caller, which discards it:
//! the only consequence is that the next start falls back to the operating system's theme for the
//! one frame before the document loads.

use tauri::{AppHandle, State};

use crate::errors::{IpcError, INVALID_INPUT};
use crate::services::appearance::{self, StartupTheme};
use crate::services::{log, presence};
use crate::state::AppState;

/// The setting the window was last painted from, for a document whose own storage has none.
///
/// The document's storage is the copy the settings page writes; this record is the copy the shell
/// keeps for the frame before that document exists. They are normally the same value and the
/// document never asks. They stop being the same value when the webview's storage is lost - a
/// profile that was evicted, or a storage database whose last write was interrupted, which LevelDB
/// recovers by dropping everything after the broken record. In that case the document reads nothing,
/// falls back to `defaultTheme`, and would show a theme the user never picked; the record here is
/// the only surviving copy of the choice, so it is handed back instead of that guess.
///
/// `None` is an answer, not a failure: nothing was ever recorded, which is what a first run looks
/// like, and the document's own default is then the only thing to draw.
#[tauri::command]
pub(crate) async fn startup_theme_get(
    state: State<'_, AppState>,
) -> Result<Option<String>, IpcError> {
    Ok(appearance::recorded(&state.store).map(|theme| theme.encode().to_owned()))
}

/// Records the appearance setting the window is drawing with. The caller sends the setting itself,
/// not a color, because `system` has to be resolved against the operating system's theme when the
/// window opens, which is later than a color could be recorded.
///
/// Both surfaces are repainted in the same call, through the webview window: the window's brush and
/// WebView2's own default, which is what the client area shows before the document's first frame.
/// A theme change is therefore not left to the next start. Nothing here waits on the record: the
/// setting is stored first, and a store write that failed leaves the surface as it was.
#[tauri::command]
pub(crate) async fn startup_theme_set(
    app: AppHandle,
    state: State<'_, AppState>,
    theme: String,
) -> Result<(), IpcError> {
    let Some(theme) = StartupTheme::parse(&theme) else {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The theme must be \"light\", \"dark\" or \"system\".",
        ));
    };
    appearance::remember(&state.store, theme).await?;
    // One line per record, because the record is the only thing the next start can read: it says
    // which theme the window will open in, and the document's own storage is invisible from here.
    // A report of a start that opened in the wrong theme is answered from this line.
    log::info(&format!(
        "the start-up theme was recorded: {}",
        theme.encode()
    ));
    let color = match presence::main_window(&app) {
        Some(window) => theme.background(appearance::system_dark(&window)),
        // No window means no operating system theme to ask: the explicit settings still answer, and
        // `system` falls back to the dark surface this application is built around.
        None => theme.background(true),
    };
    if let Some(window) = presence::main_webview_window(&app) {
        if let Err(error) = window.set_background_color(Some(color)) {
            log::warn(&format!(
                "repainting the window background after a theme change failed: {error}"
            ));
        }
    }
    Ok(())
}
