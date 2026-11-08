//! What a reopened conversation makes of the one injected developer message it draws.
//!
//! Kept beside `history.rs` rather than inside it: that file is over the line bound and may only
//! shrink (`scripts/file-size-allowlist.json`), and the crate's convention for that is a sibling
//! `*_tests.rs` module (`content_image_tests.rs`, `intent_tests.rs`).

use serde_json::json;

use super::history::normalize_messages;
use crate::models::agent::ChatMessage;

/// The rule check reads back as the row the live frame drew; the rest of what the engine injects as
/// a developer message stays out of the transcript.
#[test]
fn a_reopened_conversation_shows_the_rule_checks_it_drew_live() {
    let messages = normalize_messages(&[
        json!({
            "role": "developer",
            "timestamp": 1_789_627_445_400i64,
            "content": [{
                "type": "text",
                "text": "<system-reminder reason=\"rule_violation\" rule=\"ts-no-any\" path=\"builtin-defaults:ts-no-any.md\">\nUser-defined rule matched tool-call arguments.\n</system-reminder>",
            }],
        }),
        json!({
            "role": "developer",
            "timestamp": 1_789_627_445_401i64,
            "content": "<system-reminder>\nEval runtime state is host-retained.\n</system-reminder>",
        }),
        json!({
            "role": "assistant",
            "timestamp": 1_789_627_445_402i64,
            "content": [{"type": "text", "text": "fixed"}],
        }),
    ]);

    assert_eq!(messages.len(), 2, "the eval registry is not a row");
    match &messages[0] {
        ChatMessage::Reminder { at, text, .. } => {
            assert_eq!(*at, 1_789_627_445_400);
            assert!(text.contains("rule=\"ts-no-any\""));
            assert!(text.contains("User-defined rule matched"));
        }
        other => panic!("expected a reminder row, got {other:?}"),
    }
    assert!(matches!(messages[1], ChatMessage::Assistant { .. }));
}
