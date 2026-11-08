//! The MCP source import: the definitions Claude Code, Codex, omp and the legacy pi layout keep on
//! this machine, copied into this application's own MCP configuration.
//!
//! The host reads and writes; this layer only answers the two questions the host cannot. *Where* —
//! the real user profile, which this process can see and the host child cannot (its `HOME` is
//! pinned into the application's data root, `rules.md#engine-integration-and-data-ownership`) — and
//! *whether* the caller named an agent this build knows. An unknown id is refused here rather than
//! travelling as a name the host would silently ignore.

use tauri::State;

use crate::errors::{IpcError, IpcResult, INVALID_INPUT};
use crate::models::omp_import::{McpSourceApplyView, McpSourceScanView};
use crate::state::AppState;

use super::omp_import;

/// The agents this build can copy definitions from, in the order the dialog lists them.
const MCP_SOURCES: &[&str] = &["claude", "codex", "omp", "pi"];

/// What the four agents define, and which of it this application already has.
///
/// No argument: the profile is the one this machine actually runs as, which is the only profile a
/// terminal agent's configuration can be in. A host that is not running is started here - the
/// reader pressed a button on a page they are looking at.
#[tauri::command]
pub(crate) async fn mcp_import_scan(
    state: State<'_, AppState>,
) -> Result<McpSourceScanView, IpcError> {
    let (home, agent_dir) = locations()?;
    state.runtime.mcp_import_scan(&home, &agent_dir).await
}

/// Copies the selected agents' servers this application does not have, and connects them.
#[tauri::command]
pub(crate) async fn mcp_import_apply(
    state: State<'_, AppState>,
    sources: Vec<String>,
) -> Result<McpSourceApplyView, IpcError> {
    let selected = validate_sources(sources)?;
    let (home, agent_dir) = locations()?;
    state
        .runtime
        .mcp_import_apply(&home, &agent_dir, &selected)
        .await
}

/// The real profile and the omp agent directory, both absolute.
fn locations() -> IpcResult<(String, String)> {
    let home = omp_import::real_home().ok_or_else(|| {
        IpcError::new(
            INVALID_INPUT,
            "This machine has no user profile the other agents' configuration could live in.",
        )
    })?;
    let agent_dir = omp_import::source_directory().ok_or_else(|| {
        IpcError::new(
            INVALID_INPUT,
            "This machine has no user profile the omp configuration could live in.",
        )
    })?;
    Ok((
        home.to_string_lossy().into_owned(),
        agent_dir.to_string_lossy().into_owned(),
    ))
}

/// The selected agent ids, deduplicated and in this build's order; an unknown one is refused.
fn validate_sources(sources: Vec<String>) -> IpcResult<Vec<String>> {
    if sources.is_empty() {
        return Err(IpcError::new(
            INVALID_INPUT,
            "Choose at least one agent to import from.",
        ));
    }
    let mut selected: Vec<String> = Vec::new();
    for source in sources {
        let trimmed = source.trim();
        let id = MCP_SOURCES
            .iter()
            .find(|known| **known == trimmed)
            .ok_or_else(|| {
                IpcError::from_message(INVALID_INPUT, format!("Unknown agent: {trimmed}"))
            })?;
        if !selected.iter().any(|entry| entry.as_str() == *id) {
            selected.push((*id).to_owned());
        }
    }
    // This build's order, so the dialog's list and the host's answer cannot disagree about which
    // source came first (the caller's ids arrive in whatever order the page collected them).
    selected.sort_by_key(|id| {
        MCP_SOURCES
            .iter()
            .position(|known| known == id)
            .unwrap_or(usize::MAX)
    });
    Ok(selected)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Only a known agent id travels; the order is this build's, so the dialog's list and the
    /// host's answer cannot disagree about which source came first.
    #[test]
    fn selected_sources_are_known_ids_in_this_builds_order() {
        assert_eq!(
            validate_sources(vec!["pi".into(), "claude".into(), "pi".into()]).unwrap(),
            vec!["claude".to_owned(), "pi".to_owned()]
        );
        assert!(validate_sources(vec![]).is_err());
        assert!(validate_sources(vec!["gemini".into()]).is_err());
        assert!(validate_sources(vec![" codex ".into()]).unwrap() == vec!["codex".to_owned()]);
    }
}
