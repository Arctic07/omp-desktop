use tauri::State;

use crate::errors::IpcError;
use crate::models::agent::{
    EngineDataPaths, EngineModelList, EngineRoleCandidates, ModelRoleTable, RuntimeStatus,
};
use crate::services::runtime::session;
use crate::services::{credentials, engine, host_bin};
use crate::state::AppState;

/// The runtime status page: what host artifact this build found, whether it could be verified, and
/// the one process serving every conversation.
#[tauri::command]
pub(crate) async fn runtime_status(state: State<'_, AppState>) -> Result<RuntimeStatus, IpcError> {
    let info = tauri::async_runtime::spawn_blocking(host_bin::info)
        .await
        .unwrap_or_else(|_| host_bin::HostBinInfo::absent());
    let snapshot = state.runtime.snapshot();
    let (host_version, sdk_version) = match snapshot.hello.as_ref() {
        Some(hello) => (nonempty(&hello.host_version), nonempty(&hello.sdk_version)),
        None => (None, None),
    };
    Ok(RuntimeStatus {
        engine_path: info
            .path
            .as_deref()
            .map(|path| crate::services::paths::plain_path(&path.to_string_lossy()))
            .unwrap_or_default(),
        engine_version: info.sdk_version.clone(),
        protocol_version: snapshot.protocol_version,
        data_root: state.paths.data_root.to_string_lossy().into_owned(),
        agent_dir: state.paths.agent_dir.to_string_lossy().into_owned(),
        credential_backend: credentials::credential_backend().to_owned(),
        engine_verified: info.verified,
        engine_error: info.error.map(str::to_owned),
        host_version,
        sdk_version,
        live_sessions: snapshot.live_sessions,
        data_root_host: state.paths.host_root.to_string_lossy().into_owned(),
        host_status: snapshot.status.token(),
        unknown_frames: snapshot.unknown_frames,
        dropped_frames: snapshot.dropped_frames,
        replay_attempts: snapshot.replay_attempts,
        processes: snapshot.processes(),
    })
}

fn nonempty(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_owned())
}

/// Restarts the host: a graceful shutdown, a fresh process, and the conversations it was serving
/// rebuilt from their session files.
///
/// Running turns are not replayed, and this is not an error: the SDK has no way to resume a turn
/// in a new process, so the affected sessions come back marked `interrupted` and the UI says so
/// (contract §3.2/§3.4).
#[tauri::command]
pub(crate) async fn runtime_restart(state: State<'_, AppState>) -> Result<(), IpcError> {
    state.runtime.restart().await
}

/// The model catalogue. `refresh` re-hydrates the host's credential-scoped cache, which is what a
/// changed provider key or a new provider definition needs - a restart is neither required nor
/// wanted for that.
#[tauri::command]
pub(crate) async fn engine_models(
    state: State<'_, AppState>,
    refresh: Option<bool>,
) -> Result<EngineModelList, IpcError> {
    let models = engine::available_models(&state.runtime, refresh.unwrap_or(false)).await?;
    Ok(EngineModelList { models })
}

/// The engine's model roles: what each one resolves to, and which of them this machine configured.
/// Reading it starts a host that is not running yet, which is what the settings page needs.
#[tauri::command]
pub(crate) async fn engine_model_roles(
    state: State<'_, AppState>,
) -> Result<ModelRoleTable, IpcError> {
    let roles = state.runtime.model_roles().await?;
    Ok(ModelRoleTable { roles })
}

/// The models one role may be assigned, in the engine's own order. `truncated` says the engine's
/// pool held more rows than the answer carries.
#[tauri::command]
pub(crate) async fn engine_role_candidates(
    state: State<'_, AppState>,
    role: String,
) -> Result<EngineRoleCandidates, IpcError> {
    let (models, truncated) = state.runtime.role_candidates(&role).await?;
    Ok(EngineRoleCandidates {
        role,
        models,
        truncated,
    })
}

/// Assigns a model to one role, or clears it (`selector: null`) so the engine picks for that role
/// again. The answer is the engine's role table as it stands after the write, which is what the
/// caller renders.
#[tauri::command]
pub(crate) async fn engine_set_model_role(
    state: State<'_, AppState>,
    role: String,
    selector: Option<String>,
) -> Result<ModelRoleTable, IpcError> {
    let roles = state
        .runtime
        .set_model_role(&role, selector.as_deref())
        .await?;
    Ok(ModelRoleTable { roles })
}

/// Makes sure the one host is running and past its handshake, so the composer's first send does
/// not wait for a cold start. Idempotent.
///
/// This is also the boot call that settles the tool approval mode: the engine is converged onto
/// `yolo` - every tool unattended - whatever its settings file carries, because this application
/// has no settings page for the mode and no other value could be changed back
/// (`services::runtime::approval::converge`).
///
/// `workspace_id` is accepted because the frontend's boot call sends it; one host serves every
/// workspace, so the value is ignored.
#[tauri::command]
pub(crate) async fn engine_warm(
    state: State<'_, AppState>,
    workspace_id: i64,
) -> Result<(), IpcError> {
    let _ = workspace_id;
    session::warm(&state.runtime).await
}

#[tauri::command]
pub(crate) async fn engine_data_paths(
    state: State<'_, AppState>,
) -> Result<EngineDataPaths, IpcError> {
    Ok(EngineDataPaths {
        data_root: state.paths.data_root.to_string_lossy().into_owned(),
        agent_dir: state.paths.agent_dir.to_string_lossy().into_owned(),
        config_root: state.paths.config_root().to_string_lossy().into_owned(),
        host_root: state.paths.host_root.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unreported_version_is_reported_as_absent() {
        assert_eq!(nonempty(""), None);
        assert_eq!(nonempty("1.3.14"), Some("1.3.14".to_owned()));
    }
}
