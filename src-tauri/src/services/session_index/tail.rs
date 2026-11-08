//! The tail window of a session file, and the two facts a summary reads out of it: the status the
//! session is cold in and the moment its newest message was written.
//!
//! Both come off one pass over one window: the time is only to be found in the message that states
//! the status, and the window has to be read for that status anyway - a second walk would parse the
//! same bytes again for a field the entry already in hand carries. The window is bounded
//! (`TAIL_BYTES`) because transcripts reach several megabytes while both facts always sit at the
//! end of the file, and that end is all a summary may pay for.
//!
//! The window read itself - and the test-side counter that proves how many of them a scan made -
//! stays in the parent, as does the summary that consumes these facts; the walk over the store
//! belongs to [`super::scan`].
//!
//! A subagent's window is read over the same bytes and by a rule of its own: a child ends by
//! handing its result over rather than by the user writing anything, so [`child_status`] states the
//! ending a child's row is read by, and [`super::children`] combines that with the artifact the
//! engine writes *beside* the transcript when the child yields.

use std::fs::File;

use serde_json::Value;

use super::read_window;
use crate::models::agent::SessionColdStatus;
use crate::services::session_title::parse_line;

/// Tail window the summary's two tail facts are read from: the cold status and the moment the
/// newest message was written. One window, one pass over it.
const TAIL_BYTES: usize = 32 * 1024;

/// What the tail window says about a session: the status its newest message states and when that
/// message was written.
pub(super) struct TailFacts {
    pub(super) status: SessionColdStatus,
    /// The engine stamps every message with its own clock (Unix ms). `None` when the window holds
    /// no message whose stamp can be read.
    pub(super) last_message_at: Option<i64>,
}

/// Reads both tail facts off one pass over the window. The window usually starts mid-line, so its
/// first segment is dropped; the newest `message` entry that still parses answers both questions -
/// the status it states and the moment it was written. A later entry of another type is the
/// engine's own bookkeeping about the session, not something the user or the agent wrote, so it
/// says nothing about either fact.
pub(super) fn tail_facts(tail: &[u8]) -> TailFacts {
    let mut segments = tail.split(|byte| *byte == b'\n');
    if segments.next().is_none() {
        return TailFacts {
            status: SessionColdStatus::Unknown,
            last_message_at: None,
        };
    }
    for segment in segments.rev() {
        let entry: Value = match parse_line(segment) {
            Some(entry) => entry,
            None => continue,
        };
        if entry.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        return TailFacts {
            status: message_status(&entry),
            last_message_at: entry.get("message").and_then(message_timestamp),
        };
    }
    TailFacts {
        status: SessionColdStatus::Unknown,
        last_message_at: None,
    }
}

/// The moment a message was written, in Unix milliseconds.
///
/// An assistant turn carries two stamps: `timestamp`, when the turn started writing, and
/// `completedAt`, when it was finished - and for a reader "when was this last written" is the
/// completion. Every other role has only its `timestamp`, so that answers when no turn completed.
/// A stamp has to be a positive integer: the engine writes `0` where it has no time, and a row
/// dated to the Unix epoch would be a fabrication rather than a missing fact. A completion the
/// engine left empty is no time either, so the turn's own start still answers.
fn message_timestamp(message: &Value) -> Option<i64> {
    let stamp = |key: &str| {
        message
            .get(key)
            .and_then(Value::as_i64)
            .filter(|millis| *millis > 0)
    };
    stamp("completedAt").or_else(|| stamp("timestamp"))
}

/// The status a subagent's transcript is read as: the ending its own tail records.
///
/// A child is not classed by [`message_status`] alone, and the reason is whose reply the newest
/// message is. A listed session's newest message is written by the conversation's own agent, so an
/// unanswered `user`/`toolResult` tail means *that agent* still owes a reply, and the row has to
/// keep saying so - a turn nothing finished is the app's own `interrupted` mark, never a claim this
/// file may make. A subagent's transcript is the parent's record of a child, and a child ends by
/// handing its result to the parent that spawned it: its transcript can close on a record no listed
/// row ever closes on - the engine's own `session_exit`, written when the session is disposed - and
/// on a tool result that is the last thing the child wrote before yielding. So the ending is read
/// from the records themselves, in the order the endings outrank each other:
///
/// 1. the newest record is `session_exit`, or the newest assistant record says `aborted`: the child
///    is over (stopped, or its process gone), which is an ending rather than work still owed;
/// 2. the newest assistant record says `error`;
/// 3. otherwise the tail is read exactly as a listed row's is ([`message_status`]): a child still
///    inside its turn is `pending`/`unknown` like any other session's.
///
/// The one child-only ending that is not in a tail at all - the result the engine writes *beside*
/// the transcript when the child yields - is checked by the caller before this read, because the
/// artifact is a fact of the child's directory rather than of its window.
pub(super) fn child_status(tail: &[u8]) -> SessionColdStatus {
    let mut segments = tail.split(|byte| *byte == b'\n');
    if segments.next().is_none() {
        return SessionColdStatus::Unknown;
    }
    // Three facts out of one reverse walk: what the newest record is (the first one that parses),
    // what the newest message states, and what the newest assistant turn states. The walk ends at
    // that turn - no older record can state an ending this read has not already seen.
    let mut newest = true;
    let mut exited = false;
    let mut message: Option<SessionColdStatus> = None;
    for segment in segments.rev() {
        let entry: Value = match parse_line(segment) {
            Some(entry) => entry,
            None => continue,
        };
        if newest {
            newest = false;
            exited = is_session_exit(&entry);
        }
        if entry.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        if message.is_none() {
            message = Some(message_status(&entry));
        }
        let Some(inner) = entry.get("message") else {
            continue;
        };
        if inner.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        // This is the newest assistant turn: a record an older one carries cannot state an ending
        // the child's own last turn did not, so the walk ends here.
        return match (inner.get("stopReason").and_then(Value::as_str), exited) {
            // An exit outranks the turn's own stop reason: whatever the turn said, the session is
            // over, and that is the ending a reader of a child row is owed.
            (_, true) | (Some("aborted"), false) => SessionColdStatus::Aborted,
            (Some("error"), false) => SessionColdStatus::Error,
            // Nothing ended the session, so the newest message's own reading stands: a turn that
            // completed reads complete, one that never closed reads pending.
            _ => message.unwrap_or(SessionColdStatus::Unknown),
        };
    }
    // No assistant turn in the window: the session's own exit is the only ending it can state.
    if exited {
        return SessionColdStatus::Aborted;
    }
    message.unwrap_or(SessionColdStatus::Unknown)
}

/// Whether one record is the engine's own session-exit marker.
///
/// The marker is the engine's bookkeeping, so it is a `custom` entry with the kind in `customType`:
/// `{"type":"custom","customType":"session_exit","data":{"reason":…,"kind":…}}` - the spelling the
/// SDK's own reader pins (`session_exit` as the `customType` of a `custom` record whose `data.kind`
/// is one of `normal`/`signal`/`fatal`/`process_exit`). Reading it off the top-level `type` matches
/// nothing the engine has ever written, and a child killed with its process then keeps the tail's
/// `pending` reading: the roster counts it as work still in flight, and a screen attached to its
/// transcript opens on a running line that nothing will ever settle.
fn is_session_exit(entry: &Value) -> bool {
    entry.get("type").and_then(Value::as_str) == Some("custom")
        && entry.get("customType").and_then(Value::as_str) == Some("session_exit")
}

/// Maps the newest message to a status: an assistant turn carries its own stop reason, while a
/// user or tool-result turn means the agent still owes a reply.
fn message_status(entry: &Value) -> SessionColdStatus {
    let Some(message) = entry.get("message") else {
        return SessionColdStatus::Unknown;
    };
    match message.get("role").and_then(Value::as_str) {
        Some("assistant") => match message.get("stopReason").and_then(Value::as_str) {
            Some("stop") | Some("length") => SessionColdStatus::Complete,
            Some("aborted") => SessionColdStatus::Aborted,
            Some("error") => SessionColdStatus::Error,
            Some("toolUse") => SessionColdStatus::Pending,
            _ => SessionColdStatus::Unknown,
        },
        Some("user") | Some("toolResult") => SessionColdStatus::Pending,
        _ => SessionColdStatus::Unknown,
    }
}

/// Reads the last `TAIL_BYTES` of an already-open session file.
pub(super) fn read_tail(file: &mut File) -> std::io::Result<Vec<u8>> {
    let size = file.metadata()?.len();
    // The window never exceeds `TAIL_BYTES`, so this cast cannot truncate.
    let length = size.min(TAIL_BYTES as u64) as usize;
    read_window(file, size - length as u64, length)
}

#[cfg(test)]
mod tests {
    use super::SessionColdStatus::*;
    use super::*;
    use crate::services::session_index::fixtures::{message, message_with_times};

    /// The tail window always starts mid-line, so a dummy fragment precedes every sample.
    fn facts_of(entry: &str) -> TailFacts {
        let window = format!("fragment\n{entry}\n");
        tail_facts(window.as_bytes())
    }

    /// The status that window states; the moment it dates is [`facts_of`]'s other half.
    fn status_of(entry: &str) -> SessionColdStatus {
        facts_of(entry).status
    }

    #[test]
    fn tail_facts_map_roles_and_stop_reasons() {
        assert_eq!(status_of(&message("user", None)), Pending);
        assert_eq!(status_of(&message("toolResult", None)), Pending);
        assert_eq!(status_of(&message("assistant", Some("stop"))), Complete);
        assert_eq!(status_of(&message("assistant", Some("length"))), Complete);
        assert_eq!(status_of(&message("assistant", Some("aborted"))), Aborted);
        assert_eq!(status_of(&message("assistant", Some("error"))), Error);
        assert_eq!(status_of(&message("assistant", Some("toolUse"))), Pending);
        assert_eq!(status_of(&message("assistant", None)), Unknown);
        assert_eq!(status_of("{\"type\":\"session\",\"id\":\"x\"}"), Unknown);
    }

    #[test]
    fn tail_facts_drop_the_first_segment_and_prefer_the_newest_message() {
        // The only line in the window is the fragment, so nothing usable is left to read.
        let single = format!("{}\n", message_with_times("user", None, Some("1000"), None));
        let facts = tail_facts(single.as_bytes());
        assert_eq!(facts.status, Unknown);
        assert_eq!(facts.last_message_at, None, "and nothing usable to date");
        // A newer entry of another type must not hide the newest message.
        let window = format!("fragment\n{}\n{{}}\n", message("assistant", Some("stop")));
        assert_eq!(tail_facts(window.as_bytes()).status, Complete);
    }

    /// The newest message decides both facts at once: the status comes from the entry whose stamp
    /// the summary is timed by, never from one message and the time of another.
    #[test]
    fn tail_facts_take_both_facts_from_the_newest_message() {
        let window = format!(
            "fragment\n{}\n{}\n",
            message_with_times("assistant", Some("stop"), Some("1000"), None),
            message_with_times("user", None, Some("2000"), None)
        );
        let facts = tail_facts(window.as_bytes());
        assert_eq!(facts.status, Pending);
        assert_eq!(facts.last_message_at, Some(2000));
    }

    /// An assistant turn carries two stamps - when it started writing and when it was finished -
    /// and the completion is the moment the conversation last moved.
    #[test]
    fn tail_facts_prefer_the_completion_of_a_turn_to_its_start() {
        let facts = facts_of(&message_with_times(
            "assistant",
            Some("stop"),
            Some("1000"),
            Some("2000"),
        ));
        assert_eq!(
            facts.status, Complete,
            "the same entry still states the status"
        );
        assert_eq!(facts.last_message_at, Some(2000));
    }

    /// The engine appends entries of its own after a turn - a thinking-level change, a `custom`
    /// note, the exit of the session - and some of them can be unreadable; what the user and the
    /// agent last wrote is still the newest message.
    #[test]
    fn tail_facts_read_past_the_engines_own_entries() {
        let facts = facts_of(&format!(
            "{}\n{{\"type\":\"thinking_level_change\",\"level\":\"high\"}}\n{{not json\n\
             {{\"type\":\"custom\",\"customType\":\"session_exit\",\"data\":\
             {{\"reason\":\"dispose\",\"kind\":\"normal\"}}}}",
            message_with_times("assistant", Some("stop"), Some("1000"), None)
        ));
        assert_eq!(facts.status, Complete);
        assert_eq!(facts.last_message_at, Some(1000));
    }

    /// A stamp the reader cannot take as a time is no time at all: the engine writes `0` where it
    /// has nothing, and a row timed by the Unix epoch would be a fabrication. A turn whose
    /// completion says nothing still has its own start to answer with.
    #[test]
    fn tail_facts_refuse_a_stamp_that_is_no_time() {
        for stamp in ["0", "-5", "\"1000\"", "null"] {
            let entry = message_with_times("assistant", Some("stop"), Some(stamp), None);
            assert_eq!(
                facts_of(&entry).last_message_at,
                None,
                "`{stamp}` is no stamp"
            );
        }
        assert_eq!(
            facts_of(&message("assistant", Some("stop"))).last_message_at,
            None,
            "a message without a stamp dates nothing"
        );
        assert_eq!(
            facts_of(&message_with_times(
                "assistant",
                Some("stop"),
                Some("1000"),
                Some("0")
            ))
            .last_message_at,
            Some(1000),
            "a completion the engine left empty falls back to the turn's own start"
        );
    }

    /// A window that holds no message states neither fact: the status is unknown, and the caller
    /// keeps the file's own time because the transcript offers none.
    #[test]
    fn tail_facts_without_a_message_are_empty() {
        let window = concat!(
            "fragment\n",
            "{\"type\":\"custom\",\"value\":1}\n",
            "{\"type\":\"custom\",\"customType\":\"session_exit\",\"data\":\
             {\"reason\":\"dispose\",\"kind\":\"normal\"}}\n",
        );
        let facts = tail_facts(window.as_bytes());
        assert_eq!(facts.status, Unknown);
        assert_eq!(facts.last_message_at, None);
    }

    /// [`child_status`] over the same shape [`facts_of`] reads: a subagent's window.
    fn child_status_of(entries: &str) -> SessionColdStatus {
        let window = format!("fragment\n{entries}\n");
        child_status(window.as_bytes())
    }

    /// The engine's own session-exit marker, in the shape the engine actually writes it.
    ///
    /// The kind lives in `customType` of a `custom` entry, because the marker is the engine's own
    /// bookkeeping rather than a message - the spelling the SDK's own reader pins down (a `custom`
    /// record whose `customType` is `session_exit` and whose `data.kind` is one of
    /// `normal`/`signal`/`fatal`/`process_exit`). A fixture with a top-level `type` of
    /// `session_exit` matches no record any transcript has ever held, so it proves nothing about
    /// the reader.
    fn session_exit(kind: &str) -> String {
        format!(
            "{{\"type\":\"custom\",\"customType\":\"session_exit\",\"data\":\
             {{\"reason\":\"uncaught_exception\",\"kind\":\"{kind}\"}}}}"
        )
    }

    /// The endings a subagent's row is read by, which are the endings a listed row must not take as
    /// one: a stopped child's transcript closes on a record the session's own tail never holds, and
    /// the tail of a completed child is a tool result - the last thing it wrote before handing its
    /// result over - which a listed session reads as work still owed.
    #[test]
    fn child_status_reads_the_endings_a_turn_alone_does_not_state() {
        // A child still inside its turn: an unanswered tool result is outstanding work, exactly as
        // it is for a listed session, because nothing in the window says the child ended.
        let working = child_status_of(&format!("{}\n", message("assistant", Some("toolUse"))));
        assert_eq!(working, Pending, "a turn that never closed is still open");
        assert_eq!(
            child_status_of(&message("toolResult", None)),
            Pending,
            "and a result nobody answered is work owed, as for a listed row"
        );
        // A session that exited after its last message: the exit is an ending the newest message
        // cannot state, and this is the tail a listed row would answer `pending` for. The killed
        // child is this shape exactly - a fatal exit recorded with the tool result still pending.
        let exited = format!(
            "{}\n{}\n",
            message("toolResult", None),
            session_exit("fatal")
        );
        assert_eq!(child_status_of(&exited), Aborted, "{exited}");
        // The exit outranks the turn's own stop reason: whatever the turn said, the session is over.
        let exited_in_error = format!(
            "{}\n{}\n",
            message("assistant", Some("error")),
            session_exit("normal")
        );
        assert_eq!(child_status_of(&exited_in_error), Aborted, "exit first");
        // A child that died before writing anything else: the exit is the only record there is.
        assert_eq!(
            child_status_of(&session_exit("fatal")),
            Aborted,
            "exit alone"
        );
        // A bookkeeping record that is not the exit says nothing about ending: the turn it follows
        // is still open, exactly as it is for a listed session.
        assert_eq!(
            child_status_of(&format!(
                "{}\n{{\"type\":\"custom\",\"customType\":\"thinking_level_change\",\
                 \"data\":{{\"thinkingLevel\":\"high\"}}}}",
                message("toolResult", None)
            )),
            Pending,
            "another kind of note is not an ending"
        );
        // A turn the stop aborted, whether or not the engine wrote more after it.
        assert_eq!(
            child_status_of(&message("assistant", Some("aborted"))),
            Aborted
        );
        assert_eq!(
            child_status_of(&format!(
                "{}\n{{\"type\":\"custom\",\"kind\":\"normal\"}}",
                message("assistant", Some("aborted"))
            )),
            Aborted,
            "a newer note does not hide the turn that ended the child"
        );
    }

    /// Everything else a child's window can state is read by the same table a listed row's is - the
    /// stop reasons of an assistant turn, and `unknown` where the window states nothing at all.
    #[test]
    fn child_status_falls_back_to_the_reading_every_session_has() {
        assert_eq!(child_status_of(&message("assistant", Some("error"))), Error);
        assert_eq!(
            child_status_of(&message("assistant", Some("stop"))),
            Complete
        );
        assert_eq!(
            child_status_of(&message("assistant", Some("length"))),
            Complete
        );
        assert_eq!(child_status_of(&message("assistant", None)), Unknown);
        // Only the fragment - the window started mid-line - or entries that say nothing about
        // ending: nothing readable is left, and a child is not guessed at.
        let nothing = "{\"type\":\"custom\",\"value\":1}\n";
        assert_eq!(child_status(nothing.as_bytes()), Unknown);
        assert_eq!(
            child_status(format!("{}\n", message("user", None)).as_bytes()),
            Unknown,
            "the first segment of a window is a fragment, never a record"
        );
    }
}
