//! The residency preference's two commands, and the language push for the tray's own menu.
//!
//! The preference is read at the moment a window is closed, so neither command touches the tray:
//! turning the setting on or off changes what the next close request does, not what is on screen
//! now.

use tauri::State;

use crate::errors::{IpcError, INVALID_INPUT};
use crate::models::presence::PresenceSettings;
use crate::services::presence::{apply_tray_language, Language};
use crate::state::AppState;

/// The residency preference as the settings page sees it: what this process holds, which the
/// start-up path loaded from the store.
#[tauri::command]
pub(crate) async fn presence_get(state: State<'_, AppState>) -> Result<PresenceSettings, IpcError> {
    Ok(settings(&state))
}

/// Records whether closing the window leaves the application in the tray, and answers with what
/// was recorded. The store is written first and memory changes only when that write landed
/// (`remember_close_to_tray`), so a failed call leaves the previous answer in place.
#[tauri::command]
pub(crate) async fn presence_set(
    state: State<'_, AppState>,
    close_to_tray: bool,
) -> Result<PresenceSettings, IpcError> {
    state
        .presence
        .remember_close_to_tray(&state.store, close_to_tray)
        .await?;
    Ok(settings(&state))
}

/// Sets the language of the tray's own menu. The system's language is where it starts; the window
/// pushes the language it is drawing in both at start-up and on every switch, so the tray and the
/// window never disagree.
#[tauri::command]
pub(crate) async fn tray_language_set(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    language: String,
) -> Result<(), IpcError> {
    let Some(language) = Language::parse(&language) else {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The tray language must be either \"zh\" or \"en\".",
        ));
    };
    state.presence.set_language(language);
    apply_tray_language(&app, &state.presence);
    Ok(())
}

fn settings(state: &AppState) -> PresenceSettings {
    PresenceSettings {
        close_to_tray: state.presence.close_to_tray(),
    }
}

/// The window's own document saying the start-up shell in `index.html` has been parsed, which is
/// what raises the window (`services::presence::show_main_window`).
///
/// The start-up path leaves the window hidden and arms a ceiling for the run where this never
/// arrives, so the command has nothing to answer: a failure here cannot leave the application
/// without a window, and the document has nothing to undo.
///
/// Two documents call this — the shell in `index.html`, one painted frame after it is parsed, and
/// `src/main.tsx` as its first act — and the desktop's own ceiling is the third path that shows the
/// window without it. The line below is what tells the three apart in `app.log`: its presence means
/// the window came up on the shell, its absence beside
/// `the window was shown by the start-up ceiling` means a document never got that far. It is written
/// by the first caller only (the window is visible by the second), so a start is one line.
#[tauri::command]
pub(crate) async fn main_window_ready(app: tauri::AppHandle) {
    let already_visible = crate::services::presence::main_window(&app)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    crate::services::presence::show_main_window(&app);
    if !already_visible {
        crate::services::log::info("the window was raised by its document");
    }
}

/// Marks the taskbar button of a turn that finished while the reader was elsewhere.
///
/// "Elsewhere" is the front end's fact — the conversation on screen and whether the window has the
/// focus are its own state — so it asks exactly when the ending was not in front of the reader: a
/// completion in another conversation or another application. An ending it watched, and a stop the
/// reader pressed themselves, never ask (2026-10-21).
#[tauri::command]
pub(crate) async fn flash_taskbar(app: tauri::AppHandle) {
    crate::services::presence::flash_finished(&app);
}

/// Tells the OS whether this application is in front.
///
/// The front end owns "in front" (focus and page visibility); this applies it: in the background,
/// this process and the engine host drop to below-normal priority with EcoQoS execution-speed
/// throttling, so a game or a build keeps the machine while agents still make progress. Failures are
/// dropped in `process_tuning` — an OS that refuses the hint has nothing to correct on screen.
#[tauri::command]
pub(crate) fn app_background(state: State<'_, AppState>, background: bool) {
    let host_pid = state.runtime.snapshot().pid;
    crate::services::process_tuning::set_background(background, host_pid);
}
