//! Thin commands over the terminal service: opening a shell, the input and resizes that go into
//! it, and the close that ends it.

use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use tauri::{ipc::Channel, AppHandle, Emitter, State};

use crate::errors::{IpcError, INVALID_INPUT};
use crate::models::{TerminalFrame, TerminalOpened, TerminalSummaryDto, TerminalUiEvent};
use crate::services::terminal::{READ_LIMIT, WRITE_LIMIT};
use crate::services::workspaces;
use crate::state::AppState;

/// Ceiling on one working directory. Windows' own long-path limit is the widest value that can
/// still name a directory this desktop could open.
const CWD_LIMIT: usize = 4096;

/// Ceiling on one terminal id. Every id is `terminal-<n>`, so anything longer is not one - and the
/// id is a session map key before it is anything else.
const TERMINAL_ID_LIMIT: usize = 64;

/// Ceiling on one base64 payload, before it is decoded. Base64 costs four characters per three
/// bytes, so this is [`WRITE_LIMIT`] plus the encoding's own slack: a payload inside it can still
/// decode past the limit, which the service itself refuses.
const WRITE_DATA_LIMIT: usize = WRITE_LIMIT * 4 / 3 + 8;

/// Start one shell in a workspace directory, streaming what it prints to `on_frame`.
///
/// **Every call starts a shell.** A conversation may own several terminals — the reader's own tabs —
/// so this command is "add a terminal", and the page is the one that decides when to add one. It used
/// to attach to whatever shell the conversation already had, which made the column's "new terminal"
/// menu item silently do nothing.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn terminal_open(
    app: AppHandle,
    state: State<'_, AppState>,
    cwd: String,
    owner_session_id: String,
    owner_session_file: String,
    workspace_key: String,
    show: Option<bool>,
    cols: u16,
    rows: u16,
    on_frame: Channel<TerminalFrame>,
) -> Result<TerminalOpened, IpcError> {
    if cwd.is_empty() || cwd.len() > CWD_LIMIT {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The terminal working directory is invalid.",
        ));
    }
    validate_id(&owner_session_id)?;
    let owner_session_file = validate_session_file(&state, &owner_session_file)?;
    if workspace_key.is_empty() || workspace_key.len() > CWD_LIMIT {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The terminal workspace is invalid.",
        ));
    }
    let (_, workspace_key) = workspaces::canonicalize_workspace(&workspace_key)?;
    // The frames are produced by the pty's own threads, so the channel is wrapped once here: a
    // page that closed the tab leaves a channel whose send fails, which is not the shell's problem.
    let sink: Arc<dyn Fn(TerminalFrame) -> bool + Send + Sync + 'static> =
        Arc::new(move |frame| on_frame.send(frame).is_ok());
    let service = state.terminal.clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.open(
            &cwd,
            &owner_session_id,
            &owner_session_file,
            &workspace_key,
            cols,
            rows,
            sink,
        )
    })
    .await
    .map_err(|_| IpcError::new("TERMINAL_TASK_FAILED", "Terminal task failed."))?
    .map_err(|message| IpcError::from_message("TERMINAL_OPEN_FAILED", message))
    .inspect(|opened| {
        // The page asked for this one and draws it itself; the broadcast exists for a shell the agent
        // started, which the page has to be told about.
        if show.unwrap_or(true) {
            let terminal = TerminalSummaryDto {
                id: opened.id.clone(),
                shell: opened.shell.clone(),
                cwd: opened.cwd.clone(),
                owner_session_id: opened.owner_session_id.clone(),
                owner_session_file: opened.owner_session_file.clone(),
                workspace_key: opened.workspace_key.clone(),
            };
            let _ = app.emit("omp:terminal", TerminalUiEvent::Open { terminal });
        }
    })
}
#[tauri::command]
pub(crate) async fn terminal_attach(
    state: State<'_, AppState>,
    id: String,
    on_frame: Channel<TerminalFrame>,
) -> Result<TerminalOpened, IpcError> {
    validate_id(&id)?;
    let sink: Arc<dyn Fn(TerminalFrame) -> bool + Send + Sync + 'static> =
        Arc::new(move |frame| on_frame.send(frame).is_ok());
    let service = state.terminal.clone();
    tauri::async_runtime::spawn_blocking(move || service.attach(&id, sink))
        .await
        .map_err(|_| IpcError::new("TERMINAL_TASK_FAILED", "Terminal task failed."))?
        .map_err(|message| IpcError::from_message("TERMINAL_ATTACH_FAILED", message))
}

/// The raw tail of one shell's output, base64-encoded: what a view writes back after its xterm lost
/// its buffer (a window that was put away). It reads the ring and subscribes to nothing, so a
/// repairing view still has exactly one live channel — a second subscription would deliver every
/// following frame twice.
#[tauri::command]
pub(crate) async fn terminal_tail(
    state: State<'_, AppState>,
    id: String,
    limit: Option<usize>,
) -> Result<String, IpcError> {
    validate_id(&id)?;
    let service = state.terminal.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        service.tail(&id, limit.unwrap_or(READ_LIMIT))
    })
    .await
    .map_err(|_| IpcError::new("TERMINAL_TASK_FAILED", "Terminal read task failed."))?
    .map_err(|message| IpcError::from_message("TERMINAL_READ_FAILED", message))?;
    Ok(STANDARD.encode(bytes))
}

/// List live shells for exactly one session file and workspace root.
#[tauri::command]
pub(crate) async fn terminal_list_live(
    state: State<'_, AppState>,
    owner_session_file: String,
    workspace_key: String,
) -> Result<Vec<TerminalSummaryDto>, IpcError> {
    let owner_session_file = validate_session_file(&state, &owner_session_file)?;
    if workspace_key.is_empty() || workspace_key.len() > CWD_LIMIT {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The terminal workspace is invalid.",
        ));
    }
    let (_, workspace_key) = workspaces::canonicalize_workspace(&workspace_key)?;
    let service = state.terminal.clone();
    tauri::async_runtime::spawn_blocking(move || {
        service
            .list_live_by_owner(&owner_session_file, &workspace_key)
            .into_iter()
            .map(|terminal| TerminalSummaryDto {
                id: terminal.id,
                shell: terminal.shell,
                cwd: terminal.cwd,
                owner_session_id: terminal.owner_session_id,
                owner_session_file: terminal.owner_session_file,
                workspace_key: terminal.workspace_key,
            })
            .collect()
    })
    .await
    .map_err(|_| IpcError::new("TERMINAL_TASK_FAILED", "Terminal task failed."))
}

/// Send one batch of input - a keystroke or a paste - into a shell, as base64.
#[tauri::command]
pub(crate) async fn terminal_write(
    state: State<'_, AppState>,
    id: String,
    data: String,
) -> Result<(), IpcError> {
    validate_id(&id)?;
    // Measured before decoding: a payload that could hold more than the limit is refused without
    // the allocation the decode would make for it.
    if data.len() > WRITE_DATA_LIMIT {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The terminal input is too large.",
        ));
    }
    let bytes = STANDARD
        .decode(&data)
        .map_err(|_| IpcError::new(INVALID_INPUT, "The terminal input is not base64."))?;
    let service = state.terminal.clone();
    tauri::async_runtime::spawn_blocking(move || service.write(&id, &bytes))
        .await
        .map_err(|_| IpcError::new("TERMINAL_TASK_FAILED", "Terminal task failed."))?
        .map_err(|message| IpcError::from_message("TERMINAL_OPERATION_FAILED", message))
}

/// Tell one shell's pty how much room the panel has, in character cells.
#[tauri::command]
pub(crate) async fn terminal_resize(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), IpcError> {
    validate_id(&id)?;
    let service = state.terminal.clone();
    tauri::async_runtime::spawn_blocking(move || service.resize(&id, cols, rows))
        .await
        .map_err(|_| IpcError::new("TERMINAL_TASK_FAILED", "Terminal task failed."))?
        .map_err(|message| IpcError::from_message("TERMINAL_OPERATION_FAILED", message))
}

/// Name one shell what the page's tab reads as (`PowerShell-2`).
///
/// The page owns the number — it is the conversation's, reused once a tab is closed — and this only
/// carries the name across, so the agent's own `list` shows the name the reader says out loud beside
/// the pty id it addresses.
#[tauri::command]
pub(crate) async fn terminal_label_set(
    state: State<'_, AppState>,
    id: String,
    label: String,
) -> Result<(), IpcError> {
    validate_id(&id)?;
    let service = state.terminal.clone();
    tauri::async_runtime::spawn_blocking(move || service.set_label(&id, &label))
        .await
        .map_err(|_| IpcError::new("TERMINAL_TASK_FAILED", "Terminal task failed."))?
        .map_err(|message| IpcError::from_message("TERMINAL_OPERATION_FAILED", message))
}

/// End one shell and release its pty.
#[tauri::command]
pub(crate) async fn terminal_close(state: State<'_, AppState>, id: String) -> Result<(), IpcError> {
    validate_id(&id)?;
    let service = state.terminal.clone();
    tauri::async_runtime::spawn_blocking(move || service.close(&id))
        .await
        .map_err(|_| IpcError::new("TERMINAL_TASK_FAILED", "Terminal task failed."))?
        .map_err(|message| IpcError::from_message("TERMINAL_OPERATION_FAILED", message))
}

/// End all shells owned by one conversation. An empty match is successful.
#[tauri::command]
pub(crate) async fn terminal_close_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), IpcError> {
    validate_id(&session_id)?;
    let service = state.terminal.clone();
    tauri::async_runtime::spawn_blocking(move || service.close_by_session(&session_id))
        .await
        .map_err(|_| IpcError::new("TERMINAL_TASK_FAILED", "Terminal task failed."))?;
    Ok(())
}

/// End all shells owned by one workspace. The workspace is canonicalized before matching.
#[tauri::command]
pub(crate) async fn terminal_close_workspace(
    state: State<'_, AppState>,
    workspace_key: String,
) -> Result<(), IpcError> {
    if workspace_key.is_empty() || workspace_key.len() > CWD_LIMIT {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The terminal workspace is invalid.",
        ));
    }
    let (_, workspace_key) = workspaces::canonicalize_workspace(&workspace_key)?;
    let service = state.terminal.clone();
    tauri::async_runtime::spawn_blocking(move || service.close_by_workspace(&workspace_key))
        .await
        .map_err(|_| IpcError::new("TERMINAL_TASK_FAILED", "Terminal task failed."))?;
    Ok(())
}

/// One session id as the page sent it: a short, non-empty token.
fn validate_id(id: &str) -> Result<(), IpcError> {
    if id.is_empty() || id.len() > TERMINAL_ID_LIMIT {
        return Err(IpcError::new(INVALID_INPUT, "The terminal id is invalid."));
    }
    Ok(())
}

/// The owner session file, as the page sent it.
///
/// A conversation nothing has been sent in has no transcript file yet — the engine writes it with
/// the first message — so its shells are keyed by an empty owner file and found by the workspace
/// key alone. A non-empty file must be a real file inside the host's session directory.
fn validate_session_file(state: &AppState, file: &str) -> Result<String, IpcError> {
    if file.is_empty() {
        return Ok(String::new());
    }
    if file.len() > CWD_LIMIT || !std::path::Path::new(file).is_absolute() {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The terminal owner session is invalid.",
        ));
    }
    let canonical = std::fs::canonicalize(file)
        .map_err(|_| IpcError::new(INVALID_INPUT, "The terminal owner session is invalid."))?;
    let root = state.paths.canonical_dir(&state.paths.host_sessions);
    if !crate::services::paths::is_within(&root, &canonical) || canonical == root {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The terminal owner session is invalid.",
        ));
    }
    Ok(crate::services::paths::plain_path(
        &canonical.to_string_lossy(),
    ))
}
