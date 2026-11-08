//! User-defined providers: the registry row, the key environment name, and the generated
//! `<agentDir>/models.yml`.
//!
//! `models.yml` is the only file the host writes inside the engine's agent directory, and it is
//! written for one purpose: the engine reads custom providers from nowhere else. The rendering and
//! the model-list probe live in their own submodules; this module owns validation, the registry,
//! and the mapping from a stored row to the wire shape.

mod fetch;
mod models_yml;

use std::path::Path;

use crate::errors::{IpcError, IpcResult, CUSTOM_PROVIDER_INVALID};
use crate::models::agent::{CustomProvider, CustomProviderInput};
use crate::models::store::CustomProviderRow;
use crate::services::credentials;
use crate::services::store::Store;

pub(crate) use fetch::{fetch_models, same_origin};

/// Key environment names are derived from the provider id, so a re-save keeps the same name.
const KEY_ENV_PREFIX: &str = "OMP_DESKTOP_CUSTOM_";
const KEY_ENV_SUFFIX: &str = "_API_KEY";

/// API dialects the engine's `models.yml` schema accepts (docs/models.md).
///
/// `typesafe` and `openrouter-decisions` are judgment APIs rather than chat transports - a model
/// declared with one answers System One judgment requests and is selected by the `judge` role -
/// but the schema accepts them like any other dialect, so the editor offers them too.
const ALLOWED_APIS: &[&str] = &[
    "openai-completions",
    "openai-responses",
    "openai-codex-responses",
    "azure-openai-responses",
    "anthropic-messages",
    "bedrock-converse-stream",
    "google-generative-ai",
    "google-gemini-cli",
    "google-vertex",
    "typesafe",
    "openrouter-decisions",
];

const NAME_LIMIT_CHARS: usize = 120;
const NAME_LIMIT_BYTES: usize = 2048;

pub(super) const BASE_URL_LIMIT: usize = 2048;
pub(super) const MODEL_LIMIT: usize = 500;

/// The environment variable the host injects this provider's key into.
///
/// The spelling collapses every non-alphanumeric to `_` and upper-cases the rest, so ids that differ
/// only in case or in `.`/`_`/`-` would share one variable - and a shared variable means one
/// provider's key is injected for the other. A digest is appended for such ids, keeping one variable
/// per provider id. The host derives the same name (`deriveCustomEnv` in `host/src/provider-keys.ts`).
pub(crate) fn key_env(provider_id: &str) -> String {
    let mut name = String::from(KEY_ENV_PREFIX);
    for character in provider_id.chars() {
        if character.is_ascii_alphanumeric() {
            name.push(character.to_ascii_uppercase());
        } else {
            name.push('_');
        }
    }
    if !provider_id.chars().all(|character| {
        character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
    }) {
        name.push_str(&format!("_{:08X}", id_digest(provider_id)));
    }
    name.push_str(KEY_ENV_SUFFIX);
    name
}

/// FNV-1a over the id's bytes; only its uniqueness matters, not its strength.
fn id_digest(value: &str) -> u32 {
    let mut hash: u32 = 2_166_136_261;
    for byte in value.bytes() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(16_777_619);
    }
    hash
}

/// Every stored provider, joined with the credential store's view of its key.
pub(crate) async fn list(store: &Store) -> IpcResult<Vec<CustomProvider>> {
    let rows = store.list_custom_providers().await?;
    // Deriving the credential state reads the OS credential store, which blocks: keep it on a
    // blocking thread like every other store and keyring access.
    tauri::async_runtime::spawn_blocking(move || rows.iter().map(to_provider).collect())
        .await
        .map_err(|_| task_failed())?
}

/// Validates, stores, regenerates `models.yml`, and returns the new list.
pub(crate) async fn save(
    store: &Store,
    agent_dir: &Path,
    input: CustomProviderInput,
) -> IpcResult<Vec<CustomProvider>> {
    let input = validate(input)?;
    let models_json = serde_json::to_string(&input.models)
        .map_err(|_| IpcError::new(CUSTOM_PROVIDER_INVALID, "The models could not be encoded."))?;
    store
        .upsert_custom_provider(CustomProviderRow {
            id: input.id.clone(),
            name: input.name.clone(),
            base_url: input.base_url.clone(),
            api: input.api.clone(),
            models_json,
        })
        .await?;
    let providers = list(store).await?;
    models_yml::write_models_yml_blocking(agent_dir, providers).await
}

/// Hard delete: the row, the stored key and its `models.yml` entry go away together.
pub(crate) async fn remove(
    store: &Store,
    agent_dir: &Path,
    provider_id: &str,
) -> IpcResult<Vec<CustomProvider>> {
    let provider_id = provider_id.trim().to_owned();
    if provider_id.is_empty() {
        return Err(IpcError::new(
            CUSTOM_PROVIDER_INVALID,
            "A provider id is required.",
        ));
    }
    store.remove_custom_provider(&provider_id).await?;
    tauri::async_runtime::spawn_blocking(move || credentials::clear_key(&provider_id))
        .await
        .map_err(|_| {
            IpcError::new(
                crate::errors::CREDENTIAL_STORE_UNAVAILABLE,
                "The credential store task failed.",
            )
        })??;
    let providers = list(store).await?;
    models_yml::write_models_yml_blocking(agent_dir, providers).await
}

/// Adds the definitions this registry does not already hold, then regenerates `models.yml`.
///
/// Identity is the provider id: a definition whose id is already stored is left exactly as the
/// reader configured it, so an import never overwrites a local edit and two imports never produce
/// two rows for one provider. Each answer pairs the id with the reason it was not stored
/// (`configured` when this registry already had it, or the validation's own refusal).
pub(crate) async fn import_missing(
    store: &Store,
    agent_dir: &Path,
    inputs: Vec<CustomProviderInput>,
) -> IpcResult<Vec<(String, Option<String>)>> {
    let mut outcomes: Vec<(String, Option<String>)> = Vec::with_capacity(inputs.len());
    let mut changed = false;
    // Read once: the identities are what decide every row's fate, and the list is small.
    let existing: Vec<String> = store
        .list_custom_providers()
        .await?
        .iter()
        .map(|row| row.id.to_ascii_lowercase())
        .collect();
    for input in inputs {
        let id = input.id.trim().to_owned();
        if existing.iter().any(|row| *row == id.to_ascii_lowercase()) {
            outcomes.push((id, Some("configured".to_owned())));
            continue;
        }
        match validate(input) {
            Ok(input) => {
                let models_json = serde_json::to_string(&input.models).map_err(|_| {
                    IpcError::new(CUSTOM_PROVIDER_INVALID, "The models could not be encoded.")
                })?;
                store
                    .upsert_custom_provider(CustomProviderRow {
                        id: input.id.clone(),
                        name: input.name.clone(),
                        base_url: input.base_url.clone(),
                        api: input.api.clone(),
                        models_json,
                    })
                    .await?;
                outcomes.push((input.id, None));
                changed = true;
            }
            Err(_) => outcomes.push((id, Some("unsupported".to_owned()))),
        }
    }
    if changed {
        let providers = list(store).await?;
        models_yml::write_models_yml_blocking(agent_dir, providers).await?;
    }
    Ok(outcomes)
}

/// Brings `models.yml` back in line with the registry without touching the registry itself.
///
/// Two paths need this: storing or clearing a key (which flips `auth: none` <-> `apiKey:`), and
/// start-up (a file written by an earlier build, or by a run where the key came after the save,
/// stays wrong forever otherwise). Nothing is written when there is nothing to describe and no
/// file of ours to correct.
pub(crate) async fn sync_models_yml(store: &Store, agent_dir: &Path) -> IpcResult<()> {
    let providers = list(store).await?;
    if !should_write(&providers, agent_dir) {
        return Ok(());
    }
    models_yml::write_models_yml_blocking(agent_dir, providers).await?;
    Ok(())
}

/// Blocking variant for start-up, which runs before any command is served and has no async
/// context to spawn onto. The work is a store read, a few credential lookups and one file write.
pub(crate) fn sync_models_yml_blocking(store: &Store, agent_dir: &Path) -> IpcResult<()> {
    let rows = store.list_custom_providers_blocking()?;
    let providers: Vec<CustomProvider> = rows.iter().map(to_provider).collect::<IpcResult<_>>()?;
    if !should_write(&providers, agent_dir) {
        return Ok(());
    }
    models_yml::write_models_yml(agent_dir, &providers)
}

/// Whether the generated file should be written at all: a provider to describe, or a file we
/// already own that has to stay truthful.
fn should_write(providers: &[CustomProvider], agent_dir: &Path) -> bool {
    if !providers.is_empty() {
        return true;
    }
    std::fs::read_to_string(agent_dir.join(models_yml::MODELS_FILE))
        .map(|contents| contents.starts_with(models_yml::MANAGED_MARKER))
        .unwrap_or(false)
}

fn validate(input: CustomProviderInput) -> IpcResult<CustomProviderInput> {
    let id = input.id.trim().to_owned();
    // The id is the provider key the engine reads, and the key ring entry this application stores
    // its credential under, so both sides ask one rule (`credentials::is_storable_provider_id`).
    // The editor still generates `[a-z0-9-]` ids (`custom-draft.ts`); an imported installation's
    // key is kept as it is, because its model roles name it.
    if !credentials::is_storable_provider_id(&id) {
        return Err(IpcError::new(
            CUSTOM_PROVIDER_INVALID,
            "The provider id must start with a letter or digit and use only letters, digits, \".\", \"_\" and \"-\".",
        ));
    }
    // A built-in provider id is the engine's own entry: a custom provider with that id would share
    // the built-in's keyring entry, and its own `baseUrl` would receive the built-in's key.
    if !credentials::api_key_env(&id).is_empty() {
        return Err(IpcError::new(
            CUSTOM_PROVIDER_INVALID,
            "A built-in provider id cannot be redefined.",
        ));
    }

    let api = input.api.trim().to_owned();
    if !ALLOWED_APIS.contains(&api.as_str()) {
        return Err(IpcError::new(
            CUSTOM_PROVIDER_INVALID,
            "The provider API dialect is not one the engine accepts.",
        ));
    }

    let base_url = input.base_url.trim().to_owned();
    fetch::endpoint(&base_url)?;

    let name = input.name.trim();
    let name = if name.is_empty() {
        id.clone()
    } else {
        name.to_owned()
    };
    if name.chars().count() > NAME_LIMIT_CHARS || name.chars().any(char::is_control) {
        return Err(IpcError::new(
            CUSTOM_PROVIDER_INVALID,
            "The provider name is too long or contains control characters.",
        ));
    }

    if input.models.len() > MODEL_LIMIT {
        return Err(IpcError::new(
            CUSTOM_PROVIDER_INVALID,
            "Too many models for one provider.",
        ));
    }
    let mut models = Vec::with_capacity(input.models.len());
    for model in input.models {
        let model_id = model.id.trim().to_owned();
        if model_id.is_empty() || model_id.len() > NAME_LIMIT_BYTES {
            return Err(IpcError::new(
                CUSTOM_PROVIDER_INVALID,
                "Every model needs an id of at most 2048 bytes.",
            ));
        }
        // Control characters cannot be represented in the generated file; refusing them here keeps
        // a remote model list from producing a file the engine would reject as a whole.
        if model_id.chars().any(char::is_control) {
            return Err(IpcError::new(
                CUSTOM_PROVIDER_INVALID,
                "A model id contains control characters.",
            ));
        }
        if model.context_window < 0 || model.max_tokens < 0 {
            return Err(IpcError::new(
                CUSTOM_PROVIDER_INVALID,
                "Model limits cannot be negative.",
            ));
        }
        let model_name = model.name.trim();
        let model_name = if model_name.is_empty() {
            model_id.clone()
        } else {
            model_name.to_owned()
        };
        if model_name.chars().any(char::is_control) {
            return Err(IpcError::new(
                CUSTOM_PROVIDER_INVALID,
                "A model name contains control characters.",
            ));
        }
        models.push(crate::models::agent::CustomModelDefinition {
            id: model_id,
            name: model_name,
            context_window: model.context_window,
            max_tokens: model.max_tokens,
            supports_images: model.supports_images,
            supports_reasoning: model.supports_reasoning,
        });
    }

    Ok(CustomProviderInput {
        id,
        name,
        base_url,
        api,
        models,
    })
}

fn to_provider(row: &CustomProviderRow) -> IpcResult<CustomProvider> {
    let models = serde_json::from_str(&row.models_json).map_err(|_| {
        IpcError::new(
            CUSTOM_PROVIDER_INVALID,
            "A stored custom provider has unreadable models.",
        )
    })?;
    let masks = credentials::stored_key_masks(&row.id);
    Ok(CustomProvider {
        key_env: key_env(&row.id),
        // Comes from the credential store, never from the built-in provider table: a custom id
        // has no built-in mapping, yet its key is stored and injected exactly like a built-in one.
        api_key_configured: !masks.is_empty(),
        api_key_masks: masks,
        input: CustomProviderInput {
            id: row.id.clone(),
            name: row.name.clone(),
            base_url: row.base_url.clone(),
            api: row.api.clone(),
            models,
        },
    })
}

fn task_failed() -> IpcError {
    IpcError::new(
        crate::errors::STORE_UNAVAILABLE,
        "The custom provider task failed.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::agent::CustomModelDefinition;

    fn input(id: &str) -> CustomProviderInput {
        CustomProviderInput {
            id: id.to_owned(),
            name: "My Gateway".to_owned(),
            base_url: "https://api.example.com/v1".to_owned(),
            api: "openai-completions".to_owned(),
            models: vec![CustomModelDefinition {
                id: "gpt-x".to_owned(),
                name: "gpt-x".to_owned(),
                context_window: 128_000,
                max_tokens: 8192,
                supports_images: false,
                supports_reasoning: false,
            }],
        }
    }

    /// The file is written when there is a provider to describe, or when we already own a file
    /// that has to stay truthful - never merely because the directory exists.
    #[test]
    fn the_file_is_only_written_when_it_has_something_to_say() {
        let root = std::env::temp_dir().join(format!("omp-sync-probe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("probe dir");

        let provider = CustomProvider {
            input: input("my-gateway"),
            key_env: key_env("my-gateway"),
            api_key_configured: true,
            api_key_masks: vec!["sk-*****abcd".to_owned()],
        };
        assert!(should_write(&[provider], &root));
        assert!(!should_write(&[], &root), "no provider, no file of ours");

        std::fs::write(
            root.join(models_yml::MODELS_FILE),
            "# omp-desktop managed\nproviders: {}\n",
        )
        .expect("managed file");
        assert!(
            should_write(&[], &root),
            "an owned file must be corrected when the registry empties"
        );

        std::fs::write(
            root.join(models_yml::MODELS_FILE),
            "providers:\n  someone-else:\n",
        )
        .expect("foreign file");
        assert!(
            !should_write(&[], &root),
            "a file we do not own is left alone unless it must change"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Ids that collapse to one spelling must not share a variable: the digest keeps them apart.
    #[test]
    fn key_environment_names_are_unique_per_id() {
        assert_ne!(key_env("my.gateway"), key_env("my-gateway"));
        assert_ne!(key_env("Foo"), key_env("foo"));
        assert_eq!(
            key_env("my-gateway"),
            "OMP_DESKTOP_CUSTOM_MY_GATEWAY_API_KEY"
        );
    }

    #[test]
    fn key_environment_names_are_derived_from_the_provider_id() {
        assert_eq!(
            key_env("my-gateway"),
            "OMP_DESKTOP_CUSTOM_MY_GATEWAY_API_KEY"
        );
        assert_eq!(key_env("edge"), "OMP_DESKTOP_CUSTOM_EDGE_API_KEY");
    }

    #[test]
    fn validation_rejects_ids_and_dialects_the_engine_would_not_accept() {
        let mut bad_id = input("ok-id");
        bad_id.id = "Bad Id".to_owned();
        assert_eq!(validate(bad_id).unwrap_err().code, CUSTOM_PROVIDER_INVALID);

        let mut bad_api = input("ok-id");
        bad_api.api = "not-a-dialect".to_owned();
        assert_eq!(validate(bad_api).unwrap_err().code, CUSTOM_PROVIDER_INVALID);

        let mut bad_url = input("ok-id");
        bad_url.base_url = "ftp://api.example.com".to_owned();
        assert_eq!(validate(bad_url).unwrap_err().code, CUSTOM_PROVIDER_INVALID);

        // A built-in id is the engine's own entry and cannot be redefined as a custom provider.
        assert_eq!(
            validate(input("anthropic")).unwrap_err().code,
            CUSTOM_PROVIDER_INVALID
        );

        let mut empty_url = input("ok-id");
        empty_url.base_url = String::new();
        assert_eq!(
            validate(empty_url).unwrap_err().code,
            CUSTOM_PROVIDER_INVALID
        );

        let mut controlled = input("ok-id");
        controlled.models[0].id = "a\nb".to_owned();
        assert_eq!(
            validate(controlled).unwrap_err().code,
            CUSTOM_PROVIDER_INVALID
        );

        // A legal input is normalized rather than rejected: blank names fall back to the id.
        let mut blank = input("ok-id");
        blank.name = "   ".to_owned();
        blank.models[0].name = String::new();
        let validated = validate(blank).expect("valid input");
        assert_eq!(validated.name, "ok-id");
        assert_eq!(validated.models[0].name, "gpt-x");
    }

    /// The blocker this covers: the key decision comes from the credential store, not from
    /// whether the provider id appears in the built-in table.
    #[test]
    fn a_stored_key_switches_the_generated_entry_to_the_environment_name() {
        const ID: &str = "omp-desktop-selftest";
        if credentials::credential_backend() != "os-keyring" {
            eprintln!("SKIP: no OS credential store on this machine");
            return;
        }
        let row = CustomProviderRow {
            id: ID.to_owned(),
            name: "Self Test".to_owned(),
            base_url: "https://api.example.com/v1".to_owned(),
            api: "openai-completions".to_owned(),
            models_json: "[]".to_owned(),
        };
        let _ = credentials::clear_key(ID);

        let unconfigured = to_provider(&row).expect("provider");
        assert!(!unconfigured.api_key_configured);
        assert!(models_yml::render_models_yml(&[unconfigured]).contains("    auth: none\n"));

        credentials::set_key(ID, "sk-selftest-not-a-real-key").expect("store the key");
        let configured = to_provider(&row).expect("provider");
        let _ = credentials::clear_key(ID);

        assert!(
            configured.api_key_configured,
            "a stored key must be reported regardless of the built-in env table"
        );
        let rendered = models_yml::render_models_yml(&[configured]);
        assert!(rendered.contains(&format!("    apiKey: {}\n", key_env(ID))));
        assert!(!rendered.contains("auth: none"));
    }
}
