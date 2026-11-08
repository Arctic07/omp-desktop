//! The DTOs of the local-configuration import: what another omp installation offers, and what this
//! application copied out of it.
//!
//! Every type mirrors one frame payload field for field, using the camelCase spelling the frontend
//! declares, and derives `Deserialize` as well as `Serialize` so a host answer is read straight into
//! the type a command returns. `keys` is the one field that never leaves this layer: it carries
//! provider secrets from the host to the keyring, so it is read, stored and dropped.

use serde::{Deserialize, Serialize};

// ---- scan ----

/// One model role the source configures, with this application's judgement of it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ImportRoleRow {
    #[serde(default)]
    pub(crate) role: String,
    #[serde(default)]
    pub(crate) selector: String,
    /// `importable` | `configured` | `unsupported` | `unresolved`. A closed vocabulary the page
    /// words itself; the host never sends a sentence for a status.
    #[serde(default)]
    pub(crate) status: String,
}

/// One provider credential the source's auth store holds.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ImportCredentialRow {
    #[serde(default)]
    pub(crate) provider: String,
    /// `api_key` | `oauth`.
    #[serde(default)]
    pub(crate) kind: String,
    /// `importable` | `unsupported`.
    #[serde(default)]
    pub(crate) status: String,
}

/// One custom provider definition the source's `models.yml` carries.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ImportProviderRow {
    #[serde(default)]
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) name: String,
    #[serde(default, rename = "baseUrl")]
    pub(crate) base_url: String,
    #[serde(default)]
    pub(crate) api: String,
    /// The models this provider defines, in the shape this application's registry stores.
    #[serde(default)]
    pub(crate) models: Vec<crate::models::agent::CustomModelDefinition>,
    /// Whether the source carried a literal key for it. The key itself never enters this payload.
    #[serde(default, rename = "hasKey")]
    pub(crate) has_key: bool,
}

/// One MCP server definition the source's `mcp.json` carries.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ImportServerRow {
    #[serde(default)]
    pub(crate) name: String,
    /// `stdio` | `http` | `sse`.
    #[serde(default)]
    pub(crate) transport: String,
    #[serde(default)]
    pub(crate) target: String,
    /// `importable` | `configured`.
    #[serde(default)]
    pub(crate) status: String,
}

/// One skill the source's agent directory carries.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ImportSkillRow {
    #[serde(default)]
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) description: String,
    /// `importable` | `configured`.
    #[serde(default)]
    pub(crate) status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct ImportModelsScan {
    #[serde(default)]
    pub(crate) roles: Vec<ImportRoleRow>,
    #[serde(default)]
    pub(crate) credentials: Vec<ImportCredentialRow>,
    #[serde(default)]
    pub(crate) providers: Vec<ImportProviderRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct ImportMcpScan {
    #[serde(default)]
    pub(crate) servers: Vec<ImportServerRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct ImportSkillsScan {
    #[serde(default)]
    pub(crate) skills: Vec<ImportSkillRow>,
}

/// `omp_import_scan`: what the source directory offers, and which of it this engine already holds.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct ImportScanView {
    /// The absolute agent directory that was read.
    #[serde(default)]
    pub(crate) source: String,
    /// False when the directory is not there (an application with no terminal omp beside it).
    #[serde(default)]
    pub(crate) found: bool,
    #[serde(default)]
    pub(crate) models: ImportModelsScan,
    #[serde(default)]
    pub(crate) mcp: ImportMcpScan,
    #[serde(default)]
    pub(crate) skills: ImportSkillsScan,
    #[serde(default)]
    pub(crate) warnings: Vec<String>,
    #[serde(default)]
    pub(crate) truncated: bool,
}

// ---- apply ----

/// One identity the apply skipped, and the closed reason word for it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ImportSkip {
    #[serde(default)]
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct ImportModelsApplied {
    #[serde(default, rename = "rolesImported")]
    pub(crate) roles_imported: Vec<String>,
    #[serde(default, rename = "rolesSkipped")]
    pub(crate) roles_skipped: Vec<ImportSkip>,
    #[serde(default, rename = "credentialsImported")]
    pub(crate) credentials_imported: Vec<String>,
    #[serde(default, rename = "credentialsSkipped")]
    pub(crate) credentials_skipped: Vec<ImportSkip>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct ImportMcpApplied {
    #[serde(default)]
    pub(crate) imported: Vec<String>,
    #[serde(default)]
    pub(crate) skipped: Vec<ImportSkip>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct ImportSkillsApplied {
    #[serde(default)]
    pub(crate) imported: Vec<String>,
    #[serde(default)]
    pub(crate) skipped: Vec<ImportSkip>,
}

/// One provider key the host hands over for the keyring. Never serialized to the page.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ImportKeyRow {
    #[serde(default)]
    pub(crate) provider: String,
    #[serde(default)]
    pub(crate) key: String,
}

/// The host's `omp_import_apply` answer, including the one field the page never sees.
#[derive(Debug, Clone, Deserialize, Default)]
pub(crate) struct ImportApplyAnswer {
    #[serde(default)]
    pub(crate) found: bool,
    #[serde(default)]
    pub(crate) models: ImportModelsApplied,
    #[serde(default)]
    pub(crate) mcp: ImportMcpApplied,
    #[serde(default)]
    pub(crate) skills: ImportSkillsApplied,
    #[serde(default)]
    pub(crate) keys: Vec<ImportKeyRow>,
    #[serde(default)]
    pub(crate) warnings: Vec<String>,
    #[serde(default)]
    pub(crate) truncated: bool,
}

/// What the page renders after an import: the answer without the keys, plus what this layer did
/// with the custom providers and the keyring.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct ImportApplyView {
    pub(crate) source: String,
    pub(crate) found: bool,
    pub(crate) models: ImportModelsApplied,
    pub(crate) mcp: ImportMcpApplied,
    pub(crate) skills: ImportSkillsApplied,
    /// Custom providers this layer added to its own registry (the host does not own that store).
    #[serde(rename = "providersImported")]
    pub(crate) providers_imported: Vec<String>,
    /// Custom providers already defined here, or refused by the registry's own rules.
    #[serde(rename = "providersSkipped")]
    pub(crate) providers_skipped: Vec<ImportSkip>,
    /// Providers whose key landed in the operating system credential store.
    #[serde(rename = "keysStored")]
    pub(crate) keys_stored: Vec<String>,
    pub(crate) warnings: Vec<String>,
    pub(crate) truncated: bool,
}

// ---- probe ----

/// What the first-run check needs, without starting the engine: whether the application should ask
/// at all, and where it would read from.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct ImportProbeView {
    /// Whether the user already answered the prompt. Answered once, never asked again.
    pub(crate) prompted: bool,
    /// The agent directory the import would read, whether or not it exists.
    pub(crate) source: String,
    /// Whether that directory carries anything this application could import.
    pub(crate) available: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frames the host actually answered in the fixture run (2026-11-01), trimmed to the shape
    /// that matters: every key present, one row per status, and the keys only in the apply answer.
    ///
    /// This is the contract's other half - `host/src/omp-import.ts` writes these names, and a
    /// rename on either side has to fail here rather than in a dialog that shows blanks.
    const SCAN: &str = r#"{
      "source": "C:\\Users\\x\\.omp\\agent",
      "found": true,
      "models": {
        "roles": [
          {"role": "default", "selector": "fixtureprov/fixture-model:high", "status": "importable"},
          {"role": "plan", "selector": "nowhere/nothing", "status": "unresolved"}
        ],
        "credentials": [{"provider": "cline-pass", "kind": "api_key", "status": "importable"}],
        "providers": [
          {
            "id": "fixtureprov",
            "name": "fixtureprov",
            "baseUrl": "http://127.0.0.1:9/v1",
            "api": "openai-completions",
            "hasKey": true,
            "models": [
              {
                "id": "fixture-model",
                "name": "Fixture Model",
                "contextWindow": 100000,
                "maxTokens": 4096,
                "supportsImages": true,
                "supportsReasoning": true
              }
            ]
          }
        ]
      },
      "mcp": {"servers": [{"name": "fixture-server", "transport": "stdio", "target": "npx -y fixture-mcp", "status": "importable"}]},
      "skills": {"skills": [{"name": "fixture-skill", "description": "A skill", "status": "importable"}]},
      "warnings": [],
      "truncated": false
    }"#;

    const APPLY: &str = r#"{
      "source": "C:\\Users\\x\\.omp\\agent",
      "found": true,
      "models": {
        "rolesImported": ["default", "smol"],
        "rolesSkipped": [{"name": "plan", "reason": "unresolved"}],
        "credentialsImported": [],
        "credentialsSkipped": [{"name": "oauth-only", "reason": "oauth-not-migrated"}]
      },
      "mcp": {"imported": ["fixture-server"], "skipped": [{"name": "shared-server", "reason": "configured"}]},
      "skills": {"imported": ["fixture-skill"], "skipped": []},
      "keys": [{"provider": "fixtureprov", "key": "sk-inline-secret"}],
      "warnings": ["a skill was skipped"],
      "truncated": false
    }"#;

    #[test]
    fn a_scan_answer_reads_every_row_with_its_status() {
        let view: ImportScanView =
            serde_json::from_str(SCAN).expect("the scan payload is the host's");
        assert!(view.found);
        assert_eq!(view.models.roles.len(), 2);
        assert_eq!(view.models.roles[0].role, "default");
        assert_eq!(view.models.roles[1].status, "unresolved");
        assert_eq!(view.models.credentials[0].kind, "api_key");
        assert_eq!(view.models.providers[0].models[0].context_window, 100_000);
        assert!(view.models.providers[0].has_key);
        assert_eq!(view.mcp.servers[0].transport, "stdio");
        assert_eq!(view.skills.skills[0].name, "fixture-skill");
    }

    #[test]
    fn an_apply_answer_reads_the_skips_and_the_keys_it_never_shows() {
        let answer: ImportApplyAnswer =
            serde_json::from_str(APPLY).expect("the apply payload is the host's");
        assert_eq!(answer.models.roles_imported, ["default", "smol"]);
        assert_eq!(answer.models.roles_skipped[0].name, "plan");
        assert_eq!(
            answer.models.credentials_skipped[0].reason,
            "oauth-not-migrated"
        );
        assert_eq!(answer.mcp.imported, ["fixture-server"]);
        assert_eq!(answer.keys[0].provider, "fixtureprov");
        assert_eq!(answer.keys[0].key, "sk-inline-secret");
        // The view the page receives has no field that could carry a key: this is the whole reason
        // the answer is read into one type and rendered from another.
        let view = ImportApplyView {
            source: answer.found.to_string(),
            found: answer.found,
            models: answer.models,
            mcp: answer.mcp,
            skills: answer.skills,
            providers_imported: Vec::new(),
            providers_skipped: Vec::new(),
            keys_stored: Vec::new(),
            warnings: answer.warnings,
            truncated: answer.truncated,
        };
        let rendered = serde_json::to_string(&view).expect("the view serializes");
        assert!(!rendered.contains("sk-inline-secret"));
    }
}

// ---- MCP sources (Claude Code, Codex, omp, legacy pi) ----

/// One MCP server an agent defines, as the MCP page's import dialog lists it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct McpSourceServerRow {
    #[serde(default)]
    pub(crate) name: String,
    /// `stdio` | `http` | `sse`.
    #[serde(default)]
    pub(crate) transport: String,
    #[serde(default)]
    pub(crate) target: String,
    /// `importable` | `configured`.
    #[serde(default)]
    pub(crate) status: String,
    /// `environment-reference` | `environment-forwarded` | null: a credential the source resolves
    /// through its own environment, which this application cannot carry.
    #[serde(default)]
    pub(crate) note: Option<String>,
}

/// One agent the machine has, and every MCP server it defines.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct McpSourceRow {
    /// `claude` | `codex` | `omp` | `pi`.
    #[serde(default)]
    pub(crate) id: String,
    /// The file the definitions come from, or would have.
    #[serde(default)]
    pub(crate) path: String,
    #[serde(default)]
    pub(crate) present: bool,
    #[serde(default)]
    pub(crate) servers: Vec<McpSourceServerRow>,
}

/// `mcp_import_scan`: the four mainstream agents on this machine and what each defines.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct McpSourceScanView {
    /// The real user profile the read used.
    #[serde(default)]
    pub(crate) home: String,
    #[serde(default)]
    pub(crate) sources: Vec<McpSourceRow>,
    #[serde(default)]
    pub(crate) warnings: Vec<String>,
    #[serde(default)]
    pub(crate) truncated: bool,
}

/// `mcp_import_apply`: what the selected agents contributed.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct McpSourceApplyView {
    #[serde(default)]
    pub(crate) home: String,
    #[serde(default)]
    pub(crate) imported: Vec<String>,
    #[serde(default)]
    pub(crate) skipped: Vec<ImportSkip>,
    #[serde(default)]
    pub(crate) warnings: Vec<String>,
    #[serde(default)]
    pub(crate) truncated: bool,
}
