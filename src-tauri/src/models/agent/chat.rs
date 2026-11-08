//! The rows of a conversation: what one message carries, and the frames a history walk reports it
//! on.
//!
//! Split out of [`super`] when the image and history work pushed that file past the bound
//! (`rules.md#single-file-line-limit`), the same way [`super::work`] and [`super::stop`] were. Re-exported from [`super`],
//! so every caller still names them through `models::agent`.

use serde::{Deserialize, Serialize};

use super::work::ToolDetails;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct ChatAttachmentRef {
    pub(crate) name: String,
    pub(crate) path: String,
    #[serde(rename = "mimeType")]
    pub(crate) mime_type: String,
    pub(crate) bytes: u64,
}

/// One picture an engine result or message carried, ready to render.
///
/// The engine sends images as base64 parts inside a `content` array, which is nothing a row can
/// draw; the projection (`services/runtime/mod.rs::content_images`) turns each into the data URL a
/// row puts straight into an `<img src>` and bounds the list. Nothing here is re-encoded on this
/// side, and `bytes` is the decoded size that projection derives from the payload's own length, so
/// a row can label a thumbnail without decoding the picture to measure it.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct ChatImage {
    /// The image MIME type, as the engine reported it (`image/png`).
    #[serde(rename = "mimeType")]
    pub(crate) mime_type: String,
    /// Decoded size in bytes, for the thumbnail's own size label.
    pub(crate) bytes: usize,
    /// A data URL ready for `<img src>`: `data:<mime>;base64,<data>`.
    #[serde(rename = "dataUrl")]
    pub(crate) data_url: String,
}

/// One assistant message's token accounting, exactly as the engine reports it on the
/// wire / in the session file. `costUsd` is the sum of the engine's four cost buckets.
#[derive(Debug, Clone, Copy, Serialize)]
pub(crate) struct ChatTokenUsage {
    pub(crate) input: i64,
    pub(crate) output: i64,
    #[serde(rename = "cacheRead")]
    pub(crate) cache_read: i64,
    #[serde(rename = "cacheWrite")]
    pub(crate) cache_write: i64,
    /// Reasoning tokens of this message, from the engine's own `reasoningTokens`.
    ///
    /// Optional where the other buckets are zero-filled, and deliberately so: `None` is the
    /// engine reporting no reasoning bucket at all, which is not the same fact as a reported
    /// zero. A bucket that was never reported renders as empty rather than as `0`.
    #[serde(rename = "reasoning")]
    pub(crate) reasoning: Option<i64>,
    #[serde(rename = "costUsd")]
    pub(crate) cost_usd: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum ChatMessage {
    User {
        id: String,
        at: i64,
        text: String,
        attachments: Vec<ChatAttachmentRef>,
        /// The session entry this message was written as (`host/src/sessions.ts`'s
        /// `#withEntryIds`), when the read could pair them.
        ///
        /// Entry ids are what the entry-addressed commands speak - branching names one - so this is
        /// what lets a message row offer to continue from itself. `None` is a message no entry
        /// backs (a local echo, a synthetic reminder, a file mention), and a row without one draws
        /// no such action rather than a control that could not act.
        #[serde(rename = "entryId", skip_serializing_if = "Option::is_none")]
        entry_id: Option<String>,
    },
    Assistant {
        id: String,
        at: i64,
        text: String,
        thinking: String,
        error: Option<String>,
        /// The session entry this answer was written as, when the read could pair them.
        ///
        /// It is what a rewind names: the row a reader points at when they want the conversation to
        /// carry on from an answer rather than from the message that asked for it. `None` is a row
        /// no entry backs (a live row this host built from frames, an entry the read could not
        /// pair), and a row without one offers no such action.
        #[serde(rename = "entryId", skip_serializing_if = "Option::is_none")]
        entry_id: Option<String>,
        /// The engine's own reason this turn ended ("aborted", "error", "stop", …), `None` when it
        /// reported none - a message that never ended on this host, or a host that predates the
        /// field. The frontend draws a stopped turn differently from a failed one, and this is the
        /// fact that tells them apart.
        #[serde(rename = "stopReason", skip_serializing_if = "Option::is_none")]
        stop_reason: Option<String>,
        /// The clock (ms) the message started writing on: the host's own reading of the first
        /// streamed delta live, and the engine's `timestamp` for a row read back from history. It
        /// and `endedAt` come from one clock family - both readings are epoch ms from this machine -
        /// which is what lets a turn read back from a transcript report the same span it did
        /// live. `None` only when neither side stamped the row.
        #[serde(rename = "startedAt")]
        started_at: Option<i64>,
        /// The clock (ms) the message ended on: the host's `message_end` live, the engine's
        /// `completedAt` for a row read back from history. `None` when the message never ended on
        /// this host and the transcript never recorded a completion (an aborted turn's row).
        #[serde(rename = "endedAt")]
        ended_at: Option<i64>,
        /// The engine's own accounting for this message, `None` when it reported none.
        usage: Option<ChatTokenUsage>,
        #[serde(rename = "modelProvider")]
        model_provider: Option<String>,
        #[serde(rename = "modelId")]
        model_id: Option<String>,
        /// The pictures the message carried, in the engine's order.
        ///
        /// An answer can be a picture rather than a sentence (a screenshot the engine took, an
        /// image it generated), and the words beside it are often empty. The field is added only
        /// when there is something in it, so a message without pictures serializes exactly as it
        /// did before this existed.
        #[serde(rename = "images", default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<ChatImage>,
    },
    Tool {
        id: String,
        at: i64,
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        /// The session entry this row continues from, when the read could pair one: the call's own
        /// result entry once the page holds it, and the entry that made the call when it does not
        /// (a page that starts mid-turn). A rewind from this row's turn names it.
        #[serde(rename = "entryId", skip_serializing_if = "Option::is_none")]
        entry_id: Option<String>,
        name: String,
        state: String,
        #[serde(rename = "argsText")]
        args_text: String,
        #[serde(rename = "resultText")]
        result_text: String,
        /// Host clock (ms) of `tool_execution_start`, `None` for a row read back from history.
        #[serde(rename = "startedAt")]
        started_at: Option<i64>,
        /// Host clock (ms) of `tool_execution_end`, `None` while the call is still running.
        #[serde(rename = "endedAt")]
        ended_at: Option<i64>,
        /// The engine's one-line description of the call (`ToolCallContent.intent`), `None` when it
        /// stated none. The live `tool_execution_start` frame and the call part a reopened
        /// conversation is built from carry the same value, so a row reads the same either way -
        /// and for a call whose arguments name nothing the row's presentation knows, this line is
        /// the row's only words.
        intent: Option<String>,
        /// The structured part of the result a row draws (a diff, a file path, the subagents one
        /// `task` call ran). Absent for a call that reported none, and absent for a host that
        /// never sent any.
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<ToolDetails>,
        /// The pictures the result carried, in the engine's order: what a `read` of an image, a
        /// `generate_image`, a screenshot or a `computer` capture reported.
        ///
        /// Added only when non-empty, like `details`, so a call that reported none keeps the frame
        /// it always had.
        #[serde(rename = "images", default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<ChatImage>,
    },
    /// One reminder the harness injected into the turn, which the reader is meant to see.
    ///
    /// The engine writes a rule check that fired on a tool call into a **developer** message — the
    /// engine's own context for the model, and every other developer message stays out of the
    /// transcript for exactly that reason. This one is drawn because it explains something the
    /// reader just watched happen: the call beside it was refused or altered.
    ///
    /// `text` is the harness block as it was written (`<system-reminder reason="rule_violation"
    /// rule="ts-no-any" …>…</system-reminder>`). It travels whole rather than as parsed fields so the
    /// reading of the engine's tag stays in one place, on the side that draws it
    /// (`src/src/home/reminder.ts`).
    Reminder { id: String, at: i64, text: String },
}

/// Progress of one history walk: the rows normalized so far and the count the engine gave for
/// the whole transcript, `0` while no page has reported one.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryProgress {
    pub(crate) loaded: i64,
    pub(crate) total: i64,
}

/// Streamed over `session_history`'s channel while the host walks the engine's pages; the walk
/// itself answers with [`SessionHistory`].
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum HistoryChunk {
    Progress(HistoryProgress),
    /// One page's worth of rows, already normalized.
    ///
    /// Reported only when the caller asked to paint while reading (`streamRows`): a long transcript
    /// then reaches the screen one bounded page at a time instead of as one payload that the UI
    /// parses and draws in a single turn. A caller that only wants the answer does not pay for rows
    /// it will receive again.
    ///
    /// `reset` says the walk started over - a cursor went stale because a turn wrote while it ran -
    /// so the rows read so far are not a prefix of the transcript any more and the reader must
    /// replace them rather than append.
    Rows {
        messages: Vec<ChatMessage>,
        loaded: i64,
        total: i64,
        #[serde(skip_serializing_if = "super::is_false")]
        reset: bool,
    },
}

/// The whole transcript of one session in the render shape: the same normalization and the same
/// order the frontend used to assemble by paging `get_messages_page` itself.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionHistory {
    pub(crate) messages: Vec<ChatMessage>,
    pub(crate) total_messages: i64,
}
