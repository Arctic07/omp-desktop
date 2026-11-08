//! Bridge tests: envelope
//!
//! Split from the module harness (`super`) by theme so no file in this tree grows past the
//! engineering limit (`rules.md#single-file-line-limit`). Every helper the tests use lives in `super`.

use super::*;

#[test]
fn a_page_without_the_permission_is_denied_before_anything_is_resolved() {
    let (_package, page) = package();
    let mut effects = Nobody::default();
    let served = page_with(&page, &[], &["docs/**"]);
    assert_eq!(
        refusal(answer(
            &served,
            &test_roots(&served),
            &read("docs/readme.md"),
            &mut effects
        )),
        PERMISSION_DENIED
    );
    assert!(
        effects.asked.is_empty(),
        "a missing permission is not a question for the user"
    );
}

#[test]
fn only_a_served_method_is_a_call_at_all() {
    let (_package, page) = package();
    let mut effects = Nobody::default();
    assert_eq!(
        answer(
            &page,
            &test_roots(&page),
            &BridgeCall::Query("m=nope".to_owned()),
            &mut effects
        ),
        Err(RefusalOrRequest::Request)
    );
    assert_eq!(
        answer(
            &page,
            &test_roots(&page),
            &BridgeCall::Body(b"{ not json".to_vec()),
            &mut effects
        ),
        Err(RefusalOrRequest::Request)
    );
    assert_eq!(
        answer(
            &page,
            &test_roots(&page),
            &BridgeCall::Query("m=fs.read".to_owned()),
            &mut effects
        ),
        Err(RefusalOrRequest::Refused(INVALID_REQUEST)),
        "a method with parameters may not arrive through a query"
    );
    assert_eq!(
        answer(
            &page,
            &test_roots(&page),
            &BridgeCall::Query("m=ready".to_owned()),
            &mut effects
        ),
        Ok(json!({ "ok": true }))
    );
    let too_big = BridgeCall::Body(vec![b' '; MAX_BRIDGE_BODY_BYTES + 1]);
    assert_eq!(
        answer(&page, &test_roots(&page), &too_big, &mut effects),
        Err(RefusalOrRequest::Refused(TOO_LARGE))
    );
}

#[test]
fn a_body_may_spell_the_method_field_out() {
    let (_package, page) = package();
    let mut effects = Nobody::default();
    let body =
        serde_json::to_vec(&json!({ "method": "fs.read", "params": { "path": "docs/readme.md" } }))
            .expect("a body");
    assert!(answer(
        &page,
        &test_roots(&page),
        &BridgeCall::Body(body),
        &mut effects
    )
    .is_ok());
}

/// The method one query string names is read the way a query string is read anywhere else: the
/// first `m`/`method` pair wins, and the value is percent-decoded so an encoded dot still names
/// the method the page meant.
#[test]
fn a_query_names_one_method_or_none() {
    assert_eq!(method_of_query("m=ready").as_deref(), Some("ready"));
    assert_eq!(method_of_query("method=close").as_deref(), Some("close"));
    assert_eq!(
        method_of_query("x=1&m=ready&m=close").as_deref(),
        Some("ready")
    );
    assert_eq!(method_of_query("m=fs%2Eread").as_deref(), Some("fs.read"));
    assert_eq!(method_of_query("m=").as_deref(), Some(""));
    assert_eq!(method_of_query("other=ready"), None);
    assert_eq!(method_of_query(""), None);
}

/// `plugin.dataDir` carries no permission, and it is a `GET`: an installation that declares nothing
/// at all still gets the one directory this application made for it, because the call reaches into
/// this application's own storage rather than out of it.
#[test]
fn the_data_directory_answers_without_a_permission() {
    let (_package, page) = package();
    let bare = page_with(&page, &[], &[]);
    let mut effects = Nobody::default();
    let served = answer(
        &bare,
        &test_roots(&bare),
        &BridgeCall::Query("m=plugin.dataDir".to_owned()),
        &mut effects,
    )
    .expect("served without a permission");
    assert_eq!(
        served["result"]["path"],
        json!("/tmp/plugin-data/smoke-plugin")
    );

    // A near miss is not the method, and a name this build does not serve is not a call at all.
    assert_eq!(
        answer(
            &bare,
            &test_roots(&bare),
            &BridgeCall::Query("m=plugin.dataDir/".to_owned()),
            &mut effects
        ),
        Err(RefusalOrRequest::Request)
    );
}
