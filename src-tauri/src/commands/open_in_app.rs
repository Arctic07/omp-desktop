//! Thin commands over the open-in-app service: which applications this machine has, one
//! application's own icon, and the launch of one application on one workspace directory.

use std::path::PathBuf;

use tauri::State;

use crate::errors::{
    IpcError, INVALID_INPUT, OPEN_IN_APP_FAILED, OPEN_IN_APP_UNKNOWN, WORKSPACE_NOT_FOUND,
};
use crate::models::{OpenInAppAppsResult, OpenInAppIconResult};
use crate::services::open_in_app::{LaunchFailure, OpenTarget, TargetKind};
use crate::services::paths;
use crate::services::workspace;
use crate::state::AppState;

/// Ceiling on one catalog id. Every id is a short catalog token, so anything longer is not one -
/// and the id reaches a catalog lookup and a cache key before it reaches anything else.
const APP_ID_LIMIT: usize = 64;

/// Ceiling on one workspace path. Windows' own long-path limit is the widest value that can still
/// name a directory this desktop could open.
const PATH_LIMIT: usize = 4096;

/// The catalog ids this machine can open a workspace directory with, in menu order.
#[tauri::command]
pub(crate) async fn open_in_app_apps(
    state: State<'_, AppState>,
) -> Result<OpenInAppAppsResult, IpcError> {
    let service = state.open_in_app.clone();
    tauri::async_runtime::spawn_blocking(move || OpenInAppAppsResult {
        apps: service.installed_apps(),
    })
    .await
    .map_err(|_| IpcError::new("OPEN_IN_APP_TASK_FAILED", "Open-in-app task failed."))
}

/// One installed application's icon as a `data:` URL.
///
/// An application this machine serves no icon for is not an error the page draws: the menu row
/// falls back to its generic glyph, and the command answers with the same refusal the page treats
/// as "no artwork" (`OPEN_IN_APP_FAILED`).
#[tauri::command]
pub(crate) async fn open_in_app_icon(
    state: State<'_, AppState>,
    app_id: String,
) -> Result<OpenInAppIconResult, IpcError> {
    validate_app_id(&app_id)?;
    let service = state.open_in_app.clone();
    tauri::async_runtime::spawn_blocking(move || service.icon(&app_id))
        .await
        .map_err(|_| IpcError::new("OPEN_IN_APP_TASK_FAILED", "Open-in-app task failed."))?
        .map(|data_url| OpenInAppIconResult { data_url })
        .ok_or_else(|| {
            IpcError::new(
                OPEN_IN_APP_FAILED,
                "This application has no icon on this machine.",
            )
        })
}

/// Open one file or directory inside a workspace in one installed application.
#[tauri::command]
pub(crate) async fn open_in_app_launch(
    state: State<'_, AppState>,
    app_id: String,
    root: String,
    path: String,
) -> Result<(), IpcError> {
    validate_app_id(&app_id)?;
    let target = resolve_target(&root, &path)?;
    let service = state.open_in_app.clone();
    tauri::async_runtime::spawn_blocking(move || service.launch(&app_id, &target))
        .await
        .map_err(|_| IpcError::new("OPEN_IN_APP_TASK_FAILED", "Open-in-app task failed."))?
        .map_err(|failure| match failure {
            LaunchFailure::Unknown => IpcError::new(
                OPEN_IN_APP_UNKNOWN,
                "This machine does not offer that application.",
            ),
            LaunchFailure::Failed => {
                IpcError::new(OPEN_IN_APP_FAILED, "Launching the application failed.")
            }
        })
}

/// One catalog id as the page sent it: a short, non-empty token.
fn validate_app_id(app_id: &str) -> Result<(), IpcError> {
    if app_id.is_empty() || app_id.len() > APP_ID_LIMIT {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The application id is invalid.",
        ));
    }
    Ok(())
}

/// The launch target: the workspace-relative path resolved against its own root.
///
/// Both come from the page, so neither is trusted: the root must be absolute, and the relative
/// path is resolved by the workspace layer, which refuses anything that is absolute, ignored, or
/// that escapes the root. What survives is a real path - never a string with `..` in it - and
/// whether it names a directory or a file, which decides how a launcher receives it.
///
/// The path handed to a launcher is spelled plainly (a canonical, verbatim path reaches a shell as
/// a provider path), so what a launcher receives is the same text the page shows.
fn resolve_target(root: &str, path: &str) -> Result<OpenTarget, IpcError> {
    if root.is_empty() || root.len() > PATH_LIMIT || path.len() > PATH_LIMIT {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The workspace path is invalid.",
        ));
    }
    if !PathBuf::from(root).is_absolute() {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The workspace root must be absolute.",
        ));
    }
    let (_, resolved) = workspace::resolve_workspace_path(root, path)
        .map_err(|message| IpcError::from_message("WORKSPACE_OPERATION_FAILED", message))?;
    let metadata = std::fs::metadata(&resolved)
        .map_err(|_| IpcError::new(WORKSPACE_NOT_FOUND, "The workspace path does not exist."))?;
    let kind = if metadata.is_dir() {
        TargetKind::Directory
    } else {
        TargetKind::File
    };
    Ok(OpenTarget {
        // The canonical spelling is only what the containment check above reads: a launcher is
        // handed the plain path, because a verbatim one reaches a shell as a provider path
        // (`PS Microsoft.PowerShell.Core\FileSystem::\\?\C:\...>`).
        path: paths::plain_process_path(&resolved),
        kind,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The regression: the workspace target is canonicalized before it reaches a launcher, which
    /// answers with the verbatim form on Windows - and Windows Terminal started in that shows
    /// `PS Microsoft.PowerShell.Core\FileSystem::\\?\C:\...>` instead of the drive.
    #[cfg(windows)]
    #[test]
    fn a_resolved_target_is_spelled_plainly() {
        let temp = std::env::temp_dir();
        let target = resolve_target(&format!(r"\\?\{}", temp.display()), "")
            .expect("the temp directory resolves");

        // `TargetKind` carries no `Debug`, so the comparison is the assertion here.
        assert!(
            target.kind == TargetKind::Directory,
            "the temp directory is a directory"
        );
        assert!(
            !target.path.to_string_lossy().starts_with(r"\\?\"),
            "a launcher is handed the plain path: {}",
            target.path.display()
        );
    }
}
