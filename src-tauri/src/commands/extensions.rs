//! The extensions dashboard: the engine's discovered items and the one-item toggle.
//!
//! Everything this surface knows is the host's answer - which provider discovered an item, what
//! state the engine's gates put it in, and which ids `disabledExtensions` holds. This layer bounds
//! the two arguments (one id token, one boolean), names the workspace the discovery runs in, and
//! converts nothing: the DTO is the host's own shape.

use tauri::State;

use crate::errors::IpcError;
use crate::models::extensions::ExtensionsView;
use crate::services::plugins::validate::sanitize_extension_id;
use crate::state::AppState;

use super::workspace_cwd;

/// Every engine extension item this workspace discovers, and the disabled-id setting.
#[tauri::command]
pub(crate) async fn extensions_list(
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
) -> Result<ExtensionsView, IpcError> {
    let cwd = workspace_cwd(&state, workspace_id).await?;
    state.runtime.extensions(cwd.as_deref()).await
}

/// Enables or disables one item, answered with the dashboard after the write and the sessions
/// reloaded. The id is the engine's own token (`skill:<name>`, `extension-module:<name>`, …).
#[tauri::command]
pub(crate) async fn extensions_set(
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
    id: String,
    enabled: bool,
) -> Result<ExtensionsView, IpcError> {
    let cwd = workspace_cwd(&state, workspace_id).await?;
    let id = sanitize_extension_id(&id)?;
    state
        .runtime
        .extension_set(cwd.as_deref(), &id, enabled)
        .await
}
