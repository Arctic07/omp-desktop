//! The questions a plugin page's own call raises, and the user's answers to them (spec §6.3-4).
//!
//! A bridge call is answered on a blocking thread, and some of those answers are the user's: a read
//! that leaves the declared scope, a clipboard direction used for the first time. The shape here is
//! the one that keeps that wait honest - the caller registers a question, the main window is told,
//! and the caller blocks on a channel that only an answer, a timeout, or the installation going away
//! can end. Three properties are what make it a gate rather than a prompt:
//!
//! - **No answer is an answer.** A timeout, a window that is gone, an installation that was
//!   re-published while the question was open - all of them resolve as *denied* (spec §6.1-1: a host
//!   that cannot ask does not allow). Nothing here ever falls through to "allowed".
//! - **One question, one call.** The entry is removed the moment it is answered, so an answer cannot
//!   be replayed by a second call - and the answer carries its own scope: `once` authorizes the call
//!   that asked, `session` is what the caller records in [`crate::services::plugins::gates`].
//! - **Bounded.** At most [`MAX_PENDING_PROMPTS`] questions are open at once, per process. A page
//!   that asks more than that is refused rather than queued: the queue would otherwise be a way to
//!   hold the blocking pool while the user looks at something else, and a plugin page that has eight
//!   unanswered questions has a bug, not a use case.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;

use serde::Serialize;

/// How many questions may be open at once; beyond it a call is refused with `busy`.
pub(crate) const MAX_PENDING_PROMPTS: usize = 8;

/// The event the main window is told about a question through. One name, because there is one card.
pub(crate) const PROMPT_EVENT: &str = "plugin-prompt";

/// One question as the card receives it.
///
/// Every field is display material and nothing else: the id addresses the question, the two plugin
/// fields are what the card names, the scope says which installation the answer is about, `kind` is
/// one of [`PromptKind`]'s two tokens and `target` is what the plugin asked for - the path it named,
/// which is the plugin's own spelling and not a machine path.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PromptRequest {
    pub(crate) id: u64,
    pub(crate) plugin_id: String,
    pub(crate) plugin_name: String,
    pub(crate) scope: String,
    pub(crate) kind: &'static str,
    pub(crate) target: String,
}

/// The kinds of question a bridge call can raise. The string is the payload's own vocabulary: the
/// page renders it, so it is one of a closed set rather than a sentence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PromptKind {
    /// A read outside the installation's declared scope (spec §6.3-4).
    ReadOutOfScope,
    /// A clipboard read used for the first time (spec §6.2: confirm on first use).
    ClipboardRead,
    /// A clipboard write used for the first time.
    ClipboardWrite,
    /// A write outside the installation's declared scope (spec §6.3-4).
    WriteOutOfScope,
    /// A delete outside the installation's declared scope.
    DeleteOutOfScope,
    /// A completion on this application's models, used for the first time (API 0.2.0). High risk in
    /// the one way a permission can be: it spends the user's money at the provider. It has its own
    /// sentence and its own kind because a reader answering a question about cost is answering
    /// nothing else.
    AgentComplete,
}

impl PromptKind {
    /// The permission this question is about (spec §6.2): what the manifest has to declare before
    /// the question is even asked.
    pub(crate) fn permission(self) -> &'static str {
        match self {
            PromptKind::ReadOutOfScope => "fs.read",
            PromptKind::ClipboardRead => "clipboard.read",
            PromptKind::ClipboardWrite => "clipboard.write",
            PromptKind::WriteOutOfScope => "fs.write",
            PromptKind::DeleteOutOfScope => "fs.delete",
            PromptKind::AgentComplete => "agent.complete",
        }
    }

    /// The session grant a `session` answer stands for, when this is one of the clipboard's two
    /// questions. A read outside a scope is granted per *file*, so it has no direction here - the
    /// caller remembers the file it asked about.
    pub(crate) fn clipboard_direction(self) -> Option<&'static str> {
        match self {
            PromptKind::ClipboardRead => Some("read"),
            PromptKind::ClipboardWrite => Some("write"),
            PromptKind::ReadOutOfScope
            | PromptKind::WriteOutOfScope
            | PromptKind::DeleteOutOfScope
            // A completion is granted as one capability, so the caller remembers it itself
            // (`bridge::remember_session`).
            | PromptKind::AgentComplete => None,
        }
    }

    /// The token the page receives and answers about.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            PromptKind::ReadOutOfScope => "fs.read.outOfScope",
            PromptKind::ClipboardRead => "clipboard.read",
            PromptKind::ClipboardWrite => "clipboard.write",
            PromptKind::WriteOutOfScope => "fs.write.outOfScope",
            PromptKind::DeleteOutOfScope => "fs.delete.outOfScope",
            PromptKind::AgentComplete => "agent.complete",
        }
    }
}

/// What the user answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PromptAnswer {
    /// The call is refused, and nothing is remembered.
    Deny,
    /// This one call may go ahead.
    Once,
    /// This installation may do this for the rest of the process.
    Session,
}

impl PromptAnswer {
    /// The answer one command argument names, or `None` when it names none of them.
    pub(crate) fn parse(token: &str) -> Option<Self> {
        match token {
            "deny" => Some(PromptAnswer::Deny),
            "once" => Some(PromptAnswer::Once),
            "session" => Some(PromptAnswer::Session),
            _ => None,
        }
    }
}

/// One open question, as the caller parked it.
struct Pending {
    /// The installation that asked, so a re-published registry can cancel what it asked.
    key: String,
    sender: Sender<PromptAnswer>,
}

/// The questions this process has open.
///
/// **Owner / bound / release.** Owned by `AppState`; bounded by [`MAX_PENDING_PROMPTS`]; every entry
/// is released by the answer that resolves it, by its caller giving up (timeout), or by
/// [`Self::clear`] when the installation is re-published.
#[derive(Default)]
pub(crate) struct PluginPrompts {
    inner: Mutex<HashMap<u64, Pending>>,
    next: AtomicU64,
}

impl PluginPrompts {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Registers one question and hands back the id the page is told about, plus the receiver its
    /// asker blocks on. `None` means the table is full, which the caller answers as `busy`.
    pub(crate) fn open(&self, key: &str) -> Option<(u64, Receiver<PromptAnswer>)> {
        let mut table = self.inner.lock().ok()?;
        if table.len() >= MAX_PENDING_PROMPTS {
            return None;
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (sender, receiver) = channel();
        table.insert(
            id,
            Pending {
                key: key.to_owned(),
                sender,
            },
        );
        Some((id, receiver))
    }

    /// Resolves one question. `false` means it was already answered, timed out, or never existed -
    /// all of which the caller's command reports as "no such question" rather than as a write.
    pub(crate) fn answer(&self, id: u64, answer: PromptAnswer) -> bool {
        let Ok(mut table) = self.inner.lock() else {
            return false;
        };
        match table.remove(&id) {
            // A send can only fail when the asker already gave up (its wait timed out and it dropped
            // the receiver); the question is gone either way, so a lost answer is reported as one.
            Some(pending) => pending.sender.send(answer).is_ok(),
            None => false,
        }
    }

    /// Drops one question without answering it; the asker's channel closes and it reads that as a
    /// denial. Used by a caller whose wait timed out before the user decided.
    pub(crate) fn drop_question(&self, id: u64) {
        if let Ok(mut table) = self.inner.lock() {
            table.remove(&id);
        }
    }

    /// Cancels every question one installation has open, which is what a re-published registry means:
    /// the package those questions were about is not the package the window now runs.
    pub(crate) fn clear(&self, key: &str) {
        if let Ok(mut table) = self.inner.lock() {
            table.retain(|_, pending| pending.key != key);
        }
    }

    /// Whether one installation has a question open right now.
    ///
    /// This is the supervisor's reading, and it exists for one budget: a worker call parked on the
    /// user's answer is waiting for a person, not for the plugin, so the call's deadline must not run
    /// while this is true (`CALL_TIMEOUT` would otherwise stop a process for a reader who took their
    /// time). Only the *presence* of a question is exposed; its id, kind and target stay the card's.
    pub(crate) fn has_open(&self, key: &str) -> bool {
        let Ok(table) = self.inner.lock() else {
            return false;
        };
        table.values().any(|pending| pending.key == key)
    }

    /// How many questions are open; the only number here a caller may read.
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.inner.lock().map(|table| table.len()).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_question_is_answered_once_and_the_answer_reaches_the_asker() {
        let prompts = PluginPrompts::new();
        let (id, receiver) = prompts.open("key-a").expect("room for one question");
        assert_eq!(prompts.len(), 1);
        assert!(prompts.answer(id, PromptAnswer::Session));
        assert_eq!(
            receiver.recv_timeout(Duration::from_millis(50)),
            Ok(PromptAnswer::Session)
        );
        assert!(
            !prompts.answer(id, PromptAnswer::Once),
            "the second answer has no question left"
        );
        assert_eq!(prompts.len(), 0);
    }

    #[test]
    fn dropping_a_question_ends_the_wait_without_an_answer() {
        let prompts = PluginPrompts::new();
        let (id, receiver) = prompts.open("key-a").expect("room for one question");
        prompts.drop_question(id);
        assert!(
            receiver.recv_timeout(Duration::from_millis(50)).is_err(),
            "a dropped question reads as denied"
        );
        assert_eq!(prompts.len(), 0);
    }

    #[test]
    fn the_table_is_bounded_and_one_installation_can_be_cleared() {
        let prompts = PluginPrompts::new();
        let mut held = Vec::new();
        for _ in 0..MAX_PENDING_PROMPTS {
            held.push(prompts.open("key-a").expect("within the bound"));
        }
        assert!(
            prompts.open("key-b").is_none(),
            "the bound is the process's, so a second installation does not add room"
        );
        assert_eq!(prompts.len(), MAX_PENDING_PROMPTS);
        prompts.clear("key-a");
        assert_eq!(
            prompts.len(),
            0,
            "clearing one installation releases exactly its own questions"
        );
        let (other, _receiver) = prompts.open("key-b").expect("room again");
        assert!(prompts.answer(other, PromptAnswer::Deny));
        drop(held);
    }
}
