//! What a content search answers: the conversations that say a thing, and the lines where they say
//! it.
//!
//! A result is a *conversation*, not a message, because that is what a reader does with it - they
//! open it. The snippets exist so the row can show why it matched without the reader opening
//! anything, and they carry the match wrapped in two control characters (`session_index::projection
//! ::search::MARK_START` / `MARK_END`): the only markup that crosses this boundary is the position
//! of the match, never HTML.

use serde::Serialize;

/// One matched conversation.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct SessionSearchHit {
    /// The id the host routes this transcript by - what opening it addresses.
    pub(crate) session_id: String,
    #[serde(rename = "filePath")]
    pub(crate) file_path: String,
    /// The conversation's own title, empty for a transcript the engine never named: a search result
    /// row falls back to its first snippet rather than to a placeholder.
    pub(crate) title: String,
    /// The workspace the transcript's header names, in the spelling stored there.
    pub(crate) cwd: String,
    /// Which registered workspace that is, when one is registered for it: the row cannot be opened
    /// without it, so a caller draws such a hit without an action rather than as a dead button.
    #[serde(rename = "workspaceId", skip_serializing_if = "Option::is_none")]
    pub(crate) workspace_id: Option<i64>,
    /// When the conversation was last written in, in Unix milliseconds - the same stamp the rail
    /// sorts by.
    #[serde(rename = "updatedAt")]
    pub(crate) updated_at: i64,
    /// How many of its lines matched, so a row can say "12 matches".
    #[serde(rename = "matchCount")]
    pub(crate) match_count: i64,
    /// The newest matched lines, at most three, marked as described above.
    pub(crate) snippets: Vec<SessionSearchSnippet>,
}

/// One matched line of a conversation.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct SessionSearchSnippet {
    /// The message's position in the transcript, oldest first - stable for one file state.
    pub(crate) seq: i64,
    /// `user`, `assistant` or `custom`: whose line it was.
    pub(crate) role: String,
    /// The text around the match, with `\u{1}` before it and `\u{2}` after it.
    pub(crate) text: String,
}
