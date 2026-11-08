use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::errors::{IpcError, INVALID_INPUT};
use crate::models::{
    FileReadResult, ListWorkspaceEntriesResult, WorkspacePathSearchResult, WorkspaceSearchResult,
};
use crate::services::{workspace, workspace_paths, workspace_search, workspaces};
use crate::state::AppState;

fn workspace_error(message: String) -> IpcError {
    IpcError::from_message("WORKSPACE_OPERATION_FAILED", message)
}

/// The refusal for a root the watch will not follow. It names no path: which directory the caller
/// meant is the caller's own, and an IPC answer carries no absolute path (`rules.md#tauri-ipc-and-permissions`).
fn invalid_workspace_root() -> IpcError {
    IpcError::new(
        INVALID_INPUT,
        "The workspace is not one this application can watch.",
    )
}

#[tauri::command]
pub(crate) async fn current_working_directory() -> Result<String, IpcError> {
    tauri::async_runtime::spawn_blocking(workspace::current_working_directory)
        .await
        .map_err(|_| IpcError::new("WORKSPACE_TASK_FAILED", "Workspace task failed."))?
        .map_err(workspace_error)
}

#[tauri::command]
pub(crate) async fn search_workspace_files(
    root: String,
    query: String,
    max_results: Option<usize>,
) -> Result<WorkspaceSearchResult, IpcError> {
    workspace_search::search_workspace_files(root, query, max_results)
        .await
        .map_err(workspace_error)
}

/// Path completion for the composer's `@` picker: workspace files whose path matches the query.
/// Contents are never searched, so a file that merely mentions the text is not a candidate.
#[tauri::command]
pub(crate) async fn search_workspace_paths(
    root: String,
    query: String,
    max_results: Option<usize>,
) -> Result<WorkspacePathSearchResult, IpcError> {
    workspace_paths::search_workspace_paths(root, query, max_results)
        .await
        .map_err(workspace_error)
}

#[tauri::command]
pub(crate) async fn list_workspace_entries(
    root: String,
    path: String,
) -> Result<ListWorkspaceEntriesResult, IpcError> {
    tauri::async_runtime::spawn_blocking(move || workspace::list_workspace_entries(root, path))
        .await
        .map_err(|_| IpcError::new("WORKSPACE_TASK_FAILED", "Workspace listing task failed."))?
        .map_err(workspace_error)
}

#[tauri::command]
pub(crate) async fn read_workspace_file(
    root: String,
    path: String,
) -> Result<FileReadResult, IpcError> {
    tauri::async_runtime::spawn_blocking(move || workspace::read_workspace_file(root, path))
        .await
        .map_err(|_| IpcError::new("WORKSPACE_TASK_FAILED", "Workspace read task failed."))?
        .map_err(workspace_error)
}

/// Read one file the page named by an absolute path, anywhere on this machine: a path that is not
/// under any workspace root is what this is for, so no root is asked for.
#[tauri::command]
pub(crate) async fn read_external_file(path: String) -> Result<FileReadResult, IpcError> {
    tauri::async_runtime::spawn_blocking(move || workspace::read_external_file(path))
        .await
        .map_err(|_| IpcError::new("WORKSPACE_TASK_FAILED", "Workspace read task failed."))?
        .map_err(workspace_error)
}

/// Reveal one entry of a workspace in this machine's own file manager.
///
/// `path` is the row's own, workspace-relative; the service re-resolves it inside `root` before
/// anything is spawned, so a tree row can name neither a path outside the workspace the reader is
/// looking at nor one that workspace does not own. A file is selected in its folder and a directory
/// is opened — the platform's own "show in folder".
#[tauri::command]
pub(crate) async fn reveal_workspace_entry(root: String, path: String) -> Result<bool, IpcError> {
    tauri::async_runtime::spawn_blocking(move || workspace::reveal_workspace_file(root, path))
        .await
        .map_err(|_| IpcError::new("WORKSPACE_TASK_FAILED", "Workspace reveal task failed."))?
        .map(|result| result.ok)
        .map_err(workspace_error)
}

/// Open one directory the page named in this machine's own file manager.
///
/// The path is the page's own: the absolute machine path behind a row, whether it was joined from a
/// workspace root or names something outside every root. The answer decides where the click goes -
/// `true` for a directory the file manager opened, `false` for everything else, which is the file
/// panel's preview. Nothing is an error here: a path this machine would not open as a directory is
/// a complete answer, and the preview is the surface that says why.
#[tauri::command]
pub(crate) async fn open_directory_in_file_manager(path: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || workspace::open_directory_in_file_manager(path))
        .await
        .unwrap_or(false)
}

#[tauri::command]
pub(crate) async fn write_workspace_file(
    root: String,
    path: String,
    content: String,
) -> Result<(), IpcError> {
    tauri::async_runtime::spawn_blocking(move || {
        workspace::write_workspace_file(root, path, content)
    })
    .await
    .map_err(|_| IpcError::new("WORKSPACE_TASK_FAILED", "Workspace write task failed."))?
    .map_err(workspace_error)
}

/// Points the workspace watch at the workspace the shell is showing, or stops it with `null`.
///
/// The root is validated here, at the boundary, before anything is watched: it has to be an absolute
/// directory this machine has, and it has to be a workspace the store already knows - the frontend's
/// word for a path is never taken on its own (`rules.md#security`). The switch itself runs on a blocking
/// thread because ending the previous watch joins its thread, which must not happen on an async
/// worker.
#[tauri::command]
pub(crate) async fn set_workspace_watch(
    state: tauri::State<'_, AppState>,
    root: Option<String>,
) -> Result<(), IpcError> {
    let watch = Arc::clone(&state.workspace_watch);
    let Some(root) = root else {
        return tauri::async_runtime::spawn_blocking(move || watch.set(None))
            .await
            .map_err(|_| IpcError::new("WORKSPACE_TASK_FAILED", "Workspace watch task failed."))?
            .map_err(workspace_error);
    };
    let trimmed = root.trim();
    if trimmed.is_empty() || !Path::new(trimmed).is_absolute() {
        return Err(invalid_workspace_root());
    }
    let requested = trimmed.to_owned();
    // The registered roots are the only workspaces a watch may follow, and they come from the same
    // accessor `workspace_list` reads. Both sides are canonicalized the same way, so comparing the
    // strings compares the directories.
    let registered = state
        .store
        .list_projects()
        .await?
        .into_iter()
        .map(|project| project.root_path)
        .collect::<Vec<String>>();
    tauri::async_runtime::spawn_blocking(move || {
        let (canonical, _) =
            workspaces::canonicalize_workspace(&requested).map_err(|_| invalid_workspace_root())?;
        if !registered.contains(&canonical) {
            return Err(invalid_workspace_root());
        }
        watch
            .set(Some(PathBuf::from(canonical)))
            .map_err(workspace_error)
    })
    .await
    .map_err(|_| IpcError::new("WORKSPACE_TASK_FAILED", "Workspace watch task failed."))?
}
