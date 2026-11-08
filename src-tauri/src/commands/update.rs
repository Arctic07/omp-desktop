//! The update commands: read the current status, ask the feed, install what it announced, and
//! restart into it.
//!
//! The status is the whole answer, including a failed check: a feed that cannot be reached is a
//! state the About page draws, not a rejected call the caller has to translate.

use std::sync::Arc;

use tauri::{AppHandle, State, Webview};

use crate::errors::{IpcError, INVALID_INPUT, UPDATE_NOT_READY};
use crate::models::update::UpdateStatus;
use crate::services::updater::ready_to_restart;
use crate::state::AppState;

/// The last status this process published. A reader that subscribed after a transition reads the
/// same value the event carried.
#[tauri::command]
pub(crate) fn update_status(
    webview: Webview,
    state: State<'_, AppState>,
) -> Result<UpdateStatus, IpcError> {
    main_window_only(&webview)?;
    Ok(state.updater.status())
}

/// Ask the fixed feed whether a newer release exists.
#[tauri::command]
pub(crate) async fn update_check(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<UpdateStatus, IpcError> {
    main_window_only(&webview)?;
    Ok(state.updater.check(&app).await)
}

/// Download and install the announced release. On Windows this process exits into the installer and
/// the command never answers; on macOS and Linux it answers `ready` and waits for `update_relaunch`.
#[tauri::command]
pub(crate) async fn update_install(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<UpdateStatus, IpcError> {
    main_window_only(&webview)?;
    Ok(Arc::clone(&state.updater).install(&app).await)
}

/// Restart into a downloaded release.
///
/// Refused unless an update is actually waiting: restarting the application is otherwise a page's
/// power over a window it did not open, and the one state that earns it is the one the reader
/// pressed for.
#[tauri::command]
pub(crate) async fn update_relaunch(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), IpcError> {
    main_window_only(&webview)?;
    if !ready_to_restart(&state.updater.status()) {
        return Err(IpcError::new(
            UPDATE_NOT_READY,
            "No downloaded update is waiting to be installed.",
        ));
    }
    app.restart()
}

/// The update commands belong to the window's own document.
///
/// A plugin page is a different webview: it may read engine state through its own bridge, but it
/// does not get to ask this process to install a release or restart the application. The check is
/// made here, where the act executes, rather than by hiding a control.
fn main_window_only(webview: &Webview) -> Result<(), IpcError> {
    if webview.label() == crate::services::presence::MAIN_WINDOW {
        return Ok(());
    }
    Err(IpcError::new(
        INVALID_INPUT,
        "The update commands belong to the main window.",
    ))
}
