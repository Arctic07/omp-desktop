//! Thin commands over the diagnostics service: the log overview, opening the log directory, the two
//! clears, and the one line a page writes itself.

use tauri::State;

use crate::errors::{IpcError, IpcResult, DIAGNOSTICS_TASK_FAILED};
use crate::models::{ClearOutcome, LogsOverview, OpenLogsResult};
use crate::services::diagnostics;
use crate::services::runtime::reclaim;
use crate::state::AppState;

/// The log directory, the files in it and what the caches weigh.
///
/// Off the async runtime: measuring a cache means walking tens of thousands of small files, which
/// is exactly the work that would hold up every other command if it ran on it.
#[tauri::command]
pub(crate) async fn logs_overview(state: State<'_, AppState>) -> Result<LogsOverview, IpcError> {
    let paths = state.paths.clone();
    tauri::async_runtime::spawn_blocking(move || diagnostics::overview(&paths))
        .await
        .map_err(|_| IpcError::new(DIAGNOSTICS_TASK_FAILED, "Logs task failed."))
}

/// Opens one log directory in this machine's file manager; `opened` is false when the shell would
/// not take it, which is an answer rather than an error.
///
/// `scope` names which directory: `app` (the default, and what a page that sends nothing gets) or
/// `engine`. The two are separate because the engine's own logs are its directory
/// (`DataPaths::engine_logs`), not a subdirectory of this application's.
#[tauri::command]
pub(crate) async fn logs_open_directory(
    state: State<'_, AppState>,
    scope: Option<String>,
) -> IpcResult<OpenLogsResult> {
    let scope = diagnostics::OpenScope::named(scope.as_deref())?;
    let paths = state.paths.clone();
    tauri::async_runtime::spawn_blocking(move || diagnostics::open_directory(&paths, scope))
        .await
        .map_err(|_| IpcError::new(DIAGNOSTICS_TASK_FAILED, "Logs task failed."))?
}

/// Empties the logs directory, keeping the file this run is writing.
#[tauri::command]
pub(crate) async fn logs_clear(state: State<'_, AppState>) -> IpcResult<ClearOutcome> {
    let paths = state.paths.clone();
    tauri::async_runtime::spawn_blocking(move || diagnostics::clear_logs(&paths))
        .await
        .map_err(|_| IpcError::new(DIAGNOSTICS_TASK_FAILED, "Logs task failed."))
}

/// Empties the caches this application owns, and nothing the user set up.
#[tauri::command]
pub(crate) async fn caches_clear(state: State<'_, AppState>) -> IpcResult<ClearOutcome> {
    let paths = state.paths.clone();
    // The session index is a cache too, and it is held open by this process: it is cleared through
    // its handle rather than deleted as a file.
    let index = std::sync::Arc::clone(&state.session_index);
    let mut outcome = tauri::async_runtime::spawn_blocking(move || {
        diagnostics::clear_caches(&paths, Some(&index))
    })
    .await
    .map_err(|_| IpcError::new(DIAGNOSTICS_TASK_FAILED, "Caches task failed."))?;
    // Then the engine's own tree, through the protocol: it is the only process allowed to write
    // there (§5.3), and its caches are the largest thing this setting can free. A host that is not
    // running answers nothing, which leaves the file side of this clear exactly as it was.
    let engine = reclaim::reclaim(&state.runtime).await;
    outcome.engine_freed_bytes = engine.freed_bytes;
    outcome.engine_skipped_bytes = engine.skipped_bytes;
    // Then the toolchain caches the host's children filled: they are this application's own
    // directories under the pinned home, but a clear is where a reader gets disk back, so the ceiling
    // the periodic pass keeps is applied now - over budget, oldest write first - and the bytes fold
    // into the same number the page prints (`services::cache_budget`).
    let budget_paths = state.paths.clone();
    let toolchain = tauri::async_runtime::spawn_blocking(move || {
        crate::services::cache_budget::sweep_and_report(&budget_paths)
    })
    .await
    .unwrap_or_default();
    outcome.freed_bytes = outcome
        .freed_bytes
        .saturating_add(engine.freed_bytes)
        .saturating_add(toolchain);
    Ok(outcome)
}

/// One line a page asked to have written.
///
/// Deliberately not handed to `spawn_blocking`: one append is microseconds, and moving it to the
/// blocking pool would cost more than the write itself.
#[tauri::command]
pub(crate) async fn logs_write(level: String, message: String) -> Result<(), IpcError> {
    diagnostics::write_frontend_line(&level, &message)
}
