//! Provider API keys, stored in the operating system credential store.
//!
//! Secrets are read on demand and handed to the engine process as environment variables; the
//! host never writes them to disk, logs or process arguments.

use std::sync::LazyLock;

use crate::errors::{IpcError, IpcResult, CREDENTIAL_STORE_UNAVAILABLE, INVALID_INPUT};

/// Keyring service name; every entry the application owns lives under it.
pub(crate) const SERVICE: &str = "com.omp.desktop";

/// Entry used only to probe whether the OS credential store answers. It is never written.
const PROBE_USER: &str = "__probe__";

const KEY_NOT_MAPPED: &str = "This provider has no API key environment mapping.";
const KEY_INVALID: &str =
    "An API key must not be empty, contain control characters, or exceed the length limit.";
const KEY_WRITE_FAILED: &str =
    "The API key could not be stored in the operating system credential store.";

/// Provider id -> environment variable the engine reads the key from (omp docs/providers.md).
///
/// Providers missing here authenticate through a flow this application does not implement, so
/// `api_key_env` reports an empty name and the settings UI offers no input field.
pub(crate) const PROVIDER_ENV: &[(&str, &str)] = &[
    ("anthropic", "ANTHROPIC_API_KEY"),
    ("openai", "OPENAI_API_KEY"),
    ("google", "GEMINI_API_KEY"),
    ("groq", "GROQ_API_KEY"),
    ("openrouter", "OPENROUTER_API_KEY"),
    ("mistral", "MISTRAL_API_KEY"),
    ("xai", "XAI_API_KEY"),
    ("azure", "AZURE_OPENAI_API_KEY"),
    ("cerebras", "CEREBRAS_API_KEY"),
    ("deepinfra", "DEEPINFRA_API_KEY"),
    ("deepseek", "DEEPSEEK_API_KEY"),
    ("siliconflow", "SILICONFLOW_API_KEY"),
    ("siliconflow-cn", "SILICONFLOW_CN_API_KEY"),
    ("fireworks", "FIREWORKS_API_KEY"),
    ("together", "TOGETHER_API_KEY"),
    ("coreweave", "COREWEAVE_API_KEY"),
    ("nvidia", "NVIDIA_API_KEY"),
    ("devin", "DEVIN_API_KEY"),
    ("gmi-cloud", "GMI_API_KEY"),
    ("moonshot", "MOONSHOT_API_KEY"),
    ("meta", "META_API_KEY"),
    ("nanogpt", "NANO_GPT_API_KEY"),
    ("novita", "NOVITA_API_KEY"),
    ("venice", "VENICE_API_KEY"),
    ("vercel-ai-gateway", "AI_GATEWAY_API_KEY"),
    ("litellm", "LITELLM_API_KEY"),
    ("kilo", "KILO_API_KEY"),
    ("zai", "ZAI_API_KEY"),
    ("zenmux", "ZENMUX_API_KEY"),
    ("zhipu-coding-plan", "ZHIPU_API_KEY"),
    ("qianfan", "QIANFAN_API_KEY"),
    ("synthetic", "SYNTHETIC_API_KEY"),
    ("minimax", "MINIMAX_API_KEY"),
    ("minimax-code", "MINIMAX_CODE_API_KEY"),
    ("minimax-code-cn", "MINIMAX_CODE_CN_API_KEY"),
    ("sakana", "SAKANA_API_KEY"),
    ("aimlapi", "AIMLAPI_API_KEY"),
    ("opencode-zen", "OPENCODE_API_KEY"),
    ("opencode-go", "OPENCODE_API_KEY"),
    ("cline-pass", "CLINE_API_KEY"),
    ("firepass", "FIREPASS_API_KEY"),
    ("wafer-serverless", "WAFER_SERVERLESS_API_KEY"),
    ("xiaomi", "XIAOMI_API_KEY"),
    ("ollama-cloud", "OLLAMA_CLOUD_API_KEY"),
    ("ollama", "OLLAMA_API_KEY"),
    ("lm-studio", "LM_STUDIO_API_KEY"),
    ("baseten", "BASETEN_API_KEY"),
    ("aiand", "AIAND_API_KEY"),
    ("huggingface", "HF_TOKEN"),
    ("yolo-auto", "YOLO_AUTO_API_KEY"),
];

/// Longest key this application stores, in characters.
///
/// Real credentials are far shorter (an OAuth-style JWT is one to two KiB); the cap mirrors the
/// host's own bound on the frame field, so a value the settings page accepted is never refused
/// after it has already been written to the credential store.
pub(crate) const KEY_CHARS_MAX: usize = 4_096;

/// Most keys one provider may carry.
///
/// The engine rotates across stored credentials, so this is a failover pool, not a bulk store.
/// Eight is far past any real quota-sharing setup and keeps one keyring entry's JSON payload
/// inside Windows Credential Manager's 2,560-byte blob.
pub(crate) const PROVIDER_KEYS_MAX: usize = 8;

/// Ceiling on the JSON payload of a multi-key entry.
///
/// Windows stores a generic credential as one blob capped at 2,560 bytes; the margin leaves room
/// for the JSON punctuation and a future field.
const KEYRING_BLOB_MAX_BYTES: usize = 2_400;

/// Ceiling on the pool payload.
///
/// Windows caps the whole environment block a child can receive; the pool is the only value here
/// that scales with the user's provider count, so it carries its own bound and is dropped with an
/// error line rather than failing the spawn for every provider.
pub(crate) const PROVIDER_KEYS_PAYLOAD_MAX_BYTES: usize = 24_000;

/// Most providers one spawn payload may carry pools for.
///
/// The whole payload rides one environment variable; past this many pooled providers the Windows
/// environment block is the limit rather than the user's setup.
pub(crate) const PROVIDER_POOLS_MAX: usize = 64;

/// The provider's keys and the environment variable a single key is injected through.
pub(crate) struct ProviderKeySet {
    pub(crate) provider: String,
    pub(crate) env: String,
    pub(crate) keys: Vec<String>,
}

/// The child environment's split of provider keys.
///
/// One key travels in the provider's own variable, exactly as before: every engine path that reads
/// a provider key from the environment keeps working. Two or more keys travel together in
/// `PROVIDER_KEYS_ENV`, because a single environment variable cannot express a rotation pool; the
/// host installs that pool as in-memory credentials. The host also deletes the single-key variable
/// for a pooled provider, so the pool is not shadowed by the environment tier.
pub(crate) struct ProviderKeys {
    pub(crate) single: Vec<(String, String)>,
    pub(crate) multi: Vec<ProviderKeySet>,
    /// Every keyed provider's variable, single and pooled alike. The host uses it as the allow-list
    /// for the environment names a live frame may name.
    pub(crate) env_names: Vec<(String, String)>,
    /// Every built-in provider id. The host must never derive a custom variable for one of these:
    /// its real variable is the table's, and a derived name would carry the key nowhere.
    pub(crate) builtin_ids: Vec<String>,
}

/// The child environment's pool payload: the pools, every keyed provider's variable, and the
/// built-in ids, as one JSON object. `None` when there is nothing to say or when the payload would
/// exceed the platform's environment block - the caller logs the latter and starts the host without
/// pools rather than failing the spawn for every provider.
pub(crate) fn provider_keys_payload(keys: &ProviderKeys) -> Option<String> {
    if keys.builtin_ids.is_empty() {
        return None;
    }
    let pools = keys
        .multi
        .iter()
        .map(|set| {
            (
                set.provider.clone(),
                serde_json::json!({ "env": set.env, "keys": set.keys }),
            )
        })
        .collect::<serde_json::Map<String, serde_json::Value>>();
    let env_names = keys
        .env_names
        .iter()
        .map(|(provider, env)| (provider.clone(), serde_json::Value::String(env.clone())))
        .collect::<serde_json::Map<String, serde_json::Value>>();
    let builtin = keys
        .builtin_ids
        .iter()
        .map(|id| serde_json::Value::String(id.clone()))
        .collect::<Vec<serde_json::Value>>();
    let payload = serde_json::json!({
        "pools": serde_json::Value::Object(pools),
        "env": serde_json::Value::Object(env_names),
        "builtin": serde_json::Value::Array(builtin),
    })
    .to_string();
    if payload.len() > PROVIDER_KEYS_PAYLOAD_MAX_BYTES {
        crate::services::log::error(&format!(
            "provider key pools exceed {PROVIDER_KEYS_PAYLOAD_MAX_BYTES} bytes and were not injected"
        ));
        return None;
    }
    Some(payload)
}

/// Environment variable name for `provider_id`, or `""` when the provider has no mapping.
pub(crate) fn api_key_env(provider_id: &str) -> &'static str {
    for (id, env_name) in PROVIDER_ENV {
        if *id == provider_id {
            return env_name;
        }
    }
    ""
}

/// `"os-keyring"` when the platform store answered a sentry lookup, `"unavailable"` otherwise.
///
/// Probed once per process: some platforms only fail on first use, and the answer is stable for
/// the lifetime of the process.
pub(crate) fn credential_backend() -> &'static str {
    static BACKEND: LazyLock<&'static str> = LazyLock::new(|| {
        if probe_store() {
            "os-keyring"
        } else {
            "unavailable"
        }
    });
    *BACKEND
}

/// Every key stored for one provider, in the order the user entered them.
///
/// One key is written as the raw string so a build that predates multi-key support can still read
/// it; two or more are a JSON array in the same keyring entry. A value that starts with `[` but
/// does not parse is treated as one literal key rather than dropped.
pub(crate) fn stored_keys(provider_id: &str) -> Vec<String> {
    let Some(value) = stored_raw(provider_id) else {
        return Vec::new();
    };
    decode_keys(&value)
}

/// The keyring payload as keys: one raw string, or a JSON array for a rotation pool.
fn decode_keys(value: &str) -> Vec<String> {
    let keys = if value.starts_with('[') {
        serde_json::from_str::<Vec<String>>(value).unwrap_or_else(|_| vec![value.to_owned()])
    } else {
        vec![value.to_owned()]
    };
    match normalize_keys(&keys) {
        Ok(keys) => keys,
        Err(()) => {
            // A stored payload outside the bounds is a credential the engine cannot use; say so
            // instead of reporting the provider as having no key at all.
            crate::services::log::warn(
                "a stored provider key was outside the accepted bounds and was ignored",
            );
            Vec::new()
        }
    }
}

/// Trims, drops empty rows, dedupes, and enforces the per-key bounds.
///
/// Empty input is allowed here because an "add these keys" edit may add none; the callers that
/// require a non-empty result say so themselves.
fn normalize_entries(keys: &[String]) -> Result<Vec<String>, ()> {
    let mut normalized: Vec<String> = Vec::new();
    for key in keys {
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        // The same bound the write path enforces (`commands::providers`), counted in characters:
        // a byte bound here would refuse a multibyte key the page accepted.
        if key.chars().count() > KEY_CHARS_MAX || key.chars().any(char::is_control) {
            return Err(());
        }
        if !normalized.iter().any(|existing| existing == key) {
            normalized.push(key.to_owned());
        }
    }
    if normalized.len() > PROVIDER_KEYS_MAX {
        return Err(());
    }
    Ok(normalized)
}

/// The entries one keyring write accepts: at least one, and no more than the pool bound.
fn normalize_keys(keys: &[String]) -> Result<Vec<String>, ()> {
    let normalized = normalize_entries(keys)?;
    if normalized.is_empty() {
        return Err(());
    }
    Ok(normalized)
}

/// A display form of one key: enough prefix and suffix to tell two keys apart, never enough to use.
///
/// This is what a settings page shows for a key it must not reveal; it is derived on every read and
/// never stored. The ends shrink with the key instead of vanishing: four characters from each end at
/// sixteen or more, two at eight, one below that, and a one-character key is itself, because there is
/// no middle left to hide. A two-character key has no middle either, so both of its characters show.
pub(crate) fn mask_key(key: &str) -> String {
    let characters: Vec<char> = key.chars().collect();
    let length = characters.len();
    let visible = match length {
        16.. => 4,
        8..=15 => 2,
        2..=7 => 1,
        _ => 0,
    };
    if visible == 0 {
        // The empty key is never stored; masking it keeps this total.
        return if length == 0 {
            "*****".to_owned()
        } else {
            key.to_owned()
        };
    }
    format!(
        "{}*****{}",
        characters[..visible].iter().collect::<String>(),
        characters[length - visible..].iter().collect::<String>()
    )
}

/// Every stored key's masked display form, in stored order.
pub(crate) fn stored_key_masks(provider_id: &str) -> Vec<String> {
    stored_keys(provider_id)
        .iter()
        .map(|key| mask_key(key))
        .collect()
}

/// Applies one edit to a provider's pool: remove the named positions, then append the new keys.
///
/// The editor shows masks, never the keys, so an edit cannot send the whole list back. Removing by
/// position is safe here because this application is the only writer of the keyring entry. An edit
/// that leaves nothing clears the entry rather than storing an empty pool.
pub(crate) fn apply_keys(
    provider_id: &str,
    remove: &[usize],
    add: &[String],
) -> IpcResult<Vec<String>> {
    if !is_storable_provider_id(provider_id) {
        return Err(IpcError::new(INVALID_INPUT, KEY_NOT_MAPPED));
    }
    let mut keys = stored_keys(provider_id);
    let mut positions: Vec<usize> = remove
        .iter()
        .copied()
        .filter(|index| *index < keys.len())
        .collect();
    positions.sort_unstable();
    positions.dedup();
    for index in positions.into_iter().rev() {
        keys.remove(index);
    }
    let additions =
        normalize_entries(add).map_err(|_| IpcError::new(INVALID_INPUT, KEY_INVALID))?;
    for key in additions {
        if !keys.iter().any(|existing| existing == &key) {
            keys.push(key);
        }
    }
    if keys.len() > PROVIDER_KEYS_MAX {
        return Err(IpcError::new(INVALID_INPUT, KEY_INVALID));
    }
    if keys.is_empty() {
        clear_key(provider_id)?;
    } else {
        set_keys(provider_id, &keys)?;
    }
    Ok(keys)
}

/// `(ENV_NAME, API_KEY)` for every provider with exactly one stored key, plus the rotation pools
/// for providers with more than one.
///
/// Environment names are unique in the result: two providers may share one variable
/// (`opencode-zen` / `opencode-go`), and injecting the same variable twice would silently pick a
/// winner by table order at spawn time.
///
/// `custom` carries the user-defined providers as `(provider_id, environment name)` pairs; their
/// names are generated by the host (they are not in the built-in table) and their keys live in the
/// same credential store.
pub(crate) fn provider_keys(custom: &[(String, String)]) -> ProviderKeys {
    let built_in = PROVIDER_ENV
        .iter()
        .map(|(id, env)| ((*id).to_owned(), (*env).to_owned()));
    let pairs: Vec<(String, String)> = built_in.chain(custom.iter().cloned()).collect();
    let mut seen_env: Vec<String> = Vec::new();
    let mut single: Vec<(String, String)> = Vec::new();
    let mut multi: Vec<ProviderKeySet> = Vec::new();
    let mut env_names: Vec<(String, String)> = Vec::new();
    for (provider, env) in pairs {
        if seen_env.iter().any(|existing| existing == &env) {
            continue;
        }
        let keys = stored_keys(&provider);
        if keys.is_empty() {
            continue;
        }
        seen_env.push(env.clone());
        env_names.push((provider.clone(), env.clone()));
        if keys.len() == 1 {
            single.push((env, keys.into_iter().next().unwrap_or_default()));
        } else {
            multi.push(ProviderKeySet {
                provider,
                env,
                keys,
            });
        }
    }
    if env_names.len() > PROVIDER_POOLS_MAX {
        crate::services::log::warn(&format!(
            "more than {PROVIDER_POOLS_MAX} providers carry keys; the extra ones keep only their own variable"
        ));
        env_names.truncate(PROVIDER_POOLS_MAX);
        multi.retain(|set| {
            env_names
                .iter()
                .any(|(provider, _)| provider == &set.provider)
        });
    }
    ProviderKeys {
        single,
        multi,
        env_names,
        builtin_ids: PROVIDER_ENV
            .iter()
            .map(|(id, _)| (*id).to_owned())
            .collect(),
    }
}

/// Stores every key for `provider_id`, replacing what was there.
pub(crate) fn set_keys(provider_id: &str, api_keys: &[String]) -> IpcResult<()> {
    if !is_storable_provider_id(provider_id) {
        return Err(IpcError::new(INVALID_INPUT, KEY_NOT_MAPPED));
    }
    let keys = normalize_keys(api_keys).map_err(|_| IpcError::new(INVALID_INPUT, KEY_INVALID))?;
    // A pool is one JSON value in one credential-store entry, so the store's blob bound applies to
    // it. A single key is its own value and is bounded by `KEY_CHARS_MAX`; applying the pool's
    // ceiling to it would refuse a key the platforms without that ceiling can store.
    let pool = keys.len() > 1;
    let payload = if pool {
        serde_json::to_string(&keys).map_err(|_| IpcError::new(INVALID_INPUT, KEY_WRITE_FAILED))?
    } else {
        keys.into_iter().next().unwrap_or_default()
    };
    if pool && payload.len() > KEYRING_BLOB_MAX_BYTES {
        return Err(IpcError::from_message(
            INVALID_INPUT,
            format!(
                "The keys are too long to store together: one provider may hold at most {KEYRING_BLOB_MAX_BYTES} bytes in the operating system credential store."
            ),
        ));
    }
    let entry = open_entry(provider_id)
        .map_err(|_| IpcError::new(CREDENTIAL_STORE_UNAVAILABLE, KEY_WRITE_FAILED))?;
    entry
        .set_password(&payload)
        .map_err(|_| IpcError::new(CREDENTIAL_STORE_UNAVAILABLE, KEY_WRITE_FAILED))
}

/// Provider ids the host stores a key for: everything in the table, plus the ids of user-defined
/// providers.
///
/// A user-defined id is also the provider key in `models.yml` and the suffix of the environment
/// variable this application injects the key through, so the shape is limited to characters that
/// are literal in both - and to ids an imported installation can carry over unchanged: the engine
/// accepts `nextcodeGm` as a provider key, and rewriting it would leave the imported model roles
/// naming a provider that no longer exists.
pub(crate) fn is_storable_provider_id(provider_id: &str) -> bool {
    !api_key_env(provider_id).is_empty()
        || (provider_id.len() <= 64
            && provider_id.starts_with(|character: char| character.is_ascii_alphanumeric())
            && provider_id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
            }))
}

/// Stores the key for `provider_id`. Plaintext fallback is never used.
pub(crate) fn set_key(provider_id: &str, api_key: &str) -> IpcResult<()> {
    set_keys(provider_id, &[api_key.to_owned()])
}

/// Removes the stored key for `provider_id`. Missing entries are a success (idempotent).
pub(crate) fn clear_key(provider_id: &str) -> IpcResult<()> {
    if !is_storable_provider_id(provider_id) {
        return Err(IpcError::new(INVALID_INPUT, KEY_NOT_MAPPED));
    }
    let entry = open_entry(provider_id)
        .map_err(|_| IpcError::new(CREDENTIAL_STORE_UNAVAILABLE, KEY_WRITE_FAILED))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(IpcError::new(
            CREDENTIAL_STORE_UNAVAILABLE,
            KEY_WRITE_FAILED,
        )),
    }
}

/// Reads the first stored key. `None` covers both "no entry" and "store unreadable"; the
/// distinction does not change how a caller behaves.
///
/// The model-list probe reads it directly: a saved provider's key field is a *replacement* field,
/// so an empty field means "use the key already stored", not "probe without a key".
pub(crate) fn stored_key(provider_id: &str) -> Option<String> {
    stored_keys(provider_id).into_iter().next()
}

/// The raw keyring payload, before the single-key / JSON-array split.
fn stored_raw(provider_id: &str) -> Option<String> {
    let entry = open_entry(provider_id).ok()?;
    let value = entry.get_password().ok()?;
    let value = value.trim().to_owned();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn open_entry(provider_id: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, &format!("provider:{provider_id}"))
}

/// A readable sentry entry and an absent sentry entry both prove the store answered.
fn probe_store() -> bool {
    let entry = match keyring::Entry::new(SERVICE, PROBE_USER) {
        Ok(entry) => entry,
        Err(_) => return false,
    };
    matches!(entry.get_password(), Ok(_) | Err(keyring::Error::NoEntry))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A payload written before multi-key support is one raw key, and it must stay readable.
    #[test]
    fn a_single_raw_key_is_one_key() {
        assert_eq!(decode_keys("sk-legacy"), vec!["sk-legacy"]);
        assert_eq!(decode_keys("  sk-padded  "), vec!["sk-padded"]);
    }

    /// A rotation pool is the JSON array the writer produces.
    #[test]
    fn a_json_array_is_every_key_in_order() {
        assert_eq!(
            decode_keys(r#"["one","two","three"]"#),
            vec!["one", "two", "three"]
        );
        assert_eq!(decode_keys(r#"[" one ", "two"]"#), vec!["one", "two"]);
    }

    /// A key that happens to start with `[` but is not JSON must not disappear.
    #[test]
    fn a_bracket_prefixed_key_survives_a_failed_parse() {
        assert_eq!(decode_keys("[not-json"), vec!["[not-json"]);
    }

    /// The display form keeps enough to tell two keys apart and nothing that identifies the rest.
    /// A key too short for the usual ends still shows one character from each end.
    #[test]
    fn a_key_is_masked_by_its_ends() {
        assert_eq!(mask_key("sk-abcdefghijklmnop"), "sk-a*****mnop");
        assert_eq!(mask_key("abcdefgh"), "ab*****gh");
        assert_eq!(mask_key("short"), "s*****t");
        assert_eq!(mask_key("ab"), "a*****b");
        assert_eq!(mask_key("a"), "a");
        assert_eq!(mask_key(""), "*****");
        assert_eq!(mask_key("密文字符很长的密钥值"), "密文*****钥值");
    }

    /// The spawn payload carries the pools, every keyed provider's variable, and the built-in ids,
    /// and a payload past the platform's block is dropped rather than failing the spawn.
    #[test]
    fn the_spawn_payload_carries_pools_and_builtin_ids() {
        let keys = ProviderKeys {
            single: vec![("ANTHROPIC_API_KEY".to_owned(), "k".to_owned())],
            multi: vec![ProviderKeySet {
                provider: "edge".to_owned(),
                env: "EDGE_KEY".to_owned(),
                keys: vec!["k-one".to_owned(), "k-two".to_owned()],
            }],
            env_names: vec![
                ("anthropic".to_owned(), "ANTHROPIC_API_KEY".to_owned()),
                ("edge".to_owned(), "EDGE_KEY".to_owned()),
            ],
            builtin_ids: vec!["anthropic".to_owned(), "openai".to_owned()],
        };
        let payload: serde_json::Value =
            serde_json::from_str(&provider_keys_payload(&keys).expect("payload")).expect("json");
        assert_eq!(
            payload["builtin"],
            serde_json::json!(["anthropic", "openai"])
        );
        assert_eq!(payload["env"]["edge"], "EDGE_KEY");
        assert_eq!(
            payload["pools"]["edge"]["keys"],
            serde_json::json!(["k-one", "k-two"])
        );
    }

    #[test]
    fn a_payload_over_the_byte_cap_is_dropped() {
        let keys = ProviderKeys {
            single: Vec::new(),
            multi: vec![ProviderKeySet {
                provider: "edge".to_owned(),
                env: "EDGE_KEY".to_owned(),
                keys: vec!["k".repeat(4_000); PROVIDER_KEYS_MAX],
            }],
            env_names: Vec::new(),
            builtin_ids: vec!["anthropic".to_owned()],
        };
        assert!(provider_keys_payload(&keys).is_none());
    }

    /// One edit removes the named positions and appends the new keys; removing everything clears
    /// the entry instead of storing an empty pool, and a repeated or out-of-range position is
    /// ignored rather than removing a neighbour.
    #[test]
    fn an_apply_removes_positions_and_appends_keys() {
        if credential_backend() != "os-keyring" {
            return;
        }
        const ID: &str = "custom-apply-test";
        let _ = clear_key(ID);
        set_keys(ID, &["k0".to_owned(), "k1".to_owned(), "k2".to_owned()]).expect("seed the pool");

        let left = apply_keys(ID, &[1, 1, 99], &["k3".to_owned()]).expect("apply the edit");
        assert_eq!(left, vec!["k0", "k2", "k3"]);
        assert_eq!(stored_keys(ID), left);

        let empty = apply_keys(ID, &[0, 1, 2], &[]).expect("remove every key");
        assert!(empty.is_empty());
        assert!(stored_keys(ID).is_empty());
        let _ = clear_key(ID);
    }

    /// The read path and the write path must agree on the bound; a byte count here refused a
    /// multibyte key the page had accepted.
    #[test]
    fn the_key_bound_is_counted_in_characters() {
        let at_bound = "k".repeat(KEY_CHARS_MAX);
        assert_eq!(
            normalize_keys(&[at_bound.clone()]).expect("at the bound"),
            vec![at_bound]
        );
        let over = "k".repeat(KEY_CHARS_MAX + 1);
        assert!(normalize_keys(&[over]).is_err());
        let multibyte = "密".repeat(KEY_CHARS_MAX);
        assert_eq!(
            normalize_keys(&[multibyte.clone()]).expect("characters, not bytes"),
            vec![multibyte]
        );
    }

    #[test]
    fn empty_duplicate_and_invalid_keys_are_refused() {
        assert!(normalize_keys(&[]).is_err());
        assert!(normalize_keys(&["  ".to_owned()]).is_err());
        assert!(normalize_keys(&["a\nb".to_owned()]).is_err());
        assert_eq!(
            normalize_keys(&["a".to_owned(), "a".to_owned()]).expect("deduped"),
            vec!["a"]
        );
        let too_many: Vec<String> = (0..=PROVIDER_KEYS_MAX).map(|n| format!("k{n}")).collect();
        assert!(normalize_keys(&too_many).is_err());
    }
}
