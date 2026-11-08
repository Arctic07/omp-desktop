//! The P1 capability frames: what a plugin asks this application to *read*, and the socket calls it
//! asks this application to perform, carried to the host process that already holds the answers.
//!
//! Every method here is the same three steps the plugin settings calls use
//! (`host::plugins`): make sure a host is running, send the frame, read the answer. Nothing is
//! recomputed on this side - the session index, the usage accounting and the models are the host's
//! own (`host/src/plugin-sessions.ts`, `host/src/plugin-usage.ts`, `host/src/plugin-agent.ts`), and a
//! second projection here would be the second copy `rules.md#plugin-system` forbids.
//!
//! The gates are *not* here. Every call reaching these methods was already judged by the bridge
//! (`services::plugins::bridge::capabilities`): the permission, the page size, the window, the topic
//! and the address were all decided before a frame existed. What this layer adds is the transport
//! budget and the refusal vocabulary for a host that could not answer.
//!
//! **The socket calls are the one stateful family.** A socket lives in the host's own client
//! (`host/src/plugin-websocket.ts`); this side owns the *count* (a per-installation table, so the
//! eight-socket ceiling is enforced where the installation is) and asks the host to open, send,
//! receive and close. Nothing here trusts a socket id: the host answers `not_found` for an id it does
//! not hold, and this side's table is what stops one installation closing another's.

use base64::Engine;
use serde_json::{json, Value};

use crate::errors::IpcResult;
use crate::services::plugins::bridge::DataRequest;

use super::super::{
    PLUGIN_COMPLETION_TIMEOUT_MS, PLUGIN_DATA_TIMEOUT_MS, PLUGIN_SOCKET_TIMEOUT_MS,
};
use super::capabilities::command_frame;
use super::HostRuntime;

impl HostRuntime {
    /// One P1 read: the session index, one conversation, its messages, or the usage accounting.
    ///
    /// The request is the bridge's own (`bridge::capabilities::DataRequest`), so the frame this
    /// sends carries exactly the fields that survived the gate - a `limit` of 200 is the number that
    /// travelled, not a default applied twice.
    pub(crate) async fn plugin_data(&self, request: &DataRequest) -> IpcResult<Value> {
        self.ensure_running().await?;
        let Some(frame) = data_frame(request) else {
            // The completion and the socket calls have their own methods: they are not reads, and a
            // read entry point reached with one of them is a caller this layer cannot serve.
            return Err(crate::errors::IpcError::from_message(
                crate::errors::INVALID_INPUT,
                "That request is not a plugin data read.".to_owned(),
            ));
        };
        self.call_plugin(frame, PLUGIN_DATA_TIMEOUT_MS).await
    }

    /// The two session *writes*: one conversation renamed, one deleted.
    ///
    /// They are the plugin surface's only writes to a conversation, and they are carried by the
    /// desktop's own frames - `session_set_name` and `session_delete` - rather than by a pair of
    /// their own. One frame per operation is what keeps a plugin's write on the same handler, the
    /// same registry method and the same refusals the desktop's own write uses. What a plugin holds
    /// and the desktop's own callers do not is the routing id `session.read` published, which is what
    /// these frames carry here; the host resolves it (its delete takes an id or a path,
    /// `host/src/session-files.ts`). Nothing on this side turns an id into a path, and nothing here
    /// writes a session file.
    pub(crate) async fn plugin_session_write(&self, request: &DataRequest) -> IpcResult<Value> {
        self.ensure_running().await?;
        let Some(frame) = write_frame(request) else {
            return Err(crate::errors::IpcError::from_message(
                crate::errors::INVALID_INPUT,
                "That request is not a plugin session write.".to_owned(),
            ));
        };
        self.call_plugin(frame, PLUGIN_DATA_TIMEOUT_MS).await
    }

    /// One completion on the models this application is configured with (`plugins_agent_complete`).
    ///
    /// The wait is the commit draft's own budget: one blocking model call, no streaming.
    pub(crate) async fn plugin_agent_complete(
        &self,
        prompt: &str,
        system: Option<&str>,
        model: Option<&str>,
        max_tokens: u64,
    ) -> IpcResult<Value> {
        self.ensure_running().await?;
        let mut frame = command_frame("plugins_agent_complete", None);
        frame["prompt"] = json!(prompt);
        if let Some(system) = system {
            frame["system"] = json!(system);
        }
        if let Some(model) = model {
            frame["model"] = json!(model);
        }
        frame["maxTokens"] = json!(max_tokens);
        self.call_plugin(frame, PLUGIN_COMPLETION_TIMEOUT_MS).await
    }

    /// Opens one socket in the host's client and answers with the id it issued.
    pub(crate) async fn plugin_socket_open(
        &self,
        socket_id: &str,
        url: &str,
        owner: &str,
    ) -> IpcResult<Value> {
        self.ensure_running().await?;
        let mut frame = command_frame("plugins_ws_open", None);
        frame["socketId"] = json!(socket_id);
        frame["url"] = json!(url);
        // The owner is what the host files the socket under, so a stop can close everything one
        // installation holds without this side enumerating them first.
        frame["owner"] = json!(owner);
        self.call_plugin(frame, PLUGIN_SOCKET_TIMEOUT_MS).await
    }

    /// Sends one frame on a socket the host holds.
    ///
    /// The text travels as base64 so a plugin's binary-ish frame is not silently re-encoded by JSON:
    /// the host decodes it to the bytes it puts on the wire, and a caller that sent text gets its
    /// text back from `receive` in the same encoding.
    pub(crate) async fn plugin_socket_send(&self, socket_id: &str, data: &str) -> IpcResult<Value> {
        self.ensure_running().await?;
        let mut frame = command_frame("plugins_ws_send", None);
        frame["socketId"] = json!(socket_id);
        frame["data"] = json!(base64::engine::general_purpose::STANDARD.encode(data.as_bytes()));
        self.call_plugin(frame, PLUGIN_SOCKET_TIMEOUT_MS).await
    }

    /// Closes one socket.
    pub(crate) async fn plugin_socket_close(&self, socket_id: &str) -> IpcResult<Value> {
        self.ensure_running().await?;
        let mut frame = command_frame("plugins_ws_close", None);
        frame["socketId"] = json!(socket_id);
        self.call_plugin(frame, PLUGIN_SOCKET_TIMEOUT_MS).await
    }

    /// Waits up to `wait_ms` for whatever a socket has buffered, and answers that many frames.
    pub(crate) async fn plugin_socket_receive(
        &self,
        socket_id: &str,
        wait_ms: u64,
        limit: u64,
    ) -> IpcResult<Value> {
        self.ensure_running().await?;
        let mut frame = command_frame("plugins_ws_receive", None);
        frame["socketId"] = json!(socket_id);
        frame["waitMs"] = json!(wait_ms);
        frame["limit"] = json!(limit);
        self.call_plugin(frame, PLUGIN_SOCKET_TIMEOUT_MS).await
    }

    /// Closes every socket one installation holds, after it stops or is disabled.
    ///
    /// The answer is not read: a stop is not the moment to report a host that did not answer, and the
    /// host closes an installation's sockets itself when the process that owned them goes away.
    pub(crate) async fn plugin_sockets_close_owner(&self, owner: &str) {
        if self.ensure_running().await.is_err() {
            return;
        }
        let mut frame = command_frame("plugins_ws_close_owner", None);
        frame["owner"] = json!(owner);
        let _ = self.call_plugin(frame, PLUGIN_SOCKET_TIMEOUT_MS).await;
    }
}

/// The frame one session *write* turns into, or `None` when the request is not one.
///
/// Neither name is new, and that is the point: a plugin's rename is the desktop's own
/// `session_set_name` and its delete is the desktop's own `session_delete` (`host/src/dispatch.ts`),
/// so one handler, one registry method and one set of refusals serve both callers. The one field
/// that differs is the address - a plugin holds the routing id the index published, the desktop's own
/// rename is sent on a session-bound connection and its own delete names a transcript, which a plugin
/// never has - and the resolution from that id stays in the host, because the index lives there.
fn write_frame(request: &DataRequest) -> Option<Value> {
    match request {
        DataRequest::SessionRename { session_id, title } => {
            let mut frame = command_frame("session_set_name", None);
            frame["sessionId"] = json!(session_id);
            // `session.rename` calls the argument a title; the frame calls it `name`.
            frame["name"] = json!(title);
            Some(frame)
        }
        DataRequest::SessionDelete { session_id } => {
            let mut frame = command_frame("session_delete", None);
            frame["sessionId"] = json!(session_id);
            Some(frame)
        }
        _ => None,
    }
}

/// The frame one read turns into, or `None` when the request is not a read.
///
/// One function rather than four methods because the four differ only in their fields: the bridge
/// already decided which of them may be asked, and the host's own dispatch is a `switch` on the same
/// four names.
fn data_frame(request: &DataRequest) -> Option<Value> {
    match request {
        DataRequest::SessionList {
            limit,
            cursor,
            project_id,
        } => {
            let mut frame = command_frame("plugins_session_list", None);
            frame["limit"] = json!(limit);
            if let Some(cursor) = cursor {
                frame["cursor"] = json!(cursor);
            }
            if let Some(project_id) = project_id {
                frame["projectId"] = json!(project_id);
            }
            Some(frame)
        }
        DataRequest::SessionGet { session_id } => {
            let mut frame = command_frame("plugins_session_get", None);
            frame["sessionId"] = json!(session_id);
            Some(frame)
        }
        DataRequest::SessionMessages {
            session_id,
            limit,
            cursor,
            descending,
            content_limit,
        } => {
            let mut frame = command_frame("plugins_session_messages", None);
            frame["sessionId"] = json!(session_id);
            frame["limit"] = json!(limit);
            frame["order"] = json!(if *descending { "desc" } else { "asc" });
            if let Some(cursor) = cursor {
                frame["cursor"] = json!(cursor);
            }
            if let Some(content_limit) = content_limit {
                frame["contentLimit"] = json!(content_limit);
            }
            Some(frame)
        }
        DataRequest::UsageTurns {
            from_ms,
            to_ms,
            session_id,
            project_id,
            limit,
            cursor,
        } => {
            let mut frame = command_frame("plugins_usage_turns", None);
            frame["limit"] = json!(limit);
            if let Some(from_ms) = from_ms {
                frame["fromMs"] = json!(from_ms);
            }
            if let Some(to_ms) = to_ms {
                frame["toMs"] = json!(to_ms);
            }
            if let Some(session_id) = session_id {
                frame["sessionId"] = json!(session_id);
            }
            if let Some(project_id) = project_id {
                frame["projectId"] = json!(project_id);
            }
            if let Some(cursor) = cursor {
                frame["cursor"] = json!(cursor);
            }
            Some(frame)
        }
        // The completion and the socket calls have their own methods above, because they are not
        // reads: one spends money and the others hold state. Reaching them here would mean this
        // frame builder knew about budgets it does not own.
        DataRequest::AgentComplete { .. }
        | DataRequest::WebSocketOpen { .. }
        | DataRequest::WebSocketSend { .. }
        | DataRequest::WebSocketClose { .. }
        | DataRequest::WebSocketReceive { .. } => None,
        // The two session writes have their own builder (`write_frame`): they are not reads, and the
        // frames they end at are the desktop's own (`session_set_name` / `session_delete`), built
        // with the id those frames do not take from this side.
        DataRequest::SessionRename { .. } | DataRequest::SessionDelete { .. } => None,
    }
}
