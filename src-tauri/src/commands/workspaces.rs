use tauri::State;

use crate::errors::{IpcError, IpcResult, INVALID_INPUT, STORE_UNAVAILABLE};
use crate::models::agent::WorkspaceSummary;
use crate::models::store::ProjectRow;
use crate::services::runtime::session;
use crate::services::{session_index, store, workspaces};
use crate::state::AppState;

const NAME_LIMIT_CHARS: usize = 120;

fn blocking_task_failed() -> IpcError {
    IpcError::new(STORE_UNAVAILABLE, "The background task failed.")
}

async fn summary(state: &AppState, project: ProjectRow) -> IpcResult<WorkspaceSummary> {
    let sessions_root = state.paths.host_sessions.clone();
    let cache = state.session_index.clone();
    let root_path = project.root_path.clone();
    let session_count = tauri::async_runtime::spawn_blocking(move || {
        session_index::list_sessions(&sessions_root, &root_path, &cache).len()
    })
    .await
    .map_err(|_| blocking_task_failed())?;
    let missing = workspaces::is_missing(&project.root_path);
    Ok(WorkspaceSummary {
        id: project.id,
        root_path: project.root_path,
        name: project.name,
        pinned: project.pinned,
        missing,
        last_opened_at: project.last_opened_at,
        session_count,
    })
}

#[tauri::command]
pub(crate) async fn workspace_list(
    state: State<'_, AppState>,
) -> Result<Vec<WorkspaceSummary>, IpcError> {
    let projects = state.store.list_projects().await?;
    let mut summaries = Vec::with_capacity(projects.len());
    for project in projects {
        summaries.push(summary(&state, project).await?);
    }
    Ok(summaries)
}

#[tauri::command]
pub(crate) async fn workspace_add(
    state: State<'_, AppState>,
    root_path: String,
) -> Result<WorkspaceSummary, IpcError> {
    let input = root_path.trim().to_owned();
    if input.is_empty() {
        return Err(IpcError::new(
            INVALID_INPUT,
            "A workspace directory is required.",
        ));
    }
    let (root_key, canonical) =
        tauri::async_runtime::spawn_blocking(move || workspaces::canonicalize_workspace(&input))
            .await
            .map_err(|_| blocking_task_failed())??;
    let name = workspaces::workspace_name(&canonical);
    let project = state
        .store
        .upsert_project(&root_key, &canonical, &name, store::now_ms())
        .await?;
    summary(&state, project).await
}

#[tauri::command]
pub(crate) async fn workspace_rename(
    state: State<'_, AppState>,
    workspace_id: i64,
    name: String,
) -> Result<WorkspaceSummary, IpcError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > NAME_LIMIT_CHARS {
        return Err(IpcError::new(
            INVALID_INPUT,
            "A workspace name between 1 and 120 characters is required.",
        ));
    }
    let project = state.store.rename_project(workspace_id, name).await?;
    summary(&state, project).await
}

/// Soft delete: the registry row is hidden and nothing on disk is touched, but the conversations
/// this workspace was running are stopped and handed back first.
///
/// No process belongs to a workspace any more - one host serves all of them and a session names its
/// own working directory - so removal has no process to stop. What it does have is work: a turn
/// (or a detached batch) of one of this workspace's conversations can be running right now, and a
/// workspace that disappears from the list while its work goes on underneath would leave the user
/// watching nothing. Stopping it, and closing the host's record of it, is this command's first
/// half; the conversations themselves stay on disk and come back with the folder.
///
/// The removal goes on when a stop fails - the user asked for the workspace, not for a guarantee
/// about a session it can no longer show (see `session::release_workspace`).
#[tauri::command]
pub(crate) async fn workspace_remove(
    state: State<'_, AppState>,
    workspace_id: i64,
) -> Result<(), IpcError> {
    let project = state.store.get_project(workspace_id).await?;
    let sessions_root = state.paths.host_sessions.clone();
    let cache = state.session_index.clone();
    let root_path = project.root_path.clone();
    let session_ids = tauri::async_runtime::spawn_blocking(move || {
        session_index::list_sessions(&sessions_root, &root_path, &cache)
            .into_iter()
            .map(|session| session.id)
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|_| blocking_task_failed())?;
    session::release_workspace(&state.runtime, &session_ids).await;
    let workspace_key = project.root_path.clone();
    let terminal = state.terminal.clone();
    tauri::async_runtime::spawn_blocking(move || terminal.close_by_workspace(&workspace_key))
        .await
        .map_err(|_| blocking_task_failed())?;
    state
        .store
        .remove_project(workspace_id, store::now_ms())
        .await
}

#[tauri::command]
pub(crate) async fn workspace_touch(
    state: State<'_, AppState>,
    workspace_id: i64,
) -> Result<(), IpcError> {
    state
        .store
        .touch_project(workspace_id, store::now_ms())
        .await
}

/// How many workspaces one reorder may name: the rail's own list, and a bound on what a webview
/// can ask the store to walk.
const REORDER_LIMIT: usize = 500;

/// Rewrites the order the reader dragged the rail's workspaces into.
///
/// The list is the whole arrangement, not a moved row: each named workspace's position is its
/// index, and one the caller does not name keeps the order it had. An empty list is refused rather
/// than written, because it would say nothing about any workspace while reading as an arrangement.
#[tauri::command]
pub(crate) async fn workspace_reorder(
    state: State<'_, AppState>,
    workspace_ids: Vec<i64>,
) -> Result<(), IpcError> {
    if workspace_ids.is_empty() || workspace_ids.len() > REORDER_LIMIT {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The workspace order must name between 1 and 500 workspaces.",
        ));
    }
    state.store.reorder_projects(&workspace_ids).await
}
