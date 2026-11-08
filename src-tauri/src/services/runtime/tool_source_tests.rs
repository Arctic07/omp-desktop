use serde_json::json;

use super::*;

/// A search result's sources are the citations under its row: title, url and snippet as the
/// engine reported them, with an entry nothing could open left out and the list capped.
#[test]
fn a_search_response_projects_its_sources() {
    let details = json!({
        "response": {
            "sources": [
                { "title": "Rust", "url": "https://rust-lang.org", "snippet": "the language" },
                { "title": "a page with no url at all" },
                { "url": "https://example.com" },
                "not an entry",
            ],
        },
    });
    let sources = tool_sources(Some(&details));
    assert_eq!(sources.len(), 2, "a source without a url is not a citation");
    assert_eq!(sources[0].title, "Rust");
    assert_eq!(sources[0].url, "https://rust-lang.org");
    assert_eq!(sources[0].snippet, "the language");
    // A citation the engine titled nothing is still one: the row draws its url.
    assert_eq!(sources[1].title, "");
    assert_eq!(sources[1].url, "https://example.com");
    assert_eq!(sources[1].snippet, "");

    let many = json!({
        "response": {
            "sources": (0..MAX_TOOL_SOURCES + 2)
                .map(|index| json!({ "url": format!("https://example.com/{index}") }))
                .collect::<Vec<_>>(),
        },
    });
    assert_eq!(tool_sources(Some(&many)).len(), MAX_TOOL_SOURCES);

    // A result that is not a search names no sources, and says so by saying nothing.
    assert!(tool_sources(Some(&json!({ "path": "src/main.ts" }))).is_empty());
    assert!(tool_sources(None).is_empty());
}

/// The citations ride with the row's structured half, so a search that reported sources has a
/// `details` to draw and one that reported none still has none.
#[test]
fn sources_ride_with_the_tool_details() {
    let details = json!({ "response": { "sources": [{ "url": "https://example.com" }] } });
    let projected = tool_details(Some(&details)).expect("a search reports its sources");
    assert_eq!(projected.sources.len(), 1);
    assert_eq!(projected.sources[0].url, "https://example.com");
    assert!(
        projected.answer.is_none(),
        "a pure search engine writes no answer"
    );
    assert!(tool_details(Some(&json!({ "response": {} }))).is_none());
}

/// A provider that writes an answer has it drawn on the row, trimmed and bounded, and a search with
/// nothing but that answer still has a `details` to draw.
#[test]
fn a_search_answer_projects_with_the_sources() {
    let details = json!({
        "response": {
            "answer": "  Rust is a systems language.\n",
            "sources": [{ "url": "https://rust-lang.org" }],
        },
    });
    let answer = tool_answer(Some(&details)).expect("the answer is prose the row draws");
    assert_eq!(answer, "Rust is a systems language.", "it is trimmed");
    let projected = tool_details(Some(&details)).expect("an answer alone is worth a row");
    assert_eq!(
        projected.answer.as_deref(),
        Some("Rust is a systems language.")
    );

    // An answer with no source at all (a grounded provider that cited nothing) is still a row.
    assert!(tool_details(Some(&json!({ "response": { "answer": "only words" } }))).is_some());

    // Whitespace is not an answer: a heading over nothing is worse than no heading.
    assert!(tool_answer(Some(&json!({ "response": { "answer": "   " } }))).is_none());
    assert!(tool_answer(Some(&json!({ "response": {} }))).is_none());
    assert!(tool_answer(None).is_none());

    // Bounded: the provider's prose is clamped rather than carried whole.
    let long = json!({ "response": { "answer": "a".repeat(MAX_SEARCH_ANSWER_CHARS + 40) } });
    let clamped = tool_answer(Some(&long)).expect("a long answer is still an answer");
    assert_eq!(clamped.chars().count(), MAX_SEARCH_ANSWER_CHARS);
    assert!(clamped.ends_with('…'));
}
