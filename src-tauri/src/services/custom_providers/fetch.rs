//! The OpenAI-compatible model-list probe (`GET {baseUrl}/models`).
//!
//! Missing metadata is reported as zero/false: the user fills it in, the host never guesses.

use std::time::Duration;

use reqwest::{header::ACCEPT, Client, Url};
use serde_json::Value;

use crate::errors::{
    IpcError, IpcResult, CUSTOM_PROVIDER_FETCH_FAILED, CUSTOM_PROVIDER_INVALID,
    CUSTOM_PROVIDER_MODELS_EMPTY,
};
use crate::models::agent::CustomModelDefinition;

use super::{BASE_URL_LIMIT, MODEL_LIMIT};

/// HTTP probe budget: a model list is small, and a hanging endpoint must not hang a command.
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
const FETCH_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const FETCH_BODY_LIMIT: usize = 4 * 1024 * 1024;

/// Whether two addresses share scheme, host, and effective port.
///
/// The model-list probe borrows a provider's stored key only for that provider's own origin: a
/// caller-chosen host must not be able to name a provider and receive its credential.
pub(crate) fn same_origin(left: &str, right: &str) -> bool {
    let (Ok(left), Ok(right)) = (Url::parse(left), Url::parse(right)) else {
        return false;
    };
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

pub(crate) async fn fetch_models(
    base_url: &str,
    api_key: Option<&str>,
) -> IpcResult<Vec<CustomModelDefinition>> {
    let mut url = endpoint(base_url)?;
    let path = url.path().trim_end_matches('/').to_owned();
    if !path.to_ascii_lowercase().ends_with("/models") {
        url.set_path(&format!("{path}/models"));
    }

    let client = Client::builder()
        .connect_timeout(FETCH_CONNECT_TIMEOUT)
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|_| fetch_failed("The request could not be prepared."))?;
    let mut request = client.get(url).header(ACCEPT, "application/json");
    if let Some(api_key) = api_key.map(str::trim).filter(|value| !value.is_empty()) {
        request = request.bearer_auth(api_key);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| fetch_failed("The model list could not be fetched."))?;
    if !response.status().is_success() {
        return Err(fetch_failed(&format!(
            "The endpoint answered with status {}.",
            response.status().as_u16()
        )));
    }
    if response
        .content_length()
        .is_some_and(|size| size > FETCH_BODY_LIMIT as u64)
    {
        return Err(fetch_failed("The model list is too large."));
    }

    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| fetch_failed("The model list could not be read."))?
    {
        if body.len() + chunk.len() > FETCH_BODY_LIMIT {
            return Err(fetch_failed("The model list is too large."));
        }
        body.extend_from_slice(&chunk);
    }

    let payload: Value = serde_json::from_slice(&body)
        .map_err(|_| fetch_failed("The endpoint did not answer with JSON."))?;
    let entries = payload
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| fetch_failed("The response has no `data` array."))?;

    let mut models: Vec<CustomModelDefinition> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for entry in entries.iter().take(MODEL_LIMIT) {
        let Some(id) = entry
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if id.chars().any(char::is_control) || seen.iter().any(|known| known == id) {
            continue;
        }
        seen.push(id.to_owned());
        models.push(model_from_entry(entry, id));
    }
    if models.is_empty() {
        return Err(IpcError::new(
            CUSTOM_PROVIDER_MODELS_EMPTY,
            "The endpoint reported no models.",
        ));
    }
    Ok(models)
}

fn model_from_entry(entry: &Value, id: &str) -> CustomModelDefinition {
    let name = entry
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(id)
        .to_owned();
    CustomModelDefinition {
        id: id.to_owned(),
        name,
        context_window: first_positive_int(
            entry,
            &["context_window", "contextWindow", "context_length"],
        )
        .or_else(|| {
            entry
                .get("top_provider")
                .and_then(|value| first_positive_int(value, &["context_length"]))
        })
        .unwrap_or_default(),
        max_tokens: first_positive_int(
            entry,
            &["max_tokens", "maxTokens", "max_completion_tokens"],
        )
        .or_else(|| {
            entry
                .get("top_provider")
                .and_then(|value| first_positive_int(value, &["max_completion_tokens"]))
        })
        .unwrap_or_default(),
        supports_images: entry
            .get("architecture")
            .and_then(|value| value.get("input_modalities"))
            .and_then(Value::as_array)
            .map(|values| values.iter().any(|value| value.as_str() == Some("image")))
            .unwrap_or(false)
            || entry
                .get("supports_vision")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        supports_reasoning: entry
            .get("supports_reasoning")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || entry
                .get("reasoning")
                .and_then(Value::as_bool)
                .unwrap_or(false),
    }
}

fn first_positive_int(entry: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter()
        .find_map(|key| entry.get(*key).and_then(Value::as_i64))
        .and_then(|value| (value > 0).then_some(value))
}

/// HTTP address check shared by the registry and the probe.
pub(super) fn endpoint(base_url: &str) -> IpcResult<Url> {
    let trimmed = base_url.trim();
    if trimmed.is_empty() || trimmed.len() > BASE_URL_LIMIT {
        return Err(IpcError::new(
            CUSTOM_PROVIDER_INVALID,
            "An API address is required.",
        ));
    }
    let url = Url::parse(trimmed).map_err(|_| {
        IpcError::new(
            CUSTOM_PROVIDER_INVALID,
            "The API address is not a valid URL.",
        )
    })?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || url.password().is_some()
    {
        return Err(IpcError::new(
            CUSTOM_PROVIDER_INVALID,
            "The API address must be an http(s) URL without credentials.",
        ));
    }
    Ok(url)
}

fn fetch_failed(message: &str) -> IpcError {
    IpcError::from_message(CUSTOM_PROVIDER_FETCH_FAILED, message.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stored key is borrowed only for its provider's own origin: a path or query change is the
    /// same provider, another host or scheme is not, and an unparseable address matches nothing.
    #[test]
    fn only_the_providers_own_origin_matches() {
        assert!(same_origin(
            "https://api.example.com/v1",
            "https://api.example.com/other"
        ));
        assert!(same_origin(
            "https://api.example.com/v1",
            "https://api.example.com"
        ));
        assert!(same_origin(
            "http://127.0.0.1:8081/v1",
            "http://127.0.0.1:8081/v1/models"
        ));
        assert!(!same_origin(
            "https://api.example.com/v1",
            "https://evil.example.com/v1"
        ));
        assert!(!same_origin(
            "https://api.example.com/v1",
            "https://api.example.com:8443/v1"
        ));
        assert!(!same_origin(
            "https://api.example.com/v1",
            "http://api.example.com/v1"
        ));
        assert!(!same_origin("https://api.example.com/v1", "not a url"));
    }
}
