use serde_json::json;

use super::*;

/// The regression this covers: a tool row's only words are this line for every call whose
/// arguments name nothing the row's presentation knows (`todo`, `hub`, a `task` spawn), so an
/// absent or blank value must read as "the engine said nothing" - never as a `""` a row would
/// draw as its own text.
#[test]
fn an_absent_or_blank_intent_states_nothing() {
    let nothing = [json!(null), json!(7), json!(""), json!("   ")];
    assert!(intent_text(None).is_none());
    assert!(intent_text(Some(&json!({}))).is_none());
    for value in &nothing {
        assert!(intent_text(Some(value)).is_none(), "{value}");
    }
    assert_eq!(
        intent_text(Some(&json!(" 继续等待后端架构报告 "))).as_deref(),
        Some("继续等待后端架构报告")
    );
}

/// Engine text like every other string on the wire: redacted here and bounded here, once, so
/// the cold read and the live frame cannot disagree about either.
#[test]
fn an_intent_is_redacted_and_bounded_once() {
    assert_eq!(
        intent_text(Some(&json!("reading sk-ant-api03-AAAbbbCCC111222333"))).as_deref(),
        Some("reading <redacted>")
    );
    let long = intent_text(Some(&json!("x".repeat(MAX_TEXT_CHARS + 1)))).expect("a long intent");
    assert!(long.ends_with("…(truncated)"), "{long}");
    assert!(long.chars().count() <= MAX_TEXT_CHARS + "\n…(truncated)".chars().count());
}
