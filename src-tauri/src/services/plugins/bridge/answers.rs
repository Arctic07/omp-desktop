//! What the user's answer to a question means: the refusal a `deny` produces and the grant an
//! `allow` records.
//!
//! Split from the file gates (`files.rs`) because neither half is a file fact: a clipboard question
//! and a completion question are answered by the same two functions, and only the three file kinds
//! have a path to resolve along with the grant. `bridge.rs`'s own `answer` is the only caller.

use super::files::resolve_file;
use super::*;

/// The refusal the user's `deny` becomes, per the kind of question that was asked.
///
/// A read that was not allowed is an *out-of-scope* answer - the reach was never declared - while a
/// clipboard question the user refused is a permission answer, because the permission is the switch
/// and the first-use question is about when it turns on. The two codes are what a page branches on,
/// so they name what actually happened rather than one generic refusal.
pub(super) fn refusal_for(kind: PromptKind) -> Refusal {
    match kind {
        // A file the plugin may not touch is an *out-of-scope* answer, in all three modes: the reach
        // was never declared.
        PromptKind::ReadOutOfScope | PromptKind::WriteOutOfScope | PromptKind::DeleteOutOfScope => {
            OUT_OF_SCOPE
        }
        PromptKind::ClipboardRead | PromptKind::ClipboardWrite | PromptKind::AgentComplete => {
            PERMISSION_REFUSED_BY_USER
        }
    }
}

/// Records the session grant one `session` answer stands for.
///
/// The grant names the file the user was shown, resolved the way the gate resolved it — through the
/// same `resolve_file`, so a session grant cannot record a path the gate would never have reached. A
/// grant for a path that could not be resolved is a grant for nothing, which is why each arm ignores
/// the resolution's failure rather than storing the display string.
pub(super) fn remember_session(
    kind: PromptKind,
    job: &Job,
    roots: &gates::FsRoots,
    unrestricted: bool,
    effects: &mut dyn BridgeEffects,
) {
    match (kind, job) {
        (PromptKind::ReadOutOfScope, Job::Read { display }) => {
            if let Ok(path) = resolve_file(roots, display, gates::FsMode::Read, unrestricted) {
                effects.remember(SessionGrant::Read(path.to_string_lossy().into_owned()));
            }
        }
        // Every read-shaped gate asks the *same* question (`files::read_reach`), so every one of them
        // records the same grant when the user answers "this session": a stat, a listing and the two
        // openers share the read gate's reach, and the arm that recorded only a plain read would leave
        // the user answering the same question again on the next call. Each arm resolves the way its
        // own gate resolved, because the grant a later call looks for is that exact path.
        (PromptKind::ReadOutOfScope, Job::Stat { display })
        | (PromptKind::ReadOutOfScope, Job::List { display })
        | (PromptKind::ReadOutOfScope, Job::OpenDefault { display })
        | (PromptKind::ReadOutOfScope, Job::Reveal { display }) => {
            if let Ok(path) = resolve_file(roots, display, gates::FsMode::Inspect, unrestricted) {
                effects.remember(SessionGrant::Read(path.to_string_lossy().into_owned()));
            }
        }
        (PromptKind::ReadOutOfScope, Job::ReadRange { display, .. }) => {
            if let Ok(path) = resolve_file(roots, display, gates::FsMode::Read, unrestricted) {
                effects.remember(SessionGrant::Read(path.to_string_lossy().into_owned()));
            }
        }
        (PromptKind::ReadOutOfScope, Job::Glob { plan, .. }) => {
            if let Ok(base) = super::files::resolve_glob_base(roots, plan, unrestricted) {
                effects.remember(SessionGrant::Read(base.to_string_lossy().into_owned()));
            }
        }
        (PromptKind::WriteOutOfScope, Job::Write { display, .. }) => {
            if let Ok(path) = resolve_file(roots, display, gates::FsMode::Write, unrestricted) {
                effects.remember(SessionGrant::Write(path.to_string_lossy().into_owned()));
            }
        }
        (PromptKind::DeleteOutOfScope, Job::Delete { display }) => {
            if let Ok(path) = resolve_file(roots, display, gates::FsMode::Delete, unrestricted) {
                effects.remember(SessionGrant::Delete(path.to_string_lossy().into_owned()));
            }
        }
        (PromptKind::ClipboardRead, _) => effects.remember(SessionGrant::Clipboard("read")),
        (PromptKind::ClipboardWrite, _) => effects.remember(SessionGrant::Clipboard("write")),
        // A completion is one capability: the answer is about spending the user's money on this
        // application's models, so it covers every later call of this session.
        (PromptKind::AgentComplete, _) => effects.remember(SessionGrant::AgentComplete),
        (PromptKind::ReadOutOfScope, _)
        | (PromptKind::WriteOutOfScope, _)
        | (PromptKind::DeleteOutOfScope, _) => {}
    }
}
