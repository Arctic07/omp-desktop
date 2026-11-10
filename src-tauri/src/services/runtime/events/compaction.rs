//! What one compaction end says on the notice path.
//!
//! Split out of `events.rs` the way the projector already split `deltas` / `frames`: the rule is a
//! pure function of the event and the line budget of the projector file is pinned
//! (`rules.md#single-file-line-limit`, `scripts/file-size-allowlist.json`).

use serde_json::{json, Value};

use crate::services::runtime::sanitize_message;

/// What one compaction end amounts to, once the event's flags are read in the engine's precedence.
#[derive(Debug, PartialEq, Eq)]
enum Ending {
    /// Nothing to state: the pass changed nothing and no reader is waiting on an explanation here.
    ///
    /// A manual pass that failed lands here: `/compact` prints `Compaction failed: …` into the
    /// conversation, where the reader is looking (`host/src/slash.ts::commandReportCode` routes it to
    /// a transcript row), and a second copy above the field would be the same sentence twice.
    Unstated,
    /// A pass the reader did not start that failed, with the engine's own reason.
    Failed(String),
    /// The pass was cancelled.
    Stopped,
    /// The context was rewritten.
    Compacted,
    /// The engine left the context as it was.
    Skipped,
}

/// The notice one compaction end puts up, or `None` when nothing is left to state.
///
/// Read from the event alone, so the precedence is testable without an app handle.
pub(crate) fn compaction_end_notice(event_type: &str, event: &Value) -> Option<Value> {
    match ending(event_type, event) {
        Ending::Unstated => None,
        Ending::Failed(reason) => Some(json!({
            "type": "notice",
            "level": "warning",
            "message": sanitize_message(&reason),
        })),
        Ending::Stopped => Some(json!({
            "type": "notice",
            "level": "info",
            "code": "engine_compaction_stopped",
            "message": "The engine stopped compacting the context.",
        })),
        Ending::Compacted => Some(json!({
            "type": "notice",
            "level": "info",
            "code": "engine_compacted",
            "message": "The engine compacted the context.",
        })),
        Ending::Skipped => Some(json!({
            "type": "notice",
            "level": "info",
            "code": "engine_compaction_skipped",
            "message": "The engine left the context as it was.",
        })),
    }
}

/// The one ordered derivation, in the engine's own precedence.
///
/// A cancellation is one even when the abort also carried a sentence, and `skipped` qualifies an
/// error before anything else: the shake method reclaims tokens without producing a
/// `CompactionResult`, so an error beside `skipped: true` is "nothing to do", not a failed pass. A
/// pass that failed may still say the context was rewritten (`skipped: false`); that does not make
/// it a success, which is why the failure is read before the rewrite.
fn ending(event_type: &str, event: &Value) -> Ending {
    let aborted = event.get("aborted").and_then(Value::as_bool) == Some(true);
    let skipped = event.get("skipped").and_then(Value::as_bool);
    let failure = event
        .get("errorMessage")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .filter(|_| skipped != Some(true));

    if aborted {
        return Ending::Stopped;
    }
    if let Some(reason) = failure {
        return if event_type == "auto_compaction_end" {
            Ending::Failed(reason.to_string())
        } else {
            Ending::Unstated
        };
    }
    if event.get("result").is_some_and(|result| !result.is_null()) || skipped == Some(false) {
        return Ending::Compacted;
    }
    if skipped == Some(true) {
        return Ending::Skipped;
    }
    Ending::Unstated
}
