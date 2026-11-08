use crate::errors::IpcError;
use crate::models::{WorkspaceBranches, WorkspaceReview, WorkspaceReviewDelta};
use crate::services::git;
use crate::state::AppState;

fn git_error(message: String) -> IpcError {
    IpcError::from_message("GIT_OPERATION_FAILED", message)
}

/// One commit message, drafted by the engine's own commit pipeline from this repository's staged
/// tree.
///
/// Async rather than `spawn_blocking`: the work is a model call the host performs, and the host's
/// own runtime is what waits on it. An empty index is the engine's refusal, worded by the engine,
/// and a repository with nothing staged is a state the reader can fix rather than a failure.
#[tauri::command]
pub(crate) async fn draft_commit_message(
    state: tauri::State<'_, AppState>,
    root: String,
) -> Result<String, IpcError> {
    crate::services::engine::commit_message(&state.runtime, &root).await
}

#[tauri::command]
pub(crate) async fn get_workspace_branches(
    root: String,
) -> Result<Option<WorkspaceBranches>, IpcError> {
    tauri::async_runtime::spawn_blocking(move || git::get_workspace_branches(root))
        .await
        .map_err(|_| IpcError::new("GIT_TASK_FAILED", "Git branch task failed."))?
        .map_err(git_error)
}

#[tauri::command]
pub(crate) async fn checkout_workspace_branch(
    root: String,
    branch: String,
) -> Result<(), IpcError> {
    tauri::async_runtime::spawn_blocking(move || git::checkout_workspace_branch(root, branch))
        .await
        .map_err(|_| IpcError::new("GIT_TASK_FAILED", "Git checkout task failed."))?
        .map_err(git_error)
}

#[tauri::command]
pub(crate) async fn get_workspace_review(root: String) -> Result<WorkspaceReview, IpcError> {
    tauri::async_runtime::spawn_blocking(move || git::get_workspace_review(root))
        .await
        .map_err(|_| IpcError::new("GIT_TASK_FAILED", "Git review task failed."))?
        .map_err(git_error)
}

#[tauri::command]
pub(crate) async fn stage_workspace_files(
    root: String,
    paths: Vec<String>,
) -> Result<WorkspaceReviewDelta, IpcError> {
    tauri::async_runtime::spawn_blocking(move || git::stage_workspace_files(root, paths))
        .await
        .map_err(|_| IpcError::new("GIT_TASK_FAILED", "Git stage task failed."))?
        .map_err(git_error)
}

#[tauri::command]
pub(crate) async fn unstage_workspace_files(
    root: String,
    paths: Vec<String>,
) -> Result<WorkspaceReviewDelta, IpcError> {
    tauri::async_runtime::spawn_blocking(move || git::unstage_workspace_files(root, paths))
        .await
        .map_err(|_| IpcError::new("GIT_TASK_FAILED", "Git unstage task failed."))?
        .map_err(git_error)
}

#[tauri::command]
pub(crate) async fn discard_workspace_files(
    root: String,
    paths: Vec<String>,
    staged: bool,
) -> Result<WorkspaceReviewDelta, IpcError> {
    tauri::async_runtime::spawn_blocking(move || git::discard_workspace_files(root, paths, staged))
        .await
        .map_err(|_| IpcError::new("GIT_TASK_FAILED", "Git discard task failed."))?
        .map_err(git_error)
}

#[tauri::command]
pub(crate) async fn commit_workspace(root: String, message: String) -> Result<(), IpcError> {
    tauri::async_runtime::spawn_blocking(move || git::commit_workspace(root, message))
        .await
        .map_err(|_| IpcError::new("GIT_TASK_FAILED", "Git commit task failed."))?
        .map_err(git_error)
}

/// One synchronization of the workspace with its upstream, and the whole of what the review
/// panel's sync button does: the upstream's commits are pulled into this branch first
/// (fast-forward only, so a diverged branch fails the operation instead of inventing a merge), and
/// this branch's commits are pushed out after. A pull that cannot fast-forward leaves the
/// repository untouched and reports why; a push can only fail after the pull has landed.
#[tauri::command]
pub(crate) async fn sync_workspace(root: String) -> Result<(), IpcError> {
    tauri::async_runtime::spawn_blocking(move || git::sync_workspace(root))
        .await
        .map_err(|_| IpcError::new("GIT_TASK_FAILED", "Git sync task failed."))?
        .map_err(git_error)
}
