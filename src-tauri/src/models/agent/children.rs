//! The subagents of one conversation, as that conversation's own header lists them.
//!
//! A subagent is a session of its own inside the engine and is written next to the conversation
//! that spawned it (`<sessions>/<parent>.jsonl` with `<sessions>/<parent>/<ChildName>.jsonl`
//! beside it), so it is never a row of a workspace and never reaches the sidebar. What the header
//! needs from it is a name, a moment and how it ended; the session index derives those from the
//! child's own transcript, exactly as it derives them for a listed row.

use serde::Serialize;

use super::SessionColdStatus;

/// One subagent transcript of a conversation.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct SessionChild {
    /// The id the host routes the child's file by, from the same derivation a listed session's id
    /// uses (`session_index::host_session_id`): opening the child addresses it by this.
    pub(crate) id: String,
    /// The title the transcript carries, or - a subagent's transcript is written without one - the
    /// file name it was written under, which is the name the engine gave the subagent.
    pub(crate) title: String,
    #[serde(rename = "filePath")]
    pub(crate) file_path: String,
    /// When the child's newest message was written, in Unix milliseconds, as for a listed row.
    #[serde(rename = "updatedAt")]
    pub(crate) updated_at: i64,
    /// How the child ended, from the child's own directory: a written result artifact means it
    /// yielded (`complete`), and otherwise the transcript's tail decides - the rules a listed row
    /// follows do not fit a child, whose newest message may simply be the tool result it handed
    /// back (see `session_index::children::child_row_status`).
    pub(crate) status: SessionColdStatus,
}

/// The answer of `session_children`.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct SessionChildren {
    /// Oldest first, the order the subagents were spawned in.
    pub(crate) children: Vec<SessionChild>,
    /// True when children were left out of this answer: a conversation with more subagents than one
    /// read keeps is answered with its newest ones, and the oldest are the ones dropped.
    ///
    /// Serialized (a body without it reads as `false`) so a caller can say the list it draws is
    /// partial instead of presenting a truncated roster as everything the conversation ran.
    #[serde(default)]
    pub(crate) truncated: bool,
}
