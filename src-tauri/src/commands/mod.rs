pub(crate) mod appearance;
pub(crate) mod attachments;
pub(crate) mod browser;
pub(crate) mod capabilities;
pub(crate) mod clipboard;
pub(crate) mod custom_providers;
pub(crate) mod diagnostics;
pub(crate) mod git;
pub(crate) mod mcp_import;
pub(crate) mod omp_import;
pub(crate) mod open_in_app;
pub(crate) mod plugin_marketplaces;
pub(crate) mod plugin_pages;
pub(crate) mod plugin_process;
pub(crate) mod plugins;
pub(crate) mod presence;
pub(crate) mod providers;
pub(crate) mod runtime;
pub(crate) mod sessions;
pub(crate) mod system;
pub(crate) mod terminal;
pub(crate) mod workspace;
pub(crate) mod workspaces;

use std::path::Path;

use crate::errors::{IpcError, IpcResult, WORKSPACE_NOT_FOUND};
use crate::state::AppState;

/// The working directory a command addresses: the root of the workspace the caller named, or `None`
/// when it named none.
///
/// `None` is not an empty directory - the frame simply carries no `cwd`, and the host falls back to
/// its default workspace. A registered workspace whose directory has disappeared is refused here,
/// with the code the rest of the IPC surface uses for it, rather than travelling as a path the host
/// cannot use (the same check `session_open` makes).
///
/// The capability commands and the plugin commands both address a workspace this way, so the rule
/// lives beside the module list rather than inside one of them.
pub(crate) async fn workspace_cwd(
    state: &AppState,
    workspace_id: Option<i64>,
) -> IpcResult<Option<String>> {
    let Some(id) = workspace_id else {
        return Ok(None);
    };
    let root = state.store.get_project(id).await?.root_path;
    if !Path::new(&root).is_dir() {
        return Err(IpcError::new(
            WORKSPACE_NOT_FOUND,
            "The workspace directory is not available.",
        ));
    }
    Ok(Some(root))
}
