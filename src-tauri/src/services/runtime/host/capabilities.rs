//! The capability calls [`HostRuntime`] serves for the settings pages: skills, MCP servers, the
//! memory backend, the usage roll-up, and the tool approval mode.
//!
//! Every method is the same three steps in the same order - make sure a host is running, send the
//! frame, read its answer into the DTO the command returns - and nothing between them inspects,
//! renames or recomputes a payload. The host is the side that owns the engine, so it is the side
//! that knows what the engine reported; this layer's whole job is to ask and to carry the answer
//! back in the shape the frontend already declares.
//!
//! Argument semantics are checked before any of this runs (see `commands::capabilities`), and the
//! host checks what only it can: whether a skill exists, whether a server is configured, and
//! whether a working directory is usable at all.

use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use crate::errors::{IpcError, IpcResult, ENGINE_PROTOCOL};
use crate::models::capabilities::{
    EngineApprovalMode, EngineCompactionStatus, EngineMcpView, EngineMemoryView, EngineRulesView,
    EngineSkillsView, EngineUsageView, MemoryCatalogRootsView,
};

use super::super::{CAPABILITY_TIMEOUT_MS, USAGE_TIMEOUT_MS};
use super::HostRuntime;

impl HostRuntime {
    /// The engine's skills: what discovery loads for this working directory, which source switches
    /// are on, and the warnings the engine raised while loading them.
    pub(crate) async fn skills(&self, cwd: Option<&str>) -> IpcResult<EngineSkillsView> {
        self.ensure_running().await?;
        let data = self
            .call_ok(command_frame("skills_list", cwd), CAPABILITY_TIMEOUT_MS)
            .await?;
        decode(data, "skill list")
    }

    /// Flips one of the three skill switches: the master `skills.enabled`, one source toggle, or one
    /// skill's own membership (`target` says which; `id` names the source or the skill).
    ///
    /// The target travels under `targetId` and never under `id`: `id` is the envelope's
    /// request-response correlation key, written by the call path itself, so a target sent as `id`
    /// would simply be overwritten and the write would address nothing (contract §2.3, ruling C14).
    ///
    /// The answer is a freshly discovered list rather than an acknowledgement, because all three
    /// switches change the same page in the same way - what the settings let through - and the page
    /// renders whatever the engine reports next.
    pub(crate) async fn skills_set(
        &self,
        cwd: Option<&str>,
        target: &str,
        id: Option<&str>,
        enabled: bool,
    ) -> IpcResult<EngineSkillsView> {
        self.ensure_running().await?;
        let mut request = command_frame("skills_set", cwd);
        request["target"] = json!(target);
        request["enabled"] = json!(enabled);
        if let Some(id) = id {
            request["targetId"] = json!(id);
        }
        let data = self.call_ok(request, CAPABILITY_TIMEOUT_MS).await?;
        decode(data, "skill list")
    }

    /// The engine's tool approval mode, and whether its settings file carries the key at all.
    ///
    /// The answer is the engine's own resolved value: a settings file without the key reports the
    /// mode the engine would actually use, and `configured` is what tells that apart from a mode
    /// the file stores (`host/src/dispatch.ts::approval_mode`). The caller is
    /// `services::runtime::approval::converge`, which needs the value only to know whether it still
    /// has to write `yolo`.
    pub(crate) async fn approval_mode(&self) -> IpcResult<EngineApprovalMode> {
        self.ensure_running().await?;
        let data = self
            .call_ok(command_frame("approval_mode", None), CAPABILITY_TIMEOUT_MS)
            .await?;
        decode(data, "approval mode")
    }

    /// Writes the engine's tool approval mode through its own settings, and answers with the value
    /// as it stands after the write - the same shape the read reports, so a caller never has to
    /// guess what the engine now holds.
    ///
    /// The only caller is `services::runtime::approval::converge`, which passes a value the engine
    /// itself accepts: this application holds every installation at `yolo` and has no surface that
    /// could name another mode. The host writes the value to the engine's settings file and flushes
    /// before it answers.
    pub(crate) async fn set_approval_mode(&self, mode: &str) -> IpcResult<EngineApprovalMode> {
        self.ensure_running().await?;
        let mut request = command_frame("approval_mode_set", None);
        request["mode"] = json!(mode);
        let data = self.call_ok(request, CAPABILITY_TIMEOUT_MS).await?;
        decode(data, "approval mode")
    }

    /// Whether the engine compacts a filling context by itself, and what its own settings say.
    ///
    /// The answer is the engine's own resolved value: a settings file without the key reports the
    /// behaviour the engine would actually apply rather than a copy this layer keeps
    /// (`host/src/dispatch.ts::compaction_status`).
    pub(crate) async fn compaction_status(&self) -> IpcResult<EngineCompactionStatus> {
        self.ensure_running().await?;
        let data = self
            .call_ok(
                command_frame("compaction_status", None),
                CAPABILITY_TIMEOUT_MS,
            )
            .await?;
        decode(data, "compaction status")
    }

    /// Writes that switch through the engine's own settings, and answers with the value as it
    /// stands after the write - the same shape the read reports, so a caller never has to guess
    /// what the engine now holds.
    ///
    /// What the setting means is the engine's: how full the context has to be, which compaction
    /// method runs and what it keeps are its rules. The host writes the switch into the engine's
    /// settings file and flushes before it answers.
    pub(crate) async fn set_compaction_enabled(
        &self,
        enabled: bool,
    ) -> IpcResult<EngineCompactionStatus> {
        self.ensure_running().await?;
        let mut request = command_frame("compaction_set_enabled", None);
        request["enabled"] = json!(enabled);
        let data = self.call_ok(request, CAPABILITY_TIMEOUT_MS).await?;
        decode(data, "compaction status")
    }

    /// Writes one or both idle switches under the compaction card, and answers with the values as
    /// they stand after the write - the same shape the read reports.
    ///
    /// `None` is a switch this call is not touching, and the host is told exactly that: the two
    /// leaves are written one at a time, so flipping one cannot revert the other.
    pub(crate) async fn set_compaction_options(
        &self,
        idle_enabled: Option<bool>,
        recap_enabled: Option<bool>,
    ) -> IpcResult<EngineCompactionStatus> {
        self.ensure_running().await?;
        let mut request = command_frame("compaction_set_options", None);
        if let Some(idle) = idle_enabled {
            request["idleEnabled"] = json!(idle);
        }
        if let Some(recap) = recap_enabled {
            request["recapEnabled"] = json!(recap);
        }
        let data = self.call_ok(request, CAPABILITY_TIMEOUT_MS).await?;
        decode(data, "compaction status")
    }

    /// The MCP servers the engine's config discovery found for this working directory, plus what the
    /// live manager - when a session has brought one up - reports about each of them.
    ///
    /// A server the user disabled by hand is still listed, with the override that disabled it: the
    /// page exists to show what is configured, not only what is currently running.
    pub(crate) async fn mcp(&self, cwd: Option<&str>) -> IpcResult<EngineMcpView> {
        self.ensure_running().await?;
        let data = self
            .call_ok(command_frame("mcp_list", cwd), CAPABILITY_TIMEOUT_MS)
            .await?;
        decode(data, "MCP list")
    }

    /// Enables or disables one configured MCP server.
    ///
    /// The write goes through the engine's own config writer, so the definition file keeps the
    /// engine's format and its own override bookkeeping; the answer is the list as it stands after
    /// that write.
    pub(crate) async fn mcp_set_enabled(
        &self,
        cwd: Option<&str>,
        name: &str,
        enabled: bool,
    ) -> IpcResult<EngineMcpView> {
        self.ensure_running().await?;
        let mut request = command_frame("mcp_set_enabled", cwd);
        request["name"] = json!(name);
        request["enabled"] = json!(enabled);
        let data = self.call_ok(request, CAPABILITY_TIMEOUT_MS).await?;
        decode(data, "MCP list")
    }

    /// Creates one MCP definition, or replaces the keys an edit owns.
    ///
    /// The definition travels as the transport shape (`transport` plus the fields that shape uses),
    /// never as a whole config file: the host replaces exactly those keys in whatever the file
    /// already holds and lets the engine validate the result before it writes, so authentication
    /// and other fields the editor does not show survive an edit. `scope` names the file - the
    /// engine's own user or project `mcp.json`.
    pub(crate) async fn mcp_upsert(
        &self,
        cwd: Option<&str>,
        name: &str,
        scope: &str,
        definition: Value,
    ) -> IpcResult<EngineMcpView> {
        self.ensure_running().await?;
        let mut request = command_frame("mcp_upsert", cwd);
        request["name"] = json!(name);
        request["scope"] = json!(scope);
        request["definition"] = definition;
        let data = self.call_ok(request, CAPABILITY_TIMEOUT_MS).await?;
        decode(data, "MCP list")
    }

    /// Deletes one MCP definition from the file its scope names.
    pub(crate) async fn mcp_remove(
        &self,
        cwd: Option<&str>,
        name: &str,
        scope: &str,
    ) -> IpcResult<EngineMcpView> {
        self.ensure_running().await?;
        let mut request = command_frame("mcp_remove", cwd);
        request["name"] = json!(name);
        request["scope"] = json!(scope);
        let data = self.call_ok(request, CAPABILITY_TIMEOUT_MS).await?;
        decode(data, "MCP list")
    }

    /// The selected memory backend, the backends to choose from, and - for the local backend - the
    /// memory root with its artifacts, plus the injection the engine's own backend renders for this
    /// project.
    ///
    /// A backend that does not answer or has no status of its own is reported as such inside the
    /// payload (`statusError`), not as a failed command: the page has a backend and a picker to
    /// render either way.
    pub(crate) async fn memory(&self, cwd: Option<&str>) -> IpcResult<EngineMemoryView> {
        self.ensure_running().await?;
        let data = self
            .call_ok(command_frame("memory_status", cwd), CAPABILITY_TIMEOUT_MS)
            .await?;
        decode(data, "memory status")
    }

    /// Switches the memory backend, asks the active one to organize what it holds, or clears it.
    ///
    /// `clear` destroys memories and the caller is the side that confirmed it with the user; there
    /// is no second gate between here and the engine. Every action answers with a fresh status, so
    /// the page shows the backend's own report of what the action did.
    pub(crate) async fn memory_action(
        &self,
        cwd: Option<&str>,
        action: &str,
        backend: Option<&str>,
    ) -> IpcResult<EngineMemoryView> {
        self.ensure_running().await?;
        let mut request = command_frame("memory_action", cwd);
        request["action"] = json!(action);
        if let Some(backend) = backend {
            request["backend"] = json!(backend);
        }
        let data = self.call_ok(request, CAPABILITY_TIMEOUT_MS).await?;
        decode(data, "memory status")
    }

    /// Where each named working directory's memory lives, and nothing about its contents.
    ///
    /// One call covers every workspace the page shows, because the answer is a path derivation
    /// rather than a scan: the host asks the engine for `getMemoryRoot(agentDir, cwd)` per
    /// directory and reads no backend - no `status()`, no injection - so naming fifty workspaces
    /// costs fifty derivations and one round trip. Reading what is *inside* those roots is this
    /// host's own work (`services::memory_index`), which is why nothing but the paths comes back.
    ///
    /// A row's `root` is `null` unless `memory.backend=local`: the other backends keep no files
    /// under a root, and a path to a directory they never write would invite a reader to show an
    /// empty list where the truth is "this backend has no files at all".
    pub(crate) async fn memory_catalog(
        &self,
        cwds: &[String],
    ) -> IpcResult<MemoryCatalogRootsView> {
        self.ensure_running().await?;
        let mut request = command_frame("memory_catalog", None);
        request["cwds"] = json!(cwds);
        let data = self.call_ok(request, CAPABILITY_TIMEOUT_MS).await?;
        decode(data, "memory catalog")
    }

    /// The token and cost roll-up over this application's own session files.
    ///
    /// This one has a budget of its own: the host walks the whole session store to answer it, which
    /// is a scan rather than a lookup, and the memo the host keeps exists precisely because that
    /// walk is the expensive part. `refresh` skips the memo, which is what a manual refresh asks
    /// for; `range_days` limits the window, and no window means all history.
    pub(crate) async fn usage(
        &self,
        range_days: Option<i64>,
        refresh: bool,
    ) -> IpcResult<EngineUsageView> {
        self.ensure_running().await?;
        let mut request = json!({"type": "usage_summary", "refresh": refresh});
        if let Some(days) = range_days {
            request["rangeDays"] = json!(days);
        }
        let data = self.call_ok(request, USAGE_TIMEOUT_MS).await?;
        decode(data, "usage summary")
    }

    /// The engine's user-scope `RULES.md` as it stands on disk, or the shape of a file that does
    /// not exist yet.
    ///
    /// The engine exposes no getter for this file - its discovery only reads it - so the host is
    /// the side that looks at the path and reports what is there. Nothing about that reading
    /// belongs here: this layer asks and carries the answer back, so a page and the host cannot
    /// disagree about what the file holds.
    pub(crate) async fn rules(&self) -> IpcResult<EngineRulesView> {
        self.ensure_running().await?;
        let data = self
            .call_ok(command_frame("rules_read", None), CAPABILITY_TIMEOUT_MS)
            .await?;
        decode(data, "global rules")
    }

    /// Replaces the engine's user-scope `RULES.md` with `content`, and answers with the file as it
    /// stands after the write - the same shape the read reports, so a caller never has to guess
    /// what landed.
    ///
    /// What a write means is the host's to define, because the engine offers no API for it: the
    /// host replaces the file atomically and drops the engine's capability cache so later turns see
    /// the new text. An empty `content` is a legitimate write - the engine then finds no user rules -
    /// and a file that does not exist yet is created by it. This layer carries the text and
    /// nothing else; the size a write may have is checked in `commands::capabilities` before any
    /// frame is built.
    pub(crate) async fn rules_write(&self, content: &str) -> IpcResult<EngineRulesView> {
        self.ensure_running().await?;
        let mut request = command_frame("rules_write", None);
        request["content"] = json!(content);
        let data = self.call_ok(request, CAPABILITY_TIMEOUT_MS).await?;
        decode(data, "global rules")
    }
}

/// The frame a capability command sends: its type, plus the working directory when the caller named
/// a workspace.
///
/// The key is added rather than sent blank, because "no `cwd`" is a real request of its own - the
/// host then uses its default workspace - and an empty string would ask it about a directory that
/// does not exist.
///
/// Shared with the plugin calls (`host::plugins`), which address a workspace the same way and must
/// not grow a second rule for when `cwd` travels.
pub(super) fn command_frame(kind: &str, cwd: Option<&str>) -> Value {
    let mut frame = json!({ "type": kind });
    if let Some(cwd) = cwd {
        frame["cwd"] = json!(cwd);
    }
    frame
}

/// One host answer, read into the type the command returns.
///
/// A shape this build cannot read is a protocol failure rather than a user error: it means the host
/// is answering in a vocabulary this process does not know, which is the same condition the rest of
/// this layer reports as `ENGINE_PROTOCOL` for an answer it cannot use. The message names the page,
/// so the failing read is identifiable without a payload dump.
///
/// Shared with the plugin calls (`host::plugins`), so a payload this build cannot read fails the
/// same way wherever it arrives.
pub(super) fn decode<T: DeserializeOwned>(data: Value, what: &'static str) -> IpcResult<T> {
    serde_json::from_value(data).map_err(|_| {
        IpcError::from_message(
            ENGINE_PROTOCOL,
            format!("The host's {what} answer could not be read."),
        )
    })
}
