//! Thin commands over the built-in browser (`services::browser`): what the React chrome and the
//! work panel ask for, and nothing more.
//!
//! The agent's own lane does not go through these commands: it arrives as a host request
//! (`services::runtime::host::browser`) and calls the same service directly, so a page command
//! surface cannot be used to reach another conversation's page.
//!
//! Every one of these is `#[tauri::command(async)]` although its body is synchronous: the service
//! reaches into WebView2, those calls are marshalled back to the main thread by wry, and a command
//! body that is not `async` would wait for them *on* the main thread - which is a frozen window
//! whenever the guest's browser process is slow to answer (`rules.md#main-thread-budget`).

use tauri::State;

use crate::errors::{IpcError, IpcResult, BROWSER_UNAVAILABLE, INVALID_INPUT};
use crate::services::browser::{BrowserOpened, BrowserRect, BrowserService, BrowserState};
use crate::state::AppState;

/// One id or address this boundary accepts. Empty is refused; the service applies its own policy.
fn text(value: Option<String>, field: &str) -> IpcResult<Option<String>> {
    match value {
        None => Ok(None),
        Some(value) => {
            let trimmed = value.trim().to_owned();
            if trimmed.is_empty() {
                return Err(IpcError::from_message(
                    INVALID_INPUT,
                    format!("{field} must not be empty."),
                ));
            }
            Ok(Some(trimmed))
        }
    }
}

fn service(state: &AppState) -> IpcResult<&std::sync::Arc<BrowserService>> {
    state.browser.as_ref().ok_or_else(|| {
        IpcError::new(
            BROWSER_UNAVAILABLE,
            "The built-in browser is unavailable in this window.",
        )
    })
}

/// Open a Browser tab for one conversation. A preview gets a tab of its own; a plain open reuses
/// the conversation's default tab.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn browser_open_tab(
    state: State<'_, AppState>,
    session_id: String,
    workspace_root: Option<String>,
    url: Option<String>,
    path: Option<String>,
    preview: Option<bool>,
) -> Result<BrowserOpened, IpcError> {
    let session_id = text(Some(session_id), "sessionId")?.unwrap_or_default();
    service(&state)?
        .open_tab(
            &session_id,
            workspace_root.as_deref(),
            text(url, "url")?.as_deref(),
            text(path, "path")?.as_deref(),
            preview == Some(true),
        )
        .await
}

/// Navigate one conversation's page. Without a tab, the service uses the connected/selected tab.
#[tauri::command]
pub(crate) async fn browser_navigate(
    state: State<'_, AppState>,
    session_id: String,
    tab_id: Option<String>,
    workspace_root: Option<String>,
    url: Option<String>,
    path: Option<String>,
) -> Result<Option<BrowserState>, IpcError> {
    let session_id = text(Some(session_id), "sessionId")?.unwrap_or_default();
    service(&state)?
        .navigate(
            &session_id,
            text(tab_id, "tabId")?.as_deref(),
            workspace_root.as_deref(),
            text(url, "url")?.as_deref(),
            text(path, "path")?.as_deref(),
        )
        .await
}

/// Tell the browser which page the mounted chrome is showing.
#[tauri::command(async)]
pub(crate) fn browser_show_tab(
    state: State<'_, AppState>,
    session_id: Option<String>,
    tab_id: Option<String>,
    url: Option<String>,
    workspace_root: Option<String>,
    seq: Option<u64>,
) -> Result<(), IpcError> {
    service(&state)?.show_tab(
        session_id.as_deref(),
        tab_id.as_deref(),
        url.as_deref(),
        workspace_root.as_deref(),
        seq,
    );
    Ok(())
}

/// The hole the React chrome measured, in logical pixels.
#[tauri::command(async)]
pub(crate) fn browser_set_bounds(
    state: State<'_, AppState>,
    session_id: String,
    tab_id: String,
    rect: BrowserRect,
    seq: Option<u64>,
) -> Result<(), IpcError> {
    let session_id = text(Some(session_id), "sessionId")?.unwrap_or_default();
    let tab_id = text(Some(tab_id), "tabId")?.unwrap_or_default();
    service(&state)?.set_bounds(&session_id, &tab_id, rect, seq);
    Ok(())
}

/// Whether the page is on screen. The React chrome hides it under a blocking overlay.
#[tauri::command(async)]
pub(crate) fn browser_set_visible(
    state: State<'_, AppState>,
    session_id: String,
    tab_id: String,
    visible: bool,
    seq: Option<u64>,
) -> Result<(), IpcError> {
    let session_id = text(Some(session_id), "sessionId")?.unwrap_or_default();
    let tab_id = text(Some(tab_id), "tabId")?.unwrap_or_default();
    service(&state)?.set_visible(&session_id, &tab_id, visible, seq);
    Ok(())
}

/// Back, forward, reload or stop.
#[tauri::command(async)]
pub(crate) fn browser_action(
    state: State<'_, AppState>,
    session_id: String,
    tab_id: String,
    action: String,
) -> Result<(), IpcError> {
    let session_id = text(Some(session_id), "sessionId")?.unwrap_or_default();
    let tab_id = text(Some(tab_id), "tabId")?.unwrap_or_default();
    service(&state)?.action(&session_id, &tab_id, &action)
}

/// One page's current state.
#[tauri::command(async)]
pub(crate) fn browser_get_state(
    state: State<'_, AppState>,
    session_id: String,
    tab_id: String,
) -> Result<Option<BrowserState>, IpcError> {
    let session_id = text(Some(session_id), "sessionId")?.unwrap_or_default();
    let tab_id = text(Some(tab_id), "tabId")?.unwrap_or_default();
    Ok(service(&state)?.state(&session_id, &tab_id))
}

/// Every page one conversation holds, for rehydrating its tabs after a renderer reload.
#[tauri::command(async)]
pub(crate) fn browser_pages(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<BrowserState>, IpcError> {
    let session_id = text(Some(session_id), "sessionId")?.unwrap_or_default();
    Ok(service(&state)?.pages(&session_id))
}

/// Hand the current page to the machine's own browser (or default file handler).
#[tauri::command(async)]
pub(crate) fn browser_open_external(
    state: State<'_, AppState>,
    session_id: String,
    tab_id: String,
) -> Result<(), IpcError> {
    let session_id = text(Some(session_id), "sessionId")?.unwrap_or_default();
    let tab_id = text(Some(tab_id), "tabId")?.unwrap_or_default();
    service(&state)?.open_external(&session_id, &tab_id)
}

/// Close one tab and destroy its guest.
#[tauri::command(async)]
pub(crate) fn browser_close_tab(
    state: State<'_, AppState>,
    session_id: String,
    tab_id: String,
) -> Result<(), IpcError> {
    let session_id = text(Some(session_id), "sessionId")?.unwrap_or_default();
    let tab_id = text(Some(tab_id), "tabId")?.unwrap_or_default();
    service(&state)?.close_tab(&session_id, &tab_id);
    Ok(())
}

/// Close every page one conversation owns.
#[tauri::command(async)]
pub(crate) fn browser_close_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), IpcError> {
    let session_id = text(Some(session_id), "sessionId")?.unwrap_or_default();
    service(&state)?.close_session(&session_id);
    Ok(())
}
