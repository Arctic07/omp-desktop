use tauri::State;

use crate::errors::{IpcError, INVALID_INPUT};
use crate::models::agent::{CustomModelList, CustomProvider, CustomProviderInput};
use crate::services::{credentials, custom_providers};
use crate::state::AppState;

/// Every stored provider, joined with the credential store's view of its key.
#[tauri::command]
pub(crate) async fn custom_provider_list(
    state: State<'_, AppState>,
) -> Result<Vec<CustomProvider>, IpcError> {
    custom_providers::list(&state.store).await
}

/// Stores one provider and regenerates the engine's `models.yml`. The engine reads that file at
/// start only, so the frontend restarts the runtime afterwards.
#[tauri::command]
pub(crate) async fn custom_provider_save(
    state: State<'_, AppState>,
    provider: CustomProviderInput,
) -> Result<Vec<CustomProvider>, IpcError> {
    let providers = custom_providers::save(&state.store, &state.paths.agent_dir, provider).await?;
    refresh_env(&state).await;
    Ok(providers)
}

/// Hard delete: registry row, stored key and its `models.yml` entry go away together.
#[tauri::command]
pub(crate) async fn custom_provider_remove(
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<Vec<CustomProvider>, IpcError> {
    let providers =
        custom_providers::remove(&state.store, &state.paths.agent_dir, &provider_id).await?;
    refresh_env(&state).await;
    // The stored key is gone with the row, so a running host must drop its in-memory copy of it:
    // the engine would otherwise keep answering with a credential whose provider the engine no
    // longer knows. Nothing to start for this - a process that is not running holds nothing.
    state.runtime.provider_key_clear(provider_id.trim()).await;
    Ok(providers)
}

/// The first stored key's model list, or the typed key's when the editor holds one.
///
/// The editor's key field is empty for a provider whose key is stored, so a blank field with a
/// `provider_id` reads the first stored key instead of probing unauthenticated - which made an
/// authenticated endpoint answer `401` while the same provider's models kept working.
#[tauri::command]
pub(crate) async fn custom_provider_fetch_models(
    state: State<'_, AppState>,
    base_url: String,
    api_key: Option<String>,
    provider_id: Option<String>,
) -> Result<CustomModelList, IpcError> {
    let typed = api_key
        .map(|key| key.trim().to_owned())
        .filter(|key| !key.is_empty());
    let provider = provider_id
        .map(|id| id.trim().to_owned())
        .filter(|id| !id.is_empty());
    // A stored key is borrowed only for the provider it belongs to: the provider must be one this
    // application defines, and the probed address must share its origin. A caller-chosen host can
    // therefore never receive a stored credential.
    if typed.is_none() {
        if let Some(id) = provider.as_deref() {
            let rows = state.store.list_custom_providers().await?;
            let row = rows.iter().find(|row| row.id == id).ok_or_else(|| {
                IpcError::new(
                    INVALID_INPUT,
                    "This provider is not one this application defines.",
                )
            })?;
            if !custom_providers::same_origin(&base_url, &row.base_url) {
                return Err(IpcError::new(
                    INVALID_INPUT,
                    "The address does not belong to this provider.",
                ));
            }
        }
    }
    fetch_models_with_first_key(base_url, typed, provider).await
}

/// Probes with the typed key, else the provider's first stored key; only the first key is probed.
///
/// A pool's other keys may reach other models, but that is the user's own setup to manage: the
/// editor shows what one key sees and never merges catalogues across keys.
async fn fetch_models_with_first_key(
    base_url: String,
    typed: Option<String>,
    provider_id: Option<String>,
) -> Result<CustomModelList, IpcError> {
    let api_key = match typed {
        Some(key) => Some(key),
        // Keyring reads block, so they stay off the async workers.
        None => match provider_id {
            Some(id) => tauri::async_runtime::spawn_blocking(move || credentials::stored_key(&id))
                .await
                .ok()
                .flatten(),
            None => None,
        },
    };
    let models = custom_providers::fetch_models(&base_url, api_key.as_deref()).await?;
    Ok(CustomModelList { models })
}

/// The host reads custom provider keys from the environment it was started with, so its view of
/// the registry has to follow every change. A change does not restart the host - running
/// conversations would go with it - so the next spawn, or an explicit catalogue refresh, is what
/// makes the new set visible.
async fn refresh_env(state: &State<'_, AppState>) {
    let store = state.store.clone();
    let rows = tauri::async_runtime::spawn_blocking(move || store.list_custom_providers_blocking())
        .await
        .ok()
        .and_then(Result::ok);
    let Some(rows) = rows else {
        return;
    };
    let entries: Vec<(String, String)> = rows
        .iter()
        .map(|row| (row.id.clone(), custom_providers::key_env(&row.id)))
        .collect();
    state.runtime.set_custom_providers(entries);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{ErrorKind, Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    /// Reads one request head from `listener`, answers with `status`/`body`, and returns the head.
    fn answer_once(listener: &TcpListener, status: &str, body: &str) -> String {
        let (mut stream, _) = listener.accept().expect("accept the probe request");
        let mut request: Vec<u8> = Vec::new();
        let mut buffer = [0_u8; 1024];
        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
            let read = stream.read(&mut buffer).expect("read the probe request");
            if read == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..read]);
        }
        let head = format!(
            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(head.as_bytes()).expect("write the head");
        stream.write_all(body.as_bytes()).expect("write the body");
        String::from_utf8_lossy(&request).to_ascii_lowercase()
    }

    /// The editor's key field is empty for a provider whose key is stored, so a blank field must
    /// borrow the stored key instead of probing unauthenticated.
    #[test]
    fn a_blank_key_field_probes_with_the_stored_key() {
        if credentials::credential_backend() != "os-keyring" {
            return;
        }
        const PROBE_ID: &str = "custom-probe-test";
        credentials::set_key(PROBE_ID, "sk-probe-stored-key").expect("store the probe key");

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind the probe endpoint");
        let port = listener.local_addr().expect("probe address").port();
        let server = std::thread::spawn(move || {
            answer_once(&listener, "200 OK", r#"{"data":[{"id":"probe-model"}]}"#)
        });

        let answer = tauri::async_runtime::block_on(fetch_models_with_first_key(
            format!("http://127.0.0.1:{port}/v1"),
            None,
            Some(PROBE_ID.to_owned()),
        ));
        let request = server.join().expect("probe endpoint");
        let _ = credentials::clear_key(PROBE_ID);

        assert!(
            request.contains("authorization: bearer sk-probe-stored-key"),
            "the probe carried no stored key: {request}"
        );
        let models = answer.expect("the probe succeeds").models;
        assert_eq!(models[0].id, "probe-model");
    }

    /// Only the first stored key is probed: the pool's other keys are the user's own concern, and
    /// their catalogues are never merged into this one.
    #[test]
    fn only_the_first_stored_key_is_probed() {
        if credentials::credential_backend() != "os-keyring" {
            return;
        }
        const POOL_ID: &str = "custom-probe-first-test";
        credentials::set_keys(POOL_ID, &["sk-first".to_owned(), "sk-second".to_owned()])
            .expect("store the probe pool");

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind the probe endpoint");
        listener
            .set_nonblocking(true)
            .expect("non-blocking listener");
        let port = listener.local_addr().expect("probe address").port();
        // The loop ends when this test has its answer (`answered`), not when a wall clock says so.
        // The 800 ms deadline this replaces raced the machine's own load: under a parallel suite the
        // caller's request could arrive after it, the listener was already gone, and the probe
        // "failed" on a fixture that was fine. What remains is only what keeps a broken fixture from
        // hanging the suite.
        let answered = Arc::new(AtomicBool::new(false));
        let stop = answered.clone();
        let server = std::thread::spawn(move || {
            let mut requests: Vec<String> = Vec::new();
            let deadline = Instant::now() + Duration::from_secs(30);
            while !stop.load(Ordering::SeqCst) && Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream
                            .set_nonblocking(false)
                            .expect("blocking accepted stream");
                        let mut request: Vec<u8> = Vec::new();
                        let mut buffer = [0_u8; 1024];
                        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                            let read = stream.read(&mut buffer).expect("read the probe request");
                            if read == 0 {
                                break;
                            }
                            request.extend_from_slice(&buffer[..read]);
                        }
                        let body = r#"{"data":[{"id":"probe-model"}]}"#;
                        let head = format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                            body.len()
                        );
                        stream.write_all(head.as_bytes()).expect("write the head");
                        stream.write_all(body.as_bytes()).expect("write the body");
                        requests.push(String::from_utf8_lossy(&request).to_ascii_lowercase());
                    }
                    Err(ref error) if error.kind() == ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    Err(_) => break,
                }
            }
            requests
        });

        let answer = tauri::async_runtime::block_on(fetch_models_with_first_key(
            format!("http://127.0.0.1:{port}/v1"),
            None,
            Some(POOL_ID.to_owned()),
        ));
        let requests = {
            answered.store(true, Ordering::SeqCst);
            server.join().expect("probe endpoint")
        };
        let _ = credentials::clear_key(POOL_ID);

        assert!(answer.is_ok(), "the first key answers");
        assert_eq!(requests.len(), 1, "{requests:?}");
        assert!(requests[0].contains("authorization: bearer sk-first"));
    }
}
