//! The settings commands that report engine state: skills, MCP servers, the memory backend, and
//! the usage roll-up.
//!
//! Every command here is the thin half of its pair. It checks what this process can judge on its
//! own - enum-shaped arguments, name bounds, the workspace the caller named - then hands the
//! request to the host and returns the host's answer unchanged. Everything that needs engine
//! knowledge stays on the far side: whether a skill exists, which servers are configured, what a
//! backend reports. Those are the engine's facts, and re-deriving them here would be a second
//! implementation of the engine's own rules.

use std::collections::BTreeMap;

use serde_json::Value;
use tauri::State;

use crate::errors::{IpcError, IpcResult, INVALID_INPUT, WORKSPACE_NOT_FOUND};
use crate::models::capabilities::{
    EngineCompactionStatus, EngineMcpDefinitionInput, EngineMcpView, EngineMemoryCatalog,
    EngineMemoryView, EngineRulesView, EngineSkillsView, EngineUsageView,
};
use crate::models::RevealWorkspaceFileResult;
use crate::services::memory_index::{self, MemoryRootTarget};
use crate::services::runtime::RULES_CONTENT_LIMIT_BYTES;
use crate::state::AppState;

use super::workspace_cwd;

/// The three things a skill write can address.
const SKILL_TARGETS: &[&str] = &["master", "source", "skill"];
/// The engine's own settings path for each skill source switch, in the order the page lists them.
/// A write names one of these and nothing else: they are the engine's keys, not a vocabulary this
/// layer invented.
const SKILL_SOURCES: &[&str] = &[
    "enableCodexUser",
    "enableClaudeUser",
    "enableClaudeProject",
    "enablePiUser",
    "enablePiProject",
    "enableAgentsUser",
    "enableAgentsProject",
];
/// The memory actions the engine's backend interface offers.
const MEMORY_ACTIONS: &[&str] = &["set_backend", "enqueue", "clear"];
/// How many workspaces one catalog read may name. It mirrors the host's own bound
/// (`MEMORY_CATALOG_WORKSPACES_MAX`): the same request must not be refused on one side for a shape
/// the other side would have accepted.
const MEMORY_CATALOG_WORKSPACES_MAX: usize = 64;
/// Ceiling on a skill or server name forwarded to the host. Real names are short directory or
/// service names, so the bound only keeps a hostile caller from building an oversized frame.
const NAME_LIMIT_CHARS: usize = 256;
/// Ceilings on the list and map fields of one MCP definition, and on a single value in them. The
/// host bounds the same shapes; these exist so an oversized definition is refused before it is
/// serialized into a frame at all.
const MCP_LIST_MAX: usize = 64;
const MCP_VALUE_CHARS_MAX: usize = 2_048;
const MCP_TIMEOUT_MS_MAX: i64 = 3_600_000;
/// The engine's own ceiling on a usage window (contract §2.8).
const RANGE_DAYS_LIMIT: i64 = 3650;

/// The skills the engine loads, the source switches that decide what it loads, and the warnings it
/// raised while loading them.
#[tauri::command]
pub(crate) async fn engine_skills(
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
) -> Result<EngineSkillsView, IpcError> {
    let cwd = workspace_cwd(&state, workspace_id).await?;
    state.runtime.skills(cwd.as_deref()).await
}

/// Flips one of the three skill switches: the master `skills.enabled`, one source toggle, or one
/// skill's own membership. The answer is the list as it stands after the write, which is what the
/// page renders.
#[tauri::command]
pub(crate) async fn engine_skills_set(
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
    target: String,
    id: Option<String>,
    enabled: bool,
) -> Result<EngineSkillsView, IpcError> {
    let (target, id) = validate_skill_write(&target, id.as_deref())?;
    let cwd = workspace_cwd(&state, workspace_id).await?;
    state
        .runtime
        .skills_set(cwd.as_deref(), &target, id.as_deref(), enabled)
        .await
}

/// The MCP servers the engine found for one project, plus whatever the live manager reports about
/// them.
#[tauri::command]
pub(crate) async fn engine_mcp(
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
) -> Result<EngineMcpView, IpcError> {
    let cwd = workspace_cwd(&state, workspace_id).await?;
    state.runtime.mcp(cwd.as_deref()).await
}

/// Enables or disables one configured MCP server through the engine's own config writer, and
/// answers with the list as it stands after the write.
#[tauri::command]
pub(crate) async fn engine_mcp_set_enabled(
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
    name: String,
    enabled: bool,
) -> Result<EngineMcpView, IpcError> {
    let name = validate_name(&name, "server")?;
    let cwd = workspace_cwd(&state, workspace_id).await?;
    state
        .runtime
        .mcp_set_enabled(cwd.as_deref(), &name, enabled)
        .await
}

/// Creates one MCP definition, or replaces the keys an edit owns.
///
/// The definition arrives as the transport shape and is forwarded that way: the *vocabulary* (which
/// transports exist, whether a stdio server may also carry a url) and the engine's own validation
/// stay on the host's side, which is also where the file is chosen and written. What this layer
/// judges is what it can see on its own - that the fields are the shape they claim and that none of
/// them is unbounded.
#[tauri::command]
pub(crate) async fn engine_mcp_upsert(
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
    name: String,
    scope: String,
    definition: EngineMcpDefinitionInput,
) -> Result<EngineMcpView, IpcError> {
    let name = validate_name(&name, "server")?;
    let scope = validate_name(&scope, "scope")?;
    let definition = validate_definition(definition)?;
    let cwd = workspace_cwd(&state, workspace_id).await?;
    state
        .runtime
        .mcp_upsert(cwd.as_deref(), &name, &scope, definition)
        .await
}

/// Deletes one MCP definition from the file its scope names.
#[tauri::command]
pub(crate) async fn engine_mcp_remove(
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
    name: String,
    scope: String,
) -> Result<EngineMcpView, IpcError> {
    let name = validate_name(&name, "server")?;
    let scope = validate_name(&scope, "scope")?;
    let cwd = workspace_cwd(&state, workspace_id).await?;
    state
        .runtime
        .mcp_remove(cwd.as_deref(), &name, &scope)
        .await
}

/// The active memory backend, its own status, the artifacts the local backend keeps on disk, and
/// the injection the engine renders for this project.
#[tauri::command]
pub(crate) async fn engine_memory(
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
) -> Result<EngineMemoryView, IpcError> {
    let cwd = workspace_cwd(&state, workspace_id).await?;
    state.runtime.memory(cwd.as_deref()).await
}

/// Switches the memory backend, asks it to organize what it holds, or clears it.
///
/// `clear` is destructive, so the caller confirms it with the user before sending this; the host
/// and the engine have no second gate behind that (contract §2.7).
#[tauri::command]
pub(crate) async fn engine_memory_action(
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
    action: String,
    backend: Option<String>,
) -> Result<EngineMemoryView, IpcError> {
    let (action, backend) = validate_memory_action(&action, backend.as_deref())?;
    let cwd = workspace_cwd(&state, workspace_id).await?;
    state
        .runtime
        .memory_action(cwd.as_deref(), &action, backend.as_deref())
        .await
}

/// The memory catalog: the backend, and the memory files of every workspace the caller names.
///
/// The roots come from the host - they are the engine's own `getMemoryRoot` derivation - and the
/// files come from this process: `services::memory_index` walks each root read-only, because
/// listing a directory is this side's work and the engine's data directory is never written here.
///
/// A workspace the store no longer has is left out rather than failing the read: a catalog lists
/// what exists, and a caller holding a stale id should still see the rest. Any other store failure
/// is propagated, so a broken database is not mistaken for an empty workspace list.
#[tauri::command]
pub(crate) async fn engine_memory_catalog(
    state: State<'_, AppState>,
    workspace_ids: Vec<i64>,
) -> Result<EngineMemoryCatalog, IpcError> {
    let ids = validate_workspace_ids(&workspace_ids)?;
    let mut targets = Vec::with_capacity(ids.len());
    for id in ids {
        match state.store.get_project(id).await {
            Ok(project) => targets.push((project.id, project.name, project.root_path)),
            Err(error) if error.code.as_ref() == WORKSPACE_NOT_FOUND => continue,
            Err(error) => return Err(error),
        }
    }

    let cwds: Vec<String> = targets.iter().map(|(_, _, root)| root.clone()).collect();
    let roots = state.runtime.memory_catalog(&cwds).await?;

    // The host answers one row per working directory in the order they were sent, so a row pairs
    // with the store's identity by index and never by re-resolving a path here.
    let mut scan_targets = Vec::new();
    for (index, (workspace_id, label, _)) in targets.iter().enumerate() {
        let Some(row) = roots.workspaces.get(index) else {
            continue;
        };
        let Some(root) = row.root.as_deref() else {
            continue;
        };
        scan_targets.push(MemoryRootTarget {
            workspace_id: *workspace_id,
            label: label.clone(),
            cwd: row.cwd.clone(),
            root: root.to_owned(),
        });
    }

    let workspaces = if scan_targets.is_empty() {
        Vec::new()
    } else {
        tauri::async_runtime::spawn_blocking(move || memory_index::scan(&scan_targets))
            .await
            .map_err(|_| IpcError::new("MEMORY_TASK_FAILED", "Memory catalog task failed."))?
    };

    Ok(EngineMemoryCatalog {
        backend: roots.backend,
        enabled: roots.enabled,
        local_only: roots.local_only,
        workspaces,
    })
}

/// Reveals one memory document in the platform's file manager.
///
/// The document is addressed by the workspace it belongs to and by its **name inside** that
/// workspace's memory root: the root is derived here (store id → working directory → the host's
/// `getMemoryRoot`), and the name is a relative path the reveal helper validates, so no absolute
/// path ever travels from the page into a filesystem call. Revealing is the whole action - nothing
/// opens, edits or copies the file.
#[tauri::command]
pub(crate) async fn engine_memory_reveal(
    state: State<'_, AppState>,
    workspace_id: i64,
    name: String,
) -> Result<RevealWorkspaceFileResult, IpcError> {
    let name = validate_memory_file_name(&name)?;
    let project = state.store.get_project(workspace_id).await?;
    let roots = state
        .runtime
        .memory_catalog(std::slice::from_ref(&project.root_path))
        .await?;
    let root = roots
        .workspaces
        .first()
        .and_then(|row| row.root.clone())
        .ok_or_else(|| {
            IpcError::new(
                INVALID_INPUT,
                "The active memory backend keeps no files to reveal.",
            )
        })?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::services::workspace::reveal_workspace_file(root, name)
    })
    .await
    .map_err(|_| IpcError::new("MEMORY_TASK_FAILED", "Memory reveal task failed."))?
    .map_err(|message| IpcError::from_message("MEMORY_OPERATION_FAILED", message))
}

/// The name of a document inside a memory root: one path segment set, no controls, no separators
/// that climb out of the root.
fn validate_memory_file_name(name: &str) -> IpcResult<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > NAME_LIMIT_CHARS {
        return Err(IpcError::new(
            INVALID_INPUT,
            "A memory file name is required.",
        ));
    }
    if trimmed.chars().any(|ch| ch.is_control()) {
        return Err(IpcError::new(
            INVALID_INPUT,
            "A memory file name cannot contain control characters.",
        ));
    }
    let path = std::path::Path::new(trimmed);
    if path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err(IpcError::new(
            INVALID_INPUT,
            "A memory file name must stay inside its workspace's memory root.",
        ));
    }
    Ok(trimmed.to_owned())
}

/// The workspaces a catalog read may name: bounded, unique and positive ids.
fn validate_workspace_ids(ids: &[i64]) -> IpcResult<Vec<i64>> {
    if ids.len() > MEMORY_CATALOG_WORKSPACES_MAX {
        return Err(IpcError::from_message(
            INVALID_INPUT,
            format!("At most {MEMORY_CATALOG_WORKSPACES_MAX} workspaces may be read at once."),
        ));
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut kept = Vec::with_capacity(ids.len());
    for id in ids {
        if *id <= 0 {
            return Err(IpcError::new(
                INVALID_INPUT,
                "A workspace id must be positive.",
            ));
        }
        if seen.insert(*id) {
            kept.push(*id);
        }
    }
    Ok(kept)
}

/// The token and cost roll-up over this application's own session files.
///
/// `range_days` narrows the answer to a window of whole local days. The host answers from its own
/// per-file usage index, re-reading only the files that changed, so `refresh` asks for nothing a
/// plain read does not already do and is passed through as the caller's own field.
#[tauri::command]
pub(crate) async fn engine_usage(
    state: State<'_, AppState>,
    range_days: Option<i64>,
    refresh: Option<bool>,
) -> Result<EngineUsageView, IpcError> {
    let range_days = validate_range_days(range_days)?;
    state
        .runtime
        .usage(range_days, refresh.unwrap_or(false))
        .await
}

/// Whether the engine compacts a filling context by itself, from the engine's own settings.
///
/// The answer is the engine's resolved value (`compaction.enabled`), not a copy this layer keeps:
/// a settings file without the key reports what the engine would actually do. How full the context
/// has to be before it compacts, and which method runs, are the engine's own rules, and the ring in
/// the composer follows the occupancy they act on.
#[tauri::command]
pub(crate) async fn engine_compaction_status(
    state: State<'_, AppState>,
) -> Result<EngineCompactionStatus, IpcError> {
    state.runtime.compaction_status().await
}

/// Writes that switch, and answers with the value as it stands after the write.
///
/// The switch is the engine's own setting, written through the engine's settings API and flushed
/// before the answer, so a caller that reads again sees exactly what this response said.
#[tauri::command]
pub(crate) async fn engine_compaction_set_enabled(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<EngineCompactionStatus, IpcError> {
    state.runtime.set_compaction_enabled(enabled).await
}

/// Writes one or both idle switches under the compaction card, and answers with the values as they
/// stand after the write.
///
/// Each argument is a switch this call is deliberately not touching when it is `None`; the two are
/// engine settings (`compaction.idleEnabled`, `recap.enabled`) written through the engine's own API
/// and flushed before the answer, so a reader flipping one never reverts the other.
#[tauri::command]
pub(crate) async fn engine_compaction_set_options(
    state: State<'_, AppState>,
    idle_enabled: Option<bool>,
    recap_enabled: Option<bool>,
) -> Result<EngineCompactionStatus, IpcError> {
    state
        .runtime
        .set_compaction_options(idle_enabled, recap_enabled)
        .await
}

/// The engine's user-scope `RULES.md`, as it stands on disk right now.
///
/// The file belongs to the engine's user scope rather than to a project, which is why this command
/// takes no workspace id: the answer is one path and one file for the whole application. Whether it
/// exists is part of the answer, not an error - a page that has never saved anything sees the
/// empty shape and can still write.
#[tauri::command]
pub(crate) async fn engine_rules(state: State<'_, AppState>) -> Result<EngineRulesView, IpcError> {
    state.runtime.rules().await
}

/// Replaces that file with `content`, and answers with the file as it stands after the write.
///
/// The size is judged here, in UTF-8 bytes, before anything is sent: the host refuses an oversized
/// write with the same code, but the ceiling is a fixed number both sides hold, and a paste the
/// page can already tell is too large does not need a round trip to find out. It is not clamped:
/// silently truncating rules would change what the engine obeys without anybody seeing it.
#[tauri::command]
pub(crate) async fn engine_rules_set(
    state: State<'_, AppState>,
    content: String,
) -> Result<EngineRulesView, IpcError> {
    validate_rules_content(&content)?;
    state.runtime.rules_write(&content).await
}

/// The one thing this layer judges about a rules write: its size, in UTF-8 bytes.
///
/// The read side of the same ceiling lives in the host (`RULES_CONTENT_MAX_BYTES`), because only
/// the host can see a file that was made too large by something other than this page; here the
/// check exists so the page learns about it before a frame is built. The message names the number
/// and points at an external editor, because a file this large is not something the page's editor
/// is the right tool for.
fn validate_rules_content(content: &str) -> IpcResult<()> {
    if content.len() > RULES_CONTENT_LIMIT_BYTES {
        return Err(IpcError::from_message(
            "rules_too_large",
            format!(
                "The rules text measures {} bytes, over the {RULES_CONTENT_LIMIT_BYTES}-byte limit for one write; a file this large is edited in an external editor.",
                content.len()
            ),
        ));
    }
    Ok(())
}

/// A definition's shape, as far as this layer can judge it: every string bounded, every list and
/// map bounded, every entry a string. Which transports exist, what a stdio server must carry and
/// whether the file may hold the result are engine rules and stay on the host's side.
fn validate_definition(input: EngineMcpDefinitionInput) -> IpcResult<Value> {
    let command = validate_optional_text(input.command, "command")?;
    let url = validate_optional_text(input.url, "url")?;
    let cwd = validate_optional_text(input.cwd, "definition cwd")?;
    let args = match input.args {
        Some(values) if values.len() > MCP_LIST_MAX => {
            return Err(IpcError::from_message(
                INVALID_INPUT,
                format!("A definition carries at most {MCP_LIST_MAX} arguments."),
            ))
        }
        Some(values) => values
            .into_iter()
            .map(|value| validate_value(&value, "argument"))
            .collect::<IpcResult<Vec<String>>>()?,
        None => Vec::new(),
    };
    let env = validate_map(input.env, "environment")?;
    let headers = validate_map(input.headers, "headers")?;
    if let Some(timeout) = input.timeout_ms {
        if !(0..=MCP_TIMEOUT_MS_MAX).contains(&timeout) {
            return Err(IpcError::from_message(
                INVALID_INPUT,
                format!("A definition's timeout must be between 0 and {MCP_TIMEOUT_MS_MAX} ms."),
            ));
        }
    }
    Ok(serde_json::json!({
        "transport": input.transport,
        "command": command,
        "args": args,
        "env": env,
        "url": url,
        "headers": headers,
        "cwd": cwd,
        "timeoutMs": input.timeout_ms,
    }))
}

/// One optional definition text value: trimmed, bounded, free of control characters.
fn validate_optional_text(value: Option<String>, what: &'static str) -> IpcResult<Option<String>> {
    match value
        .map(|entry| entry.trim().to_owned())
        .filter(|entry| !entry.is_empty())
    {
        Some(entry) => Ok(Some(validate_value(&entry, what)?)),
        None => Ok(None),
    }
}

/// One definition value: bounded and free of control characters, which is everything this layer can
/// know before the engine is asked whether the definition is one it accepts.
fn validate_value(value: &str, what: &'static str) -> IpcResult<String> {
    if value.chars().count() > MCP_VALUE_CHARS_MAX {
        return Err(IpcError::from_message(
            INVALID_INPUT,
            format!("A definition {what} is too long."),
        ));
    }
    if value.chars().any(char::is_control) {
        return Err(IpcError::from_message(
            INVALID_INPUT,
            format!("A definition {what} contains control characters."),
        ));
    }
    Ok(value.to_owned())
}

/// One definition map (environment or headers): bounded, with bounded string keys and values.
fn validate_map(
    value: Option<BTreeMap<String, String>>,
    what: &'static str,
) -> IpcResult<BTreeMap<String, String>> {
    let Some(entries) = value else {
        return Ok(BTreeMap::new());
    };
    if entries.len() > MCP_LIST_MAX {
        return Err(IpcError::from_message(
            INVALID_INPUT,
            format!("A definition carries at most {MCP_LIST_MAX} {what} entries."),
        ));
    }
    let mut bounded = BTreeMap::new();
    for (key, entry) in entries {
        let key = validate_value(&key, "key")?;
        bounded.insert(key, validate_value(&entry, what)?);
    }
    Ok(bounded)
}

/// The write a skill command addresses: the target, and the id that target names.
///
/// `master` addresses the switch itself and has nothing to name, so an id sent with it is refused
/// rather than ignored: each target has exactly one shape, and a mismatched pair means the caller is
/// confused about which switch it is flipping. Whether a *skill* of that name exists is not decided
/// here - that needs the engine's own discovery, so the host answers it (contract §2.3).
fn validate_skill_write(target: &str, id: Option<&str>) -> IpcResult<(String, Option<String>)> {
    let target = target.trim();
    if !SKILL_TARGETS.contains(&target) {
        return Err(IpcError::new(INVALID_INPUT, "Unknown skill target."));
    }
    let id = match id.map(str::trim).filter(|value| !value.is_empty()) {
        Some(id) => Some(validate_name(id, "skill")?),
        None => None,
    };
    match target {
        "master" => {
            if id.is_some() {
                return Err(IpcError::new(
                    INVALID_INPUT,
                    "The skill master switch does not take an id.",
                ));
            }
        }
        "source" => {
            let Some(source) = id.as_deref() else {
                return Err(IpcError::new(
                    INVALID_INPUT,
                    "A skill source id is required.",
                ));
            };
            if !SKILL_SOURCES.contains(&source) {
                return Err(IpcError::new(INVALID_INPUT, "Unknown skill source."));
            }
        }
        _ => {
            if id.is_none() {
                return Err(IpcError::new(INVALID_INPUT, "A skill name is required."));
            }
        }
    }
    Ok((target.to_owned(), id))
}

/// The memory action to run, and the backend it names.
///
/// Only `set_backend` carries a backend: the other two act on whichever backend the settings
/// already select, so a backend sent with them is checked but not forwarded - it would name
/// something the command does not use. A missing backend on `set_backend` is refused here.
///
/// The backend id is checked for *shape* only - trimmed, non-empty, bounded, free of control
/// characters - and which ids are choosable is the host's decision, held once, where the page's
/// list comes from: `memory_status.backends` (`host/src/memory.ts`). A second copy of that
/// vocabulary here would be a second source of truth, and its drift would re-admit a backend the
/// host refuses; the host answers `invalid_input` for anything outside its own list, so an id this
/// layer cannot judge is refused rather than silently switched.
fn validate_memory_action(
    action: &str,
    backend: Option<&str>,
) -> IpcResult<(String, Option<String>)> {
    let action = action.trim();
    if !MEMORY_ACTIONS.contains(&action) {
        return Err(IpcError::new(INVALID_INPUT, "Unknown memory action."));
    }
    let backend = match backend.map(str::trim).filter(|value| !value.is_empty()) {
        Some(backend) => Some(validate_name(backend, "memory backend")?),
        None => None,
    };
    if action != "set_backend" {
        return Ok((action.to_owned(), None));
    }
    match backend {
        Some(backend) => Ok((action.to_owned(), Some(backend))),
        None => Err(IpcError::new(
            INVALID_INPUT,
            "A memory backend is required to switch backends.",
        )),
    }
}

/// A skill or server name forwarded to the host: trimmed, non-empty, bounded, and free of control
/// characters, which is everything this layer can know about a name before the engine is asked.
fn validate_name(value: &str, what: &'static str) -> IpcResult<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(IpcError::from_message(
            INVALID_INPUT,
            format!("A {what} name is required."),
        ));
    }
    if value.chars().count() > NAME_LIMIT_CHARS {
        return Err(IpcError::from_message(
            INVALID_INPUT,
            format!("The {what} name is too long."),
        ));
    }
    if value.chars().any(char::is_control) {
        return Err(IpcError::from_message(
            INVALID_INPUT,
            format!("The {what} name contains control characters."),
        ));
    }
    Ok(value.to_owned())
}

/// The window a usage scan covers: nothing (all history) or 1..=3650 days.
///
/// `0` is refused rather than read as "today": a window covering no day would answer with empty
/// tables that look like a quiet history, and a caller asking for today says `1`.
fn validate_range_days(range_days: Option<i64>) -> IpcResult<Option<i64>> {
    match range_days {
        None => Ok(None),
        Some(days) if (1..=RANGE_DAYS_LIMIT).contains(&days) => Ok(Some(days)),
        Some(_) => Err(IpcError::new(
            INVALID_INPUT,
            "The usage range must be between 1 and 3650 days.",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each skill target accepts exactly the shape it addresses, and the id that is accepted is the
    /// trimmed one - what this process validated is what the host is asked about.
    #[test]
    fn skill_writes_are_checked_against_their_target() {
        assert_eq!(
            validate_skill_write(" master ", None).expect("the master switch"),
            ("master".to_owned(), None)
        );
        assert_eq!(
            validate_skill_write("source", Some("enablePiUser")).expect("a known source"),
            ("source".to_owned(), Some("enablePiUser".to_owned()))
        );
        assert_eq!(
            validate_skill_write("skill", Some(" herdr ")).expect("a skill name"),
            ("skill".to_owned(), Some("herdr".to_owned()))
        );

        assert!(validate_skill_write("nope", None).is_err());
        assert!(validate_skill_write("master", Some("skill:herdr")).is_err());
        assert!(validate_skill_write("source", Some("enablePiTeam")).is_err());
        assert!(validate_skill_write("source", None).is_err());
        assert!(validate_skill_write("skill", Some("   ")).is_err());
        assert!(validate_skill_write("skill", Some(&"a".repeat(NAME_LIMIT_CHARS + 1))).is_err());
    }

    /// Only `set_backend` needs a backend; the other two accept the field and do not forward it.
    /// The id's *value* is the host's call (it refuses anything outside the set it publishes, and
    /// that refusal is asserted by the host's own `capabilities` smoke scenario), so what is pinned
    /// here is the shape this layer judges and the forwarding rule.
    #[test]
    fn memory_actions_forward_a_backend_only_where_it_means_something() {
        assert_eq!(
            validate_memory_action("set_backend", Some(" mnemopi ")).expect("a backend id"),
            ("set_backend".to_owned(), Some("mnemopi".to_owned()))
        );
        assert_eq!(
            validate_memory_action("clear", Some("local")).expect("checked, not forwarded"),
            ("clear".to_owned(), None)
        );
        assert_eq!(
            validate_memory_action("enqueue", None).expect("no backend needed"),
            ("enqueue".to_owned(), None)
        );

        assert!(validate_memory_action("set_backend", None).is_err());
        assert!(validate_memory_action("set_backend", Some("   ")).is_err());
        assert!(validate_memory_action("set_backend", Some("bad\u{7}id")).is_err());
        assert!(
            validate_memory_action("set_backend", Some(&"a".repeat(NAME_LIMIT_CHARS + 1))).is_err()
        );
        assert!(validate_memory_action("forget", None).is_err());
    }

    /// A catalog read names bounded, unique, positive workspaces: a repeated id is folded once (a
    /// caller that repeats one must not make the host derive the same root twice), and an oversized
    /// list or a non-id is refused before a frame is built.
    #[test]
    fn catalog_workspace_ids_are_bounded() {
        assert_eq!(
            validate_workspace_ids(&[7, 3, 7]).expect("unique ids"),
            vec![7, 3]
        );
        assert!(validate_workspace_ids(&[])
            .expect("no workspaces")
            .is_empty());
        assert!(validate_workspace_ids(&[0]).is_err());
        assert!(validate_workspace_ids(&[-1]).is_err());
        assert!(validate_workspace_ids(&vec![1; MEMORY_CATALOG_WORKSPACES_MAX + 1]).is_err());
    }

    /// A usage window is all history or a real number of days: zero and an oversized window are
    /// both refused instead of being interpreted.
    #[test]
    fn usage_ranges_are_bounded() {
        assert_eq!(validate_range_days(None).expect("all history"), None);
        assert_eq!(validate_range_days(Some(1)).expect("one day"), Some(1));
        assert_eq!(
            validate_range_days(Some(3650)).expect("the limit"),
            Some(3650)
        );
        assert!(validate_range_days(Some(0)).is_err());
        assert!(validate_range_days(Some(-7)).is_err());
        assert!(validate_range_days(Some(3651)).is_err());
    }

    /// A definition is bounded before it travels: an oversized argument, a control character in a
    /// value and a timeout past the ceiling are refused here, and the record that does travel keeps
    /// the field names the host reads.
    #[test]
    fn mcp_definitions_are_bounded_before_they_travel() {
        fn definition(args: Option<Vec<String>>, timeout: Option<i64>) -> EngineMcpDefinitionInput {
            EngineMcpDefinitionInput {
                transport: "stdio".to_owned(),
                command: Some("npx".to_owned()),
                args,
                timeout_ms: timeout,
                ..EngineMcpDefinitionInput::default()
            }
        }

        let forwarded = validate_definition(definition(Some(vec!["-y".to_owned()]), Some(30_000)))
            .expect("a bounded definition");
        assert_eq!(forwarded["transport"], serde_json::json!("stdio"));
        assert_eq!(forwarded["args"], serde_json::json!(["-y"]));
        assert_eq!(forwarded["timeoutMs"], serde_json::json!(30_000));
        assert_eq!(forwarded["env"], serde_json::json!({}));
        assert_eq!(forwarded["command"], serde_json::json!("npx"));

        assert!(validate_definition(definition(
            Some(vec!["x".repeat(MCP_VALUE_CHARS_MAX + 1)]),
            None
        ))
        .is_err());
        assert!(
            validate_definition(definition(Some(vec!["bad\u{7}value".to_owned()]), None)).is_err()
        );
        assert!(validate_definition(definition(
            Some(vec!["x".to_owned(); MCP_LIST_MAX + 1]),
            None
        ))
        .is_err());
        assert!(validate_definition(definition(None, Some(MCP_TIMEOUT_MS_MAX + 1))).is_err());

        let mut env = BTreeMap::new();
        env.insert("TOKEN".to_owned(), "sk-1".to_owned());
        let with_env = validate_definition(EngineMcpDefinitionInput {
            env: Some(env),
            ..definition(None, None)
        })
        .expect("a bounded environment");
        assert_eq!(with_env["env"], serde_json::json!({ "TOKEN": "sk-1" }));
    }

    /// A rules write is judged by its UTF-8 bytes rather than its characters, and is refused rather
    /// than truncated: exactly the ceiling passes, one byte over is answered with the same code the
    /// host sends, and the message carries the ceiling so the page can quote it.
    #[test]
    fn rules_writes_are_bounded_by_bytes() {
        assert!(validate_rules_content("").is_ok());
        assert!(validate_rules_content(&"a".repeat(RULES_CONTENT_LIMIT_BYTES)).is_ok());
        // Two bytes per character, so a text half the ceiling long in characters already sits on
        // it - which is what `len()` measures and `chars().count()` would not.
        assert!(validate_rules_content(&"é".repeat(RULES_CONTENT_LIMIT_BYTES / 2)).is_ok());

        let too_large = validate_rules_content(&"é".repeat(RULES_CONTENT_LIMIT_BYTES / 2 + 1))
            .expect_err("one byte over the ceiling");
        assert_eq!(too_large.code.as_ref(), "rules_too_large");
        assert!(too_large
            .message
            .contains(&RULES_CONTENT_LIMIT_BYTES.to_string()));

        assert!(validate_rules_content(&"a".repeat(RULES_CONTENT_LIMIT_BYTES + 1)).is_err());
    }
}
