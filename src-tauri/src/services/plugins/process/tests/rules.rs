use super::*;

// ---- the rules ----

/// The availability matrix is the plan's (§6.1, D3): a verified built-in needs no manifest name, a
/// package that merely *spells* a built-in id without the verification is refused, and everything
/// else needs the declaration **and** the confirmation.
#[test]
fn a_process_is_available_by_the_built_in_and_grant_rules() {
    assert_eq!(availability(true, "omp.terminal", false, false), Ok(()));
    assert_eq!(
        availability(false, "omp.terminal", true, true),
        Err(UNAVAILABLE_BUILTIN_UNVERIFIED),
        "a package can spell the reserved id; only the marketplace check is evidence"
    );
    assert_eq!(
        availability(false, "demo", false, true),
        Err(UNAVAILABLE_PERMISSION_MISSING)
    );
    assert_eq!(
        availability(false, "demo", true, false),
        Err(UNAVAILABLE_PERMISSION_MISSING),
        "the declaration without the user's answer is not enough"
    );
    assert_eq!(availability(false, "demo", true, true), Ok(()));
}

/// The same rules through a real row: the descriptor exists only when the process may run, and the
/// declaration is read from the block this side re-checked.
#[test]
fn a_descriptor_exists_only_for_an_installation_that_may_run() {
    let granted = row("demo", false, &["plugin.process"]);
    let checked = recheck_desktop(&granted);
    assert!(
        install_of(&granted, checked.as_ref(), true, None).is_some(),
        "declared and confirmed"
    );
    assert!(
        install_of(&granted, checked.as_ref(), false, None).is_none(),
        "declared but not confirmed"
    );

    let undeclared = row("demo", false, &[]);
    let checked = recheck_desktop(&undeclared);
    assert!(install_of(&undeclared, checked.as_ref(), true, None).is_none());

    let builtin = row("omp.terminal", true, &[]);
    let checked = recheck_desktop(&builtin);
    assert!(
        install_of(&builtin, checked.as_ref(), false, None).is_some(),
        "a verified built-in needs no name for it"
    );

    let impostor = row("omp.terminal", false, &["plugin.process"]);
    let checked = recheck_desktop(&impostor);
    assert!(
        install_of(&impostor, checked.as_ref(), true, None).is_none(),
        "the reserved id without the verification"
    );
}
