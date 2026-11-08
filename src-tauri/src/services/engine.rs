//! The engine catalogue: the models the host can serve, and the providers this application offers.
//!
//! Model rows come from the running host - its cached catalogue for a plain read, `models_reload`
//! when the user changed a credential or a provider definition. The provider list is this
//! application's own knowledge instead: it has to answer before any host exists, because the
//! settings page needs it in order to accept a key at all (contract §8 F2).

use crate::errors::IpcResult;
use crate::models::agent::{EngineModel, ProviderSummary};
use crate::services::credentials;
use crate::services::runtime::host::HostRuntime;

/// One provider the user defined, as the settings page knows it.
pub(crate) struct CustomEntry {
    pub(crate) id: String,
    pub(crate) name: String,
    /// Environment variable this application injects the stored key into.
    pub(crate) key_env: String,
}

/// Models the host can currently offer.
///
/// `refresh` re-hydrates the host's credential-scoped model cache and is what a changed provider
/// key needs; a plain read answers from the catalogue the host already holds.
/// One commit message, drafted by the engine's own commit pipeline from `cwd`'s staged tree.
///
/// The engine owns this: it reads the staged diff, picks the model its settings give it, and
/// answers with a conventional message. Nothing here writes a prompt or a message of its own.
pub(crate) async fn commit_message(host: &HostRuntime, cwd: &str) -> IpcResult<String> {
    host.commit_message(cwd).await
}

pub(crate) async fn available_models(
    host: &HostRuntime,
    refresh: bool,
) -> IpcResult<Vec<EngineModel>> {
    host.models(refresh).await
}

/// The provider list this application offers: its own credential table, the user-defined
/// providers, and - when a host is already running - which of them the model catalogue knows.
///
/// Never fails. A fresh install has no credentials, and this list is what the settings page needs
/// before it can store one, so it must answer even when nothing else can.
pub(crate) async fn providers(host: &HostRuntime, custom: &[CustomEntry]) -> Vec<ProviderSummary> {
    // Read-only and best effort: the catalogue decides `available`, and a host that is not running
    // simply has no opinion. This read never starts one - `models_if_ready` checks readiness and
    // reads in one step, so the settings page (opened for exactly this list) cannot drag a process
    // up by racing a host that dies between a check and a read.
    let catalogue: Option<Vec<EngineModel>> = host.models_if_ready(false).await;
    let known: Vec<String> = catalogue
        .map(|models| models.into_iter().map(|model| model.provider).collect())
        .unwrap_or_default();

    let mut providers: Vec<ProviderSummary> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for entry in custom {
        if !seen.insert(entry.id.clone()) {
            continue;
        }
        providers.push(summary(&entry.id, &entry.name, &entry.key_env, &known));
    }
    for (id, api_key_env) in credentials::PROVIDER_ENV {
        if !seen.insert((*id).to_owned()) {
            continue;
        }
        providers.push(summary(id, &display_name(id), api_key_env, &known));
    }

    providers.sort_by(|left, right| {
        right
            .configured
            .cmp(&left.configured)
            .then_with(|| known.contains(&right.id).cmp(&known.contains(&left.id)))
            .then_with(|| left.id.cmp(&right.id))
    });
    providers
}

/// One row of the provider list. `available` is the model catalogue's answer when it has one, and
/// the entry stays offered when it does not: a provider whose key is merely missing is exactly
/// what the settings page has to be able to fix.
fn summary(id: &str, name: &str, api_key_env: &str, known: &[String]) -> ProviderSummary {
    let masks = credentials::stored_key_masks(id);
    ProviderSummary {
        id: id.to_owned(),
        name: name.to_owned(),
        api_key_env: api_key_env.to_owned(),
        configured: !masks.is_empty(),
        authenticated: !masks.is_empty(),
        available: known.is_empty() || known.iter().any(|provider| provider == id),
        api_key_masks: masks,
    }
}

/// Display name derived from the id (`openai-codex` -> `Openai Codex`), so the table stays a
/// mapping of ids to key variables instead of carrying fifty hand-written names.
fn display_name(provider_id: &str) -> String {
    provider_id
        .split(['-', '_'])
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut characters = word.chars();
            match characters.next() {
                Some(first) => first.to_uppercase().chain(characters).collect::<String>(),
                None => String::new(),
            }
        })
        .collect::<Vec<String>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_provider_without_a_display_name_still_gets_one() {
        assert_eq!(display_name("openai-codex"), "Openai Codex");
        assert_eq!(display_name("custom_provider"), "Custom Provider");
    }

    /// A configured provider sorts first, and a provider the catalogue knows outranks one it does
    /// not. Both rules are what the settings page relies on to put usable rows on top.
    #[test]
    fn configured_and_known_providers_sort_first() {
        let known = ["beta".to_owned()];
        let mut rows = [
            summary("alpha", "Alpha", "", &known),
            summary("beta", "Beta", "", &known),
            summary("gamma", "Gamma", "", &known),
        ];
        rows.sort_by(|left, right| {
            right
                .configured
                .cmp(&left.configured)
                .then_with(|| known.contains(&right.id).cmp(&known.contains(&left.id)))
                .then_with(|| left.id.cmp(&right.id))
        });
        assert_eq!(rows[0].id, "beta");
        assert!(rows[0].available);
        assert!(!rows[2].available);
    }
}
