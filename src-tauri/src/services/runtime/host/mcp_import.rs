//! The MCP source import's host calls: the definitions Claude Code, Codex, omp and the legacy pi
//! layout keep in the user's real profile.
//!
//! Thin like every other host call here: the host owns the files and the engine, so what each agent
//! defines and what an apply wrote are its answers. The desktop's only part is naming the profile,
//! which the host cannot discover - its own `HOME` is pinned into the application's data root.

use serde_json::json;

use crate::errors::IpcResult;
use crate::models::omp_import::{McpSourceApplyView, McpSourceScanView};

use super::super::CAPABILITY_TIMEOUT_MS;
use super::HostRuntime;

impl HostRuntime {
    /// What the four agents on this machine define, and which of it this application already has.
    pub(crate) async fn mcp_import_scan(
        &self,
        home_dir: &str,
        omp_agent_dir: &str,
    ) -> IpcResult<McpSourceScanView> {
        self.ensure_running().await?;
        let data = self
            .call_ok(
                json!({
                    "type": "mcp_import_scan",
                    "homeDir": home_dir,
                    "ompAgentDir": omp_agent_dir,
                }),
                CAPABILITY_TIMEOUT_MS,
            )
            .await?;
        super::capabilities::decode(data, "MCP source scan")
    }

    /// Copies the selected agents' servers this application does not have, and connects them.
    pub(crate) async fn mcp_import_apply(
        &self,
        home_dir: &str,
        omp_agent_dir: &str,
        sources: &[String],
    ) -> IpcResult<McpSourceApplyView> {
        self.ensure_running().await?;
        let data = self
            .call_ok(
                json!({
                    "type": "mcp_import_apply",
                    "homeDir": home_dir,
                    "ompAgentDir": omp_agent_dir,
                    "sources": sources,
                }),
                CAPABILITY_TIMEOUT_MS,
            )
            .await?;
        super::capabilities::decode(data, "MCP source import")
    }
}
