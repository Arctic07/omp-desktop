//! The local-configuration import: what another omp installation on this machine configured, and
//! the one-click copy of it into this application.
//!
//! The split is the one every settings command here follows. The *host* owns the engine, so it reads
//! the other installation's files with the engine's own parsers and writes roles, MCP servers and
//! skills through the engine's own writers (`host/src/omp-import.ts`). This layer owns the two
//! things the host does not: the custom-provider registry (`models.yml` is generated here), and the
//! operating system credential store, which is the only home a provider key may have. The host
//! therefore hands the keys it read back under `keys`, this module stores them, and the answer the
//! page receives carries names and counts only.
//!
//! **Asked once.** `omp_import_probe` reports whether the first-run prompt has already been
//! answered; `omp_import_dismiss` records the answer when the user declines, and a completed import
//! records it too.

use std::path::{Path, PathBuf};

use tauri::State;

use crate::errors::{IpcError, IpcResult, CREDENTIAL_STORE_UNAVAILABLE, INVALID_INPUT};
use crate::models::agent::{CustomModelDefinition, CustomProviderInput};
use crate::models::omp_import::{
    ImportApplyView, ImportKeyRow, ImportProbeView, ImportScanView, ImportSkip,
};
use crate::services::store::{self, Store};
use crate::services::{credentials, custom_providers};
use crate::state::AppState;

/// The `preferences` key holding the first-run answer. Written once and never cleared, so the
/// prompt is asked exactly once even if a terminal omp appears on the machine later.
const IMPORT_PROMPTED_PREFERENCE: &str = "omp_import_prompted";

/// The engine's default config directory name relative to the user's home (omp's `CONFIG_DIR_NAME`).
const CONFIG_DIR_NAME: &str = ".omp";

/// The agent directory's own name inside the config root.
const AGENT_DIR_NAME: &str = "agent";

/// Entries that make the source directory worth importing from.
const IMPORTABLE_ENTRIES: &[&str] = &[
    "config.yml",
    "config.yaml",
    "models.yml",
    "models.yaml",
    "agent.db",
    "mcp.json",
    "skills",
];

/// The terminal omp installation's agent directory.
///
/// `HOME` (then `USERPROFILE`) is the real user profile here: the pinned copies belong to the
/// engine's child process, not to this one. `PI_CONFIG_DIR` overrides the directory name the way the
/// engine reads it, and a named profile lives under `profiles/<name>/agent`, exactly as the engine
/// lays it out.
pub(crate) fn source_directory() -> Option<PathBuf> {
    let home = real_home()?;
    let config_name = std::env::var("PI_CONFIG_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| CONFIG_DIR_NAME.to_owned());
    let config_root = home.join(config_name);
    let agent = match profile_name() {
        Some(profile) => config_root
            .join("profiles")
            .join(profile)
            .join(AGENT_DIR_NAME),
        None => config_root.join(AGENT_DIR_NAME),
    };
    Some(agent)
}

/// The real user profile: `HOME` (then `USERPROFILE`) as this process sees it.
///
/// The pinned copies belong to the engine's child process, not here, so this is the terminal
/// installation's own home - which is what both import readers need to look at.
pub(crate) fn real_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// `OMP_PROFILE` (then the legacy `PI_PROFILE`) when it names a directory the engine would use.
fn profile_name() -> Option<String> {
    let value = std::env::var("OMP_PROFILE")
        .ok()
        .or_else(|| std::env::var("PI_PROFILE").ok())?;
    profile_segment(&value)
}

/// The profile name as a path segment, or `None` when the engine would not use it either.
///
/// The name becomes a directory below the config root, so a value that is not a plain identifier is
/// ignored rather than joined: an environment variable must never be able to point the reader
/// outside that root. The shape is the engine's own profile rule, without its reserved-device list,
/// which only matters to a writer.
fn profile_segment(value: &str) -> Option<String> {
    let profile = value.trim();
    let usable = !profile.is_empty()
        && profile != "default"
        && profile.len() <= 64
        && !profile.ends_with('.')
        && profile.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && profile
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'));
    usable.then(|| profile.to_owned())
}

/// Whether the directory carries anything the import could read.
fn carries_configuration(directory: &Path) -> bool {
    IMPORTABLE_ENTRIES
        .iter()
        .any(|entry| directory.join(entry).exists())
}

fn directory(source: &Path) -> String {
    source.to_string_lossy().into_owned()
}

/// The first-run check: whether to ask at all, where from, and whether it is worth asking.
///
/// Answered from this process's own files and one preference read - no host is started, because
/// this runs while the window opens and a first-run prompt must not wait for the engine.
#[tauri::command]
pub(crate) async fn omp_import_probe(
    state: State<'_, AppState>,
) -> Result<ImportProbeView, IpcError> {
    let prompted = state
        .store
        .get_preference(IMPORT_PROMPTED_PREFERENCE)
        .await?
        .is_some();
    let Some(source) = source_directory() else {
        return Ok(ImportProbeView {
            prompted: true,
            source: String::new(),
            available: false,
        });
    };
    Ok(ImportProbeView {
        prompted,
        available: carries_configuration(&source),
        source: directory(&source),
    })
}

/// Reads the source directory and reports which of its items this application already holds.
///
/// `sourceDir` is optional: omitted means the terminal installation discovered from the environment,
/// which is what both entry points want. A caller may name another directory, and the host validates
/// it - absolute, existing, and never this application's own data root.
#[tauri::command]
pub(crate) async fn omp_import_scan(
    state: State<'_, AppState>,
    source_dir: Option<String>,
) -> Result<ImportScanView, IpcError> {
    let source = resolve_source(source_dir)?;
    state.runtime.omp_import_scan(&source).await
}

/// Copies the selected categories, skipping every identity this application already has.
///
/// The order is what makes one pass coherent: the custom providers land in this process's registry
/// and `models.yml` first (the host cannot write that file), the host then reloads its catalogue,
/// imports roles, MCP servers and skills, and reports the provider keys it found, and only then are
/// those keys stored - in the keyring, and in the running host as a runtime override, exactly as
/// the `provider_key_set` frame stores one.
#[tauri::command]
pub(crate) async fn omp_import_apply(
    state: State<'_, AppState>,
    source_dir: Option<String>,
    models: bool,
    mcp: bool,
    skills: bool,
) -> Result<ImportApplyView, IpcError> {
    let source = resolve_source(source_dir)?;
    let scan = state.runtime.omp_import_scan(&source).await?;
    if !scan.found {
        return Ok(ImportApplyView {
            source: scan.source,
            found: false,
            models: Default::default(),
            mcp: Default::default(),
            skills: Default::default(),
            providers_imported: Vec::new(),
            providers_skipped: Vec::new(),
            keys_stored: Vec::new(),
            warnings: scan.warnings,
            truncated: scan.truncated,
        });
    }

    let mut providers_imported = Vec::new();
    let mut providers_skipped = Vec::new();
    if models {
        let inputs: Vec<CustomProviderInput> = scan
            .models
            .providers
            .iter()
            .map(|provider| CustomProviderInput {
                id: provider.id.clone(),
                name: provider.name.clone(),
                base_url: provider.base_url.clone(),
                api: provider.api.clone(),
                models: provider
                    .models
                    .iter()
                    .map(|model| CustomModelDefinition {
                        id: model.id.clone(),
                        name: model.name.clone(),
                        context_window: model.context_window,
                        max_tokens: model.max_tokens,
                        supports_images: model.supports_images,
                        supports_reasoning: model.supports_reasoning,
                    })
                    .collect(),
            })
            .collect();
        for (id, skip) in
            custom_providers::import_missing(&state.store, &state.paths.agent_dir, inputs).await?
        {
            match skip {
                None => providers_imported.push(id),
                Some(reason) => providers_skipped.push(ImportSkip { name: id, reason }),
            }
        }
    }
    let catalogue_changed = !providers_imported.is_empty();

    let mut answer = state
        .runtime
        .omp_import_apply(&source, models, mcp, skills, catalogue_changed)
        .await?;
    let keys_stored = store_imported_keys(
        &state.store,
        &state.paths.agent_dir,
        &state.runtime,
        answer.keys,
    )
    .await;
    // A key this application already stored is not an import: the host cannot see the keyring, so
    // the credential rows are reconciled here with what was actually stored. Reported as skipped
    // rather than silently counted as copied.
    if models {
        for provider in std::mem::take(&mut answer.models.credentials_imported) {
            if keys_stored.contains(&provider) {
                answer.models.credentials_imported.push(provider);
            } else {
                answer.models.credentials_skipped.push(ImportSkip {
                    name: provider,
                    reason: "configured".to_owned(),
                });
            }
        }
    }

    Ok(ImportApplyView {
        source: scan.source,
        found: answer.found,
        models: answer.models,
        mcp: answer.mcp,
        skills: answer.skills,
        providers_imported,
        providers_skipped,
        keys_stored,
        warnings: answer.warnings,
        truncated: answer.truncated,
    })
}

/// Records that the first-run prompt has been answered, so it is never shown again.
#[tauri::command]
pub(crate) async fn omp_import_dismiss(state: State<'_, AppState>) -> Result<(), IpcError> {
    state
        .store
        .set_preference(IMPORT_PROMPTED_PREFERENCE, "true", store::now_ms())
        .await
}

/// Resolves the directory the import reads: the discovered terminal installation, or the one the
/// caller named. A missing directory is not refused - both commands answer `found: false`.
fn resolve_source(source_dir: Option<String>) -> IpcResult<String> {
    let Some(raw) = source_dir else {
        return source_directory()
            .map(|path| directory(&path))
            .ok_or_else(|| {
                IpcError::new(
                INVALID_INPUT,
                "This machine has no user profile the terminal omp configuration could live in.",
            )
            });
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(IpcError::new(
            INVALID_INPUT,
            "An import directory is required.",
        ));
    }
    if !PathBuf::from(trimmed).is_absolute() {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The import directory must be an absolute path.",
        ));
    }
    Ok(trimmed.to_owned())
}

/// Stores the provider keys the host handed back and pushes them into the running engine.
///
/// A provider whose keyring entry already exists is left alone: the key this application holds is
/// the user's local choice, and an import adds what is missing rather than replacing what is there.
/// The push is the same `provider_key_set` frame the built-in form used, so a key imported while a
/// host is running takes effect without restarting it; the next spawn reads the keyring itself
/// either way.
async fn store_imported_keys(
    store: &Store,
    agent_dir: &Path,
    runtime: &crate::services::runtime::HostRuntime,
    keys: Vec<ImportKeyRow>,
) -> Vec<String> {
    let mut stored = Vec::new();
    for row in keys {
        if row.provider.trim().is_empty() || row.key.trim().is_empty() {
            continue;
        }
        let provider = row.provider.clone();
        let already = tauri::async_runtime::spawn_blocking({
            let provider = provider.clone();
            move || credentials::stored_key(&provider).is_some()
        })
        .await
        .unwrap_or(true);
        if already {
            continue;
        }
        let (id, key) = (provider.clone(), row.key.clone());
        let written = tauri::async_runtime::spawn_blocking(move || credentials::set_key(&id, &key))
            .await
            .unwrap_or_else(|_| {
                Err(IpcError::new(
                    CREDENTIAL_STORE_UNAVAILABLE,
                    "The credential store task failed.",
                ))
            });
        if written.is_err() {
            continue;
        }
        runtime.provider_key_set(&provider, &row.key).await;
        stored.push(provider);
    }
    if !stored.is_empty() {
        // A stored key is what turns `auth: none` into an `apiKey:` line for a custom provider.
        let _ = custom_providers::sync_models_yml(store, agent_dir).await;
    }
    stored
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A profile name is joined onto the config root, so only a plain identifier may name one; the
    /// reserved spellings and anything that could climb out are ignored.
    #[test]
    fn only_a_plain_profile_name_is_joined_onto_the_config_root() {
        assert_eq!(profile_segment("work"), Some("work".to_owned()));
        assert_eq!(profile_segment(" work "), Some("work".to_owned()));
        assert_eq!(profile_segment("a.b_c-1"), Some("a.b_c-1".to_owned()));
        assert_eq!(profile_segment("default"), None);
        assert_eq!(profile_segment(""), None);
        assert_eq!(profile_segment(".."), None);
        assert_eq!(profile_segment("../escape"), None);
        assert_eq!(profile_segment("C:\\Users"), None);
        assert_eq!(profile_segment("Work"), None);
        assert_eq!(profile_segment(&"a".repeat(65)), None);
    }

    /// The source directory follows the engine's own layout, and it is a candidate whether or not it
    /// exists: a directory that is not there is answered as `found: false`, not as an error.
    #[test]
    fn the_source_directory_is_the_engine_layout_below_the_profile() {
        let root = std::env::temp_dir().join(format!("omp-import-paths-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        assert!(!carries_configuration(&root), "nothing there yet");
        std::fs::create_dir_all(root.join("skills")).expect("fixture");
        assert!(
            carries_configuration(&root),
            "a skills directory is importable material"
        );
        fs_cleanup(&root);
    }

    fn fs_cleanup(root: &Path) {
        let _ = std::fs::remove_dir_all(root);
    }
}
