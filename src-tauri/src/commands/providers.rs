use tauri::State;

use crate::errors::{IpcError, IpcResult, CREDENTIAL_STORE_UNAVAILABLE, INVALID_INPUT};
use crate::models::agent::{ProviderKeyResult, ProviderSummary};
use crate::services::engine;
use crate::services::{credentials, custom_providers};
use crate::state::AppState;

fn store_task_failed() -> IpcError {
    IpcError::new(
        CREDENTIAL_STORE_UNAVAILABLE,
        "The credential store task failed.",
    )
}

/// Always succeeds: this list is what the settings page needs in order to accept a key at
/// all, so it answers from this application's own tables and only asks a running host which of
/// them its model catalogue knows.
#[tauri::command]
pub(crate) async fn provider_list(
    state: State<'_, AppState>,
) -> Result<Vec<ProviderSummary>, IpcError> {
    let custom = custom_entries(&state).await;
    Ok(engine::providers(&state.runtime, &custom).await)
}

/// The user-defined providers, as the catalogue service needs them.
async fn custom_entries(state: &State<'_, AppState>) -> Vec<engine::CustomEntry> {
    let store = state.store.clone();
    let rows = tauri::async_runtime::spawn_blocking(move || store.list_custom_providers_blocking())
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
    rows.iter()
        .map(|row| engine::CustomEntry {
            id: row.id.clone(),
            name: row.name.clone(),
            key_env: custom_providers::key_env(&row.id),
        })
        .collect()
}

/// Applies one key edit - remove the named positions, then append the new keys - and hands the
/// whole resulting pool to the running engine.
///
/// The editor shows masked forms, never the keys, so an edit cannot send the saved list back; it
/// names the rows to drop and the keys to add. The order is the keyring first, then `models.yml`
/// (which decides whether the provider is keyless, pinned to one variable, or a pool), then the
/// running host. The host keeps the pool as in-memory credentials and rotates across them on auth
/// and quota failures, so no key is ever written to the engine's own database.
#[tauri::command]
pub(crate) async fn provider_keys_apply(
    state: State<'_, AppState>,
    provider_id: String,
    remove: Vec<usize>,
    add: Vec<String>,
) -> Result<ProviderKeyResult, IpcError> {
    let provider_id = validate_provider(&provider_id)?;
    if remove.len() > credentials::PROVIDER_KEYS_MAX {
        return Err(IpcError::new(INVALID_INPUT, "Too many API keys to remove."));
    }
    let add = validate_added_keys(&add)?;
    let (stored_id, positions, additions) = (provider_id.clone(), remove, add);
    let keys = tauri::async_runtime::spawn_blocking(move || {
        credentials::apply_keys(&stored_id, &positions, &additions)
    })
    .await
    .map_err(|_| store_task_failed())??;
    sync_custom_models(&state).await?;
    let live = if keys.is_empty() {
        state.runtime.provider_key_clear(&provider_id).await
    } else {
        state.runtime.provider_keys_set(&provider_id, &keys).await
    };
    Ok(ProviderKeyResult { live })
}

/// Clears every key for a provider and drops the pool from the running engine.
#[tauri::command]
pub(crate) async fn provider_clear_key(
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<ProviderKeyResult, IpcError> {
    let provider_id = validate_provider(&provider_id)?;
    let stored_id = provider_id.clone();
    tauri::async_runtime::spawn_blocking(move || credentials::clear_key(&stored_id))
        .await
        .map_err(|_| store_task_failed())??;
    sync_custom_models(&state).await?;
    let live = state.runtime.provider_key_clear(&provider_id).await;
    Ok(ProviderKeyResult { live })
}

/// Regenerates `models.yml` from the registry. A no-op for built-in providers: the file only
/// describes custom ones, and it is only touched when one exists or when we already own it.
async fn sync_custom_models(state: &State<'_, AppState>) -> Result<(), IpcError> {
    custom_providers::sync_models_yml(&state.store, &state.paths.agent_dir).await
}

fn validate_provider(provider_id: &str) -> IpcResult<String> {
    let provider_id = provider_id.trim();
    if provider_id.is_empty() || provider_id.len() > 128 {
        return Err(IpcError::new(INVALID_INPUT, "A provider id is required."));
    }
    Ok(provider_id.to_owned())
}

/// The keys one edit appends, with duplicates removed. Empty is allowed: an edit may only remove.
///
/// The page sends only non-empty rows; an empty one is a client bug, and dropping it keeps a stray
/// blank from becoming a bearer. The count cap is the keyring entry's own bound, so the UI can
/// never store more than the host will install.
fn validate_added_keys(api_keys: &[String]) -> IpcResult<Vec<String>> {
    let mut keys: Vec<String> = Vec::new();
    for key in api_keys {
        let key = validate_api_key(key)?;
        if !keys.iter().any(|existing| existing == &key) {
            keys.push(key);
        }
    }
    if keys.len() > credentials::PROVIDER_KEYS_MAX {
        return Err(IpcError::new(
            INVALID_INPUT,
            "Too many API keys for one provider.",
        ));
    }
    Ok(keys)
}

/// The key as it is stored and pushed: trimmed, non-empty, no control characters.
///
/// Surrounding whitespace is a paste artefact rather than part of a credential, and a control
/// character cannot be typed into the field yet would corrupt a request header, so both are
/// handled here instead of being carried into the keyring and the engine. The length cap is the
/// host's own bound on the frame field, so a value the UI accepted is never dropped later.
fn validate_api_key(api_key: &str) -> IpcResult<String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err(IpcError::new(INVALID_INPUT, "An API key is required."));
    }
    if api_key.chars().any(char::is_control) {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The API key contains control characters.",
        ));
    }
    if api_key.chars().count() > credentials::KEY_CHARS_MAX {
        return Err(IpcError::new(INVALID_INPUT, "The API key is too long."));
    }
    Ok(api_key.to_owned())
}
