//! The bridge's file-mode gates: the four-step order, in one place.
//!
//! Split from `bridge.rs` by theme (`rules.md#single-file-line-limit`), and the split is the one the
//! module's own header describes: every method that names a *path* - a read, a stat, a list, a glob,
//! a byte range, the two openers, a write, a delete - passes the same gate, in the same order
//! (permission, containment, reject table, declared scope), and the sharing is expressed here as one
//! `read_reach` plus one `resolve_file` rather than as nine copies that could drift. `bridge.rs`
//! keeps the vocabulary, the judgement table and the judgement entry point; this file is what those
//! entries decide.

use std::path::{Path, PathBuf};

use base64::Engine;

use crate::services::plugins::gates::ReadRefusal;

use super::*;

/// The file one file-mode call names: the installation's own roots, or - when it declared
/// `fs.anyPath` - any path the user account can reach (`gates::resolve_any`).
///
/// One function so the three gates cannot disagree about which resolver runs, and so the refusal
/// codes stay the same either way: an unrestricted call is still told `NotFound` for a file that is
/// not there and `invalid_request` for a name no path can be. `unrestricted` is the caller's reading
/// of the one widening this build serves, passed in rather than re-read here, so the decision to run
/// without a question and the decision about which resolver runs are the *same* fact. The base a
/// *relative* name resolves against is the installation's own package, which is the one directory a
/// plugin can name without knowing where it was installed.
pub(super) fn resolve_file(
    roots: &gates::FsRoots,
    requested: &str,
    mode: gates::FsMode,
    unrestricted: bool,
) -> Result<PathBuf, ReadRefusal> {
    if unrestricted {
        gates::resolve_any(&roots.plugin, requested, mode)
    } else {
        roots.resolve(requested, mode)
    }
}

/// One `ReadRefusal` as the refusal a page reads.
///
/// One function rather than the same three-arm match in every path-shaped gate: the token a page
/// branches on has to be the same whichever call produced it, and the performer's own mapping
/// (`perform`'s `map_err`) is this one - a second copy of it is a second place for the two to drift.
pub(super) fn refusal_of(refusal: ReadRefusal) -> Refusal {
    match refusal {
        ReadRefusal::Relative => INVALID_REQUEST,
        ReadRefusal::NotFound => NOT_FOUND,
        ReadRefusal::DeniedByPolicy => DENIED_BY_POLICY,
    }
}

/// [`resolve_file`] as a judgement: the path the gate may act on, or the refusal it answers with.
fn resolved_file(
    roots: &gates::FsRoots,
    requested: &str,
    mode: gates::FsMode,
    unrestricted: bool,
) -> Result<PathBuf, Judgement> {
    resolve_file(roots, requested, mode, unrestricted)
        .map_err(|refusal| Judgement::Refuse(refusal_of(refusal)))
}

/// The write gate: the read gate's four steps, with a target that may not exist yet.
///
/// The one difference is which resolver runs - a write names a file that is not there yet - and the
/// one addition is the mode's own scope: `fs.write.scope` may not name a whole tree (the manifest
/// layer refuses that), so a write that is not inside a declared directory is the user's question.
pub(super) fn judge_write(
    page: &PluginPage,
    roots: &gates::FsRoots,
    params: Option<&Value>,
    holds: &dyn Fn(&SessionGrant) -> bool,
) -> Judgement {
    if !page.grants.declares("fs.write") {
        return Judgement::Refuse(PERMISSION_DENIED);
    }
    // The same single reading as the read gate: one fact, used by the resolver and by the question.
    let unrestricted = page.grants.declares("fs.anyPath");
    let Some(params) = params else {
        return Judgement::Refuse(INVALID_REQUEST);
    };
    let Some(path) = params.get("path").and_then(Value::as_str) else {
        return Judgement::Refuse(INVALID_REQUEST);
    };
    let Some(text) = params.get("text").and_then(Value::as_str) else {
        return Judgement::Refuse(INVALID_REQUEST);
    };
    let path = path.trim();
    if path.is_empty() || path.chars().count() > MAX_FS_PATH_CHARS {
        return Judgement::Refuse(INVALID_REQUEST);
    }
    let bytes = match read_bytes(text, params.get("encoding").and_then(Value::as_str)) {
        Ok(text) => text,
        Err(refusal) => return Judgement::Refuse(refusal),
    };
    let resolved = match resolved_file(roots, path, gates::FsMode::Write, unrestricted) {
        Ok(resolved) => resolved,
        Err(judgement) => return judgement,
    };
    let job = Job::Write {
        display: path.to_owned(),
        bytes,
    };
    // The write half of the same answer: no scope, no question, the declared permission runs it.
    if unrestricted {
        return Judgement::Run(job);
    }
    let in_scope = page
        .grants
        .fs_scopes
        .write
        .iter()
        .any(|pattern| gates::scope_matches(pattern, path));
    if in_scope {
        return Judgement::Run(job);
    }
    let grant = SessionGrant::Write(resolved.to_string_lossy().into_owned());
    if holds(&grant) {
        return Judgement::Run(job);
    }
    Judgement::Ask {
        kind: PromptKind::WriteOutOfScope,
        target: path.to_owned(),
        job,
    }
}

/// The delete gate: the read gate's steps, and then the brake.
///
/// A delete names a file that is there (the same resolver the read gate uses, so the reject table and
/// the containment check are the same checks), and the mode has its own scope and its own question.
/// The brake is the one thing a delete has that no other mode does: a series of them is answered as a
/// series, which is what `gates::DeleteBudget` counts.
pub(super) fn judge_delete(
    page: &PluginPage,
    roots: &gates::FsRoots,
    params: Option<&Value>,
    holds: &dyn Fn(&SessionGrant) -> bool,
) -> Judgement {
    if !page.grants.declares("fs.delete") {
        return Judgement::Refuse(PERMISSION_DENIED);
    }
    let unrestricted = page.grants.declares("fs.anyPath");
    let Some(path) = params
        .and_then(|params| params.get("path"))
        .and_then(Value::as_str)
    else {
        return Judgement::Refuse(INVALID_REQUEST);
    };
    let path = path.trim();
    if path.is_empty() || path.chars().count() > MAX_FS_PATH_CHARS {
        return Judgement::Refuse(INVALID_REQUEST);
    }
    let resolved = match resolved_file(roots, path, gates::FsMode::Delete, unrestricted) {
        Ok(resolved) => resolved,
        Err(judgement) => return judgement,
    };
    let job = Job::Delete {
        display: path.to_owned(),
    };
    // The delete brake is still this side's (`BridgeEffects::take_delete`), but the *scope* question
    // is not asked: an installation that declared the whole disk has no narrower range to be inside.
    if unrestricted {
        return Judgement::Run(job);
    }
    let in_scope = page
        .grants
        .fs_scopes
        .delete
        .iter()
        .any(|pattern| gates::scope_matches(pattern, path));
    if in_scope {
        return Judgement::Run(job);
    }
    let grant = SessionGrant::Delete(resolved.to_string_lossy().into_owned());
    if holds(&grant) {
        return Judgement::Run(job);
    }
    Judgement::Ask {
        kind: PromptKind::DeleteOutOfScope,
        target: path.to_owned(),
        job,
    }
}

/// The bytes one write carries: the text as UTF-8, or the bytes a base64 string spells out.
///
/// The two are one function because the bound is one: a write carries *bytes* either way, and what a
/// page can put in a file is capped by them rather than by the characters it typed. Base64 is decoded
/// here so a plugin can write what a string cannot hold; a plugin with text passes text.
pub(super) fn read_bytes(text: &str, encoding: Option<&str>) -> Result<Vec<u8>, Refusal> {
    if text.len() > MAX_WRITE_BYTES {
        return Err(TOO_LARGE);
    }
    match encoding {
        None | Some("utf8") => Ok(text.as_bytes().to_vec()),
        Some("base64") => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(text)
                .map_err(|_| INVALID_REQUEST)?;
            if bytes.len() > MAX_WRITE_BYTES {
                return Err(TOO_LARGE);
            }
            Ok(bytes)
        }
        Some(_) => Err(INVALID_REQUEST),
    }
}

/// The `path` one read-shaped call names: the permission, the shape and the length a read, a stat and
/// a list all share, in the same order and with the same bounds.
///
/// Factored out because the three are one gate: a `fs.read` permission is what makes a path nameable
/// at all, `MAX_FS_PATH_CHARS` is the same bound in all three, and a copy of this per method is a
/// copy that could accept a path the others refuse.
pub(super) fn read_path<'a>(
    page: &PluginPage,
    params: Option<&'a Value>,
) -> Result<&'a str, Refusal> {
    read_path_with(page, params, "fs.read")
}

/// The same shape gate, against the permission the calling method needs.
///
/// `fs.read`, `fs.readRange`, `fs.openDefault` and `fs.reveal` all name a path the same way, and the
/// only difference between them is which permission makes it nameable at all. One function, so the
/// bound and the shape cannot drift apart between four methods.
pub(super) fn read_path_with<'a>(
    page: &PluginPage,
    params: Option<&'a Value>,
    permission: &str,
) -> Result<&'a str, Refusal> {
    if !page.grants.declares(permission) {
        return Err(PERMISSION_DENIED);
    }
    let Some(path) = params
        .and_then(|params| params.get("path"))
        .and_then(Value::as_str)
    else {
        return Err(INVALID_REQUEST);
    };
    let path = path.trim();
    if path.is_empty() || path.chars().count() > MAX_FS_PATH_CHARS {
        return Err(INVALID_REQUEST);
    }
    Ok(path)
}

/// The decision `fs.read`, `fs.stat` and `fs.list` share: resolve, then run, or ask the user.
///
/// All three are reads - the same `fs.read` permission, the same declared `fs.read.scope`, the same
/// session grant and the same question when the path is outside it - so the only parameters are the
/// resolver's mode (an inspection may land on a directory) and the job each one runs. Written once
/// because three copies of this order would be three places for the gate to drift, and the order is
/// the whole rule.
pub(super) fn judge_fs_read(
    page: &PluginPage,
    roots: &gates::FsRoots,
    requested: &str,
    mode: gates::FsMode,
    unrestricted: bool,
    holds: &dyn Fn(&SessionGrant) -> bool,
    job: Job,
) -> Judgement {
    let path = match resolved_file(roots, requested, mode, unrestricted) {
        Ok(path) => path,
        Err(judgement) => return judgement,
    };
    read_reach(page, &path, requested, unrestricted, holds, job)
}

/// The reach half of every read-shaped gate: the standing scope, the session grant, or the question.
///
/// Split from the resolution it follows so a gate whose target is not one path (`fs.glob` resolves a
/// pattern's literal prefix) reaches the *same* decision as the three that name a file. The patterns
/// are compared against the *requested* spelling, not the resolved one: the manifest declares a shape
/// of name, and turning a name into a file is the resolver's job, which has already run. `fs.stat`,
/// `fs.list` and `fs.glob` read the same list, because they are the same reach.
pub(super) fn read_reach(
    page: &PluginPage,
    resolved: &std::path::Path,
    requested: &str,
    unrestricted: bool,
    holds: &dyn Fn(&SessionGrant) -> bool,
    job: Job,
) -> Judgement {
    // An unrestricted installation has no scope to be outside of, so there is no question to ask:
    // the declared permission is the answer, and every path that exists runs.
    if unrestricted {
        return Judgement::Run(job);
    }
    let in_scope = page
        .grants
        .fs_scopes
        .read
        .iter()
        .any(|pattern| gates::scope_matches(pattern, requested));
    if in_scope {
        return Judgement::Run(job);
    }
    let grant = SessionGrant::Read(resolved.to_string_lossy().into_owned());
    if holds(&grant) {
        return Judgement::Run(job);
    }
    Judgement::Ask {
        kind: PromptKind::ReadOutOfScope,
        target: requested.to_owned(),
        job,
    }
}

/// The read gate, in the spec's order (§6.3): permission, containment, reject table, declared scope.
pub(super) fn judge_read(
    page: &PluginPage,
    roots: &gates::FsRoots,
    params: Option<&Value>,
    holds: &dyn Fn(&SessionGrant) -> bool,
) -> Judgement {
    let requested = match read_path(page, params) {
        Ok(path) => path,
        Err(refusal) => return Judgement::Refuse(refusal),
    };
    judge_fs_read(
        page,
        roots,
        requested,
        gates::FsMode::Read,
        page.grants.declares("fs.anyPath"),
        holds,
        Job::Read {
            display: requested.to_owned(),
        },
    )
}

/// The stat gate: the read gate's reach, with a directory as a valid answer.
pub(super) fn judge_stat(
    page: &PluginPage,
    roots: &gates::FsRoots,
    params: Option<&Value>,
    holds: &dyn Fn(&SessionGrant) -> bool,
) -> Judgement {
    let requested = match read_path(page, params) {
        Ok(path) => path,
        Err(refusal) => return Judgement::Refuse(refusal),
    };
    judge_fs_read(
        page,
        roots,
        requested,
        gates::FsMode::Inspect,
        page.grants.declares("fs.anyPath"),
        holds,
        Job::Stat {
            display: requested.to_owned(),
        },
    )
}

/// The list gate: the same reach as a stat, answered with the directory's own entries.
pub(super) fn judge_list(
    page: &PluginPage,
    roots: &gates::FsRoots,
    params: Option<&Value>,
    holds: &dyn Fn(&SessionGrant) -> bool,
) -> Judgement {
    let requested = match read_path(page, params) {
        Ok(path) => path,
        Err(refusal) => return Judgement::Refuse(refusal),
    };
    judge_fs_read(
        page,
        roots,
        requested,
        gates::FsMode::Inspect,
        page.grants.declares("fs.anyPath"),
        holds,
        Job::List {
            display: requested.to_owned(),
        },
    )
}

/// The glob gate: the read gate's reach, answered with every path the pattern names.
///
/// The pattern is the read gate's own language, so the two gates are one: the same `fs.read`
/// permission, the same declared `fs.read.scope` (compared against the pattern as the caller wrote
/// it), the same session grant for the directory the pattern starts in, and the same question when
/// nothing answers. What is new is only that the thing being named is a shape rather than one file,
/// which is why the resolution below is the *prefix's* - a pattern with no literal prefix starts at
/// the root, and every entry the walk finds is checked against the reject table on the way out.
pub(super) fn judge_glob(
    page: &PluginPage,
    roots: &gates::FsRoots,
    params: Option<&Value>,
    holds: &dyn Fn(&SessionGrant) -> bool,
) -> Judgement {
    if !page.grants.declares("fs.read") {
        return Judgement::Refuse(PERMISSION_DENIED);
    }
    let unrestricted = page.grants.declares("fs.anyPath");
    let Some(pattern) = params
        .and_then(|params| params.get("pattern"))
        .and_then(Value::as_str)
    else {
        return Judgement::Refuse(INVALID_REQUEST);
    };
    let pattern = pattern.trim();
    if pattern.is_empty() || pattern.chars().count() > MAX_FS_PATH_CHARS {
        return Judgement::Refuse(INVALID_REQUEST);
    }
    let Some(plan) = crate::services::plugins::glob::plan(pattern, unrestricted) else {
        return Judgement::Refuse(INVALID_REQUEST);
    };
    let base = match resolve_glob_base(roots, &plan, unrestricted) {
        Ok(base) => base,
        Err(refusal) => return Judgement::Refuse(refusal_of(refusal)),
    };
    read_reach(
        page,
        &base,
        pattern,
        unrestricted,
        holds,
        Job::Glob {
            display: pattern.to_owned(),
            plan,
        },
    )
}

/// The directory one glob pattern starts in, as the walker needs it: a canonical directory inside
/// the installation's roots (or, under `fs.anyPath`, any directory the pattern names).
///
/// The path the pattern names - the absolute prefix it wrote, then its literal leading segments - is
/// resolved exactly the way a read's path is: through the same `resolve_file`, which is what puts the
/// containment check and the reject table in front of the walk. A pattern with no literal segment at
/// all starts at the root itself: the workspace when there is one, else the installation's own
/// package. That order is `FsRoots::resolve`'s own: the first root that has the name is the one the
/// name means.
pub(super) fn resolve_glob_base(
    roots: &gates::FsRoots,
    plan: &crate::services::plugins::glob::GlobPlan,
    unrestricted: bool,
) -> Result<PathBuf, ReadRefusal> {
    // An absolute pattern carries the location it names in its prefix (`/`, `C:/`), so the resolver
    // is given the whole name: `C:/Users/**` starts at `C:/Users`, not at `Users` below the plugin's
    // own package. A relative pattern keeps `resolve_file`'s own reading of a relative name, and the
    // prefix is only ever set when the installation declared `fs.anyPath` (`glob::plan`).
    let named = match plan.prefix.as_deref() {
        Some(prefix) => format!("{prefix}{}", plan.base),
        None => plan.base.clone(),
    };
    if named.is_empty() {
        return match roots.workspace.as_ref() {
            Some(workspace) => match std::fs::canonicalize(workspace) {
                Ok(path) if path.is_dir() => Ok(path),
                _ => std::fs::canonicalize(&roots.plugin).map_err(|_| ReadRefusal::NotFound),
            },
            None => std::fs::canonicalize(&roots.plugin).map_err(|_| ReadRefusal::NotFound),
        };
    }
    resolve_file(roots, &named, gates::FsMode::Inspect, unrestricted)
}

/// The range gate: the read gate's permission, path and reach, plus the two numbers.
///
/// `offset` defaults to the start of the file and `length` to the whole byte ceiling, so
/// `fs.readRange(path)` is "the first byte range this build serves" and a caller that names only an
/// offset gets everything from there. A length over [`MAX_READ_BYTES`] is refused rather than
/// clamped, like every other bound in this API: the caller asked for a range this build does not
/// answer, and answering a different one is how a plugin reasons about bytes it never received. An
/// offset past the end is *not* an error - it is an empty read, which is what is there.
pub(super) fn judge_read_range(
    page: &PluginPage,
    roots: &gates::FsRoots,
    params: Option<&Value>,
    holds: &dyn Fn(&SessionGrant) -> bool,
) -> Judgement {
    let requested = match read_path(page, params) {
        Ok(path) => path,
        Err(refusal) => return Judgement::Refuse(refusal),
    };
    let offset = match params.and_then(|params| params.get("offset")) {
        None | Some(Value::Null) => 0,
        Some(Value::Number(number)) => match number.as_u64() {
            Some(value) => value,
            None => return Judgement::Refuse(INVALID_REQUEST),
        },
        Some(_) => return Judgement::Refuse(INVALID_REQUEST),
    };
    let length = match params.and_then(|params| params.get("length")) {
        None | Some(Value::Null) => MAX_READ_BYTES,
        Some(Value::Number(number)) => match number.as_u64() {
            Some(value) if value >= 1 && value <= MAX_READ_BYTES => value,
            Some(_) => return Judgement::Refuse(TOO_LARGE),
            None => return Judgement::Refuse(INVALID_REQUEST),
        },
        Some(_) => return Judgement::Refuse(INVALID_REQUEST),
    };
    judge_fs_read(
        page,
        roots,
        requested,
        gates::FsMode::Read,
        page.grants.declares("fs.anyPath"),
        holds,
        Job::ReadRange {
            display: requested.to_owned(),
            offset,
            length,
        },
    )
}

/// The two brakes the opener gate puts in front of a path: a name the reject table covers, and an
/// extension the system would *run*.
///
/// Neither is relaxed by `fs.anyPath` - that widening is about where a plugin may reach, and neither
/// brake is about location - and both are applied to the name the caller wrote and to the path it
/// resolved to, since a link is what makes those two differ. One function, because the judgement and
/// the act must ask the same question: the question can sit on screen for a minute, and the file
/// behind the path can change while it does (`perform`'s two opener arms ask it again).
pub(super) fn open_brake(requested: &str, resolved: &Path) -> Option<Refusal> {
    let resolved_text = resolved
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR_STR, "/");
    if gates::is_rejected_path(requested) || gates::is_rejected_path(&resolved_text) {
        return Some(DENIED_BY_POLICY);
    }
    if gates::is_executable_path(requested) || gates::is_executable_path(&resolved_text) {
        return Some(EXECUTABLE_REFUSED);
    }
    None
}

/// The opener gate: `fs.openDefault` and `fs.reveal`, one reach with two permissions.
///
/// Both name a path that must exist (an inspection, so a directory is a valid answer), both read the
/// *reading* scope as their standing reach, and both go through the same two brakes before the reach
/// is consulted: a name the reject table covers, and an extension the system would *run*. The brakes
/// are not relaxed by `fs.anyPath` - that widening is about where a plugin may reach, and neither
/// brake is about location. What differs is only the permission and which program the caller hands
/// the path to.
pub(super) fn judge_open(
    page: &PluginPage,
    roots: &gates::FsRoots,
    params: Option<&Value>,
    holds: &dyn Fn(&SessionGrant) -> bool,
    open_default: bool,
) -> Judgement {
    let permission = if open_default {
        "fs.openDefault"
    } else {
        "fs.reveal"
    };
    let requested = match read_path_with(page, params, permission) {
        Ok(path) => path,
        Err(refusal) => return Judgement::Refuse(refusal),
    };
    let unrestricted = page.grants.declares("fs.anyPath");
    let resolved = match resolved_file(roots, requested, gates::FsMode::Inspect, unrestricted) {
        Ok(resolved) => resolved,
        Err(judgement) => return judgement,
    };
    // The two brakes, asked through the one function the act asks them through as well: the answer
    // and the act are apart in time, and the path can name a different file by the time it is acted
    // on (`perform`'s two opener arms).
    if let Some(refusal) = open_brake(requested, &resolved) {
        return Judgement::Refuse(refusal);
    }
    let job = if open_default {
        Job::OpenDefault {
            display: requested.to_owned(),
        }
    } else {
        Job::Reveal {
            display: requested.to_owned(),
        }
    };
    read_reach(page, &resolved, requested, unrestricted, holds, job)
}
