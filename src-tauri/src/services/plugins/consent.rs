//! The consent chain's decisions, as functions of the lists they are answered from: which
//! installations a plugin write may switch on, which ones an install has to switch off, and which
//! ones a withdrawal has to stop before the record it covers is forgotten.
//!
//! Every function here is a pure function of the host's list, this application's grants and the
//! caller's own arguments, which is what makes a rule about code running inside the agent process
//! testable without a host, a store or a file (`mod tests` below). The command layer keeps the IO
//! and the wording; the decisions are here.
//!
//! The vocabulary is the one the rest of the plugin domain uses: an *installation* is a plugin id
//! together with the scope it lives at. The same id can be installed at both scopes - the project
//! one shadows the other - and an answer about one installation is never an answer about the other,
//! so nothing in here reasons about "the plugin" in general.

use crate::errors::{IpcError, IpcResult, INVALID_INPUT, PLUGIN_NOT_FOUND};
use crate::models::plugins::identity;
use crate::models::plugins::{EnginePluginRow, PluginGrantRow};

use super::validate::consent_block;

/// One installation a consent decision addresses: the plugin id, the engine handle that writes it,
/// the scope it lives at, and whether that installation's code would run in the agent process.
///
/// Owned rather than borrowed from the host's list, because the list a decision is read from is
/// replaced by the next write: a loop that switches off what it enumerated keeps addressing the
/// installations it read, not the ones a later answer happens to hold.
///
/// The two identities are both here on purpose (`models::plugins::identity`): `id` is the plugin and
/// is what every consent fact is keyed by, while `target` is the engine's `name@marketplace` handle
/// and is the only thing an engine write may be addressed with. A write that confused them would
/// switch off a different installation - or none at all - while the record it was judged against
/// said everything was confirmed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InstallRef {
    pub(crate) id: String,
    pub(crate) target: String,
    pub(crate) scope: String,
    /// The host's factual reading of this installation (`consent.required`), carried so the enable
    /// gate can ask about every row it could flip without reading the list twice.
    pub(crate) consent_required: bool,
}

/// The installation one row describes, in the vocabulary a decision is written in.
fn install_of(row: &EnginePluginRow) -> InstallRef {
    InstallRef {
        id: identity::plugin_id(row).into_owned(),
        target: identity::install_spec(row).to_owned(),
        scope: row.scope.clone(),
        consent_required: row.consent.required,
    }
}

/// Every installation of `plugin_id` the workspace can see, narrowed to one scope when the caller
/// named one - the rows a consent decision of that write is about.
///
/// Matching is by the *plugin's own id* (plan §4.1): a marketplace installation is swapped between
/// marketplaces without the plugin changing, so an answer about "this plugin at this scope" has to
/// outlive the handle it happens to be installed under. Each entry carries that handle (`target`) so
/// the caller performs its engine writes against the installation it decided about.
///
/// The narrowing is exact: a named scope addresses only that installation, and an id the list does
/// not hold under it is not an installation this write can address at all (every caller turns an
/// empty answer into `PLUGIN_NOT_FOUND`). Naming no scope keeps every row, because which
/// installation such a write flips is the engine's own choice rather than this layer's, and a
/// decision has to hold for each of them.
///
/// One entry per installation: a host that listed the same `(id, scope)` twice cannot make a caller
/// address it twice.
pub(crate) fn installs(
    rows: &[EnginePluginRow],
    plugin_id: &str,
    scope: Option<&str>,
) -> Vec<InstallRef> {
    let mut targets: Vec<InstallRef> = Vec::new();
    for row in rows {
        if identity::plugin_id(row) != plugin_id || scope.is_some_and(|scope| row.scope != scope) {
            continue;
        }
        let target = install_of(row);
        if !targets.contains(&target) {
            targets.push(target);
        }
    }
    targets
}

/// The rows one *write* addresses, given the id the caller sent.
///
/// A write names either the engine handle (`installId`, which is what the page sends for a
/// marketplace row) or the plugin id (an npm or link install is addressed by its package name, and
/// a caller reading a grant may name the plugin). Both are matched, and the answer is the rows
/// themselves because the caller still has to judge them - the built-in protection reads the source,
/// and the import recycling reads the marketplace. Half of a handle never matches: an id is either
/// the row's identity or the row's handle, never a guess between them.
pub(crate) fn targets<'a>(
    rows: &'a [EnginePluginRow],
    target: &str,
    scope: Option<&str>,
) -> Vec<&'a EnginePluginRow> {
    rows.iter()
        .filter(|row| {
            (identity::install_spec(row) == target || identity::plugin_id(row) == target)
                && scope.is_none_or(|scope| row.scope == scope)
        })
        .collect()
}

/// Whether a confirmation is on record for this very installation.
///
/// The lookup is the pair: a grant for the user-scope installation says nothing about the
/// project-scope one, which is the whole reason the record is keyed by them together.
pub(crate) fn is_granted(grants: &[PluginGrantRow], id: &str, scope: &str) -> bool {
    grants
        .iter()
        .any(|grant| grant.plugin_id == id && grant.scope == scope)
}

/// The enabled installations whose code would run without a confirmation: what an install has to
/// switch off before its answer is returned.
///
/// The three conditions are the three ways a row can be running unconfirmed, and each is read from
/// the row itself: `enabled` is the engine's report of what is on, `consent.required` is its reading
/// of what the plugin would run, and the grant is this application's own record. A row that needs no
/// confirmation, or whose installation was confirmed, is left exactly as the engine reported it -
/// this never switches off something the user agreed to.
pub(crate) fn unconfirmed_enabled(
    rows: &[EnginePluginRow],
    grants: &[PluginGrantRow],
) -> Vec<InstallRef> {
    let mut targets: Vec<InstallRef> = Vec::new();
    for row in rows {
        let id = identity::plugin_id(row);
        if !row.enabled || !row.consent.required || is_granted(grants, &id, &row.scope) {
            continue;
        }
        let target = install_of(row);
        if !targets.contains(&target) {
            targets.push(target);
        }
    }
    targets
}

/// The installations one list holds that another list did not: what a write added, read from the two
/// answers the host gave.
///
/// Which plugin an install source resolves to is the engine's classification, so an install cannot
/// be attributed to an id on this side - but the two lists say it: an installation that was not in
/// the list before the call and is in the list after it is what that call added. A re-install of an
/// existing `(id, scope)` adds no row and is therefore not a new installation; the phase has no
/// upgrade event, and what it does to consent (a row that runs code unconfirmed) is reported by the
/// quarantine's own disable.
pub(crate) fn added_installs(
    before: &[EnginePluginRow],
    after: &[EnginePluginRow],
) -> Vec<InstallRef> {
    let mut added: Vec<InstallRef> = Vec::new();
    for row in after {
        let id = identity::plugin_id(row);
        let known = before
            .iter()
            .any(|was| identity::plugin_id(was) == id && was.scope == row.scope);
        if known {
            continue;
        }
        let target = install_of(row);
        if !added.contains(&target) {
            added.push(target);
        }
    }
    added
}

/// Whether the list still reports this installation as on.
///
/// The answer to a disable is only believed after this read: a write that came back without an error
/// and left the row enabled has stopped nothing, and a row that is gone from the list is not
/// running either.
pub(crate) fn enabled_at(rows: &[EnginePluginRow], plugin_id: &str, scope: &str) -> bool {
    rows.iter()
        .any(|row| identity::plugin_id(row) == plugin_id && row.scope == scope && row.enabled)
}

/// The reasons one upgrade added to an installation's code.
///
/// The confirmation this desktop keeps is per *installation* - it names no version and no reason
/// list - so nothing about a widened upgrade is visible in the record itself. This is the comparison
/// that finds it: the reasons a plugin brings before and after its files were replaced, read off the
/// same rows the release and the restore answer with.
///
/// The comparison is over `consent.reasons` - the code a package would run - and deliberately not
/// over the desktop permissions a block declares. A permission only matters beside the code that
/// uses it, and an upgrade that adds `fs.anyPath`, `net.anyHost`, `agent.complete` or `ui.theme.css`
/// changes what that code may reach, not what it does; the reasons are the part that decides whether
/// the record still describes the package.
///
/// The rule is a set difference: a reason the new code brings that the confirmed code did not. A
/// *narrower* upgrade adds none - a plugin that stopped shipping hooks is still covered by the
/// answer the user gave - and an equal one is the ordinary case.
pub(crate) fn widened_reasons(before: &[String], after: &[String]) -> Vec<String> {
    after
        .iter()
        .filter(|reason| !before.iter().any(|known| known == *reason))
        .cloned()
        .collect()
}

/// One installation an upgrade widened, and the reasons the new version adds.
///
/// A type of its own rather than a pair because the caller does two things with it - records the
/// answer against the new code, and states in the audit trail which reasons that answer now covers -
/// and both need the scope the row was read at beside the id it is keyed by.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WidenedInstall {
    pub(crate) id: String,
    pub(crate) scope: String,
    /// The reasons the new version brings that the confirmed one did not, for the audit line.
    pub(crate) reasons: Vec<String>,
}

/// Every installation one upgrade widened, paired with what it was before.
///
/// Matching is by id *and* scope: the same plugin can be installed in both, and a widening of the
/// project-scope copy says nothing about the user-scope one. An installation the "before" list does
/// not hold is an install, not an upgrade, and is left to the install path's own quarantine.
pub(crate) fn widened_installs(
    before: &[EnginePluginRow],
    after: &[EnginePluginRow],
) -> Vec<WidenedInstall> {
    let mut widened = Vec::new();
    for row in after {
        let id = identity::plugin_id(row);
        let Some(previous) = before
            .iter()
            .find(|candidate| identity::plugin_id(candidate) == id && candidate.scope == row.scope)
        else {
            continue;
        };
        let reasons = widened_reasons(&previous.consent.reasons, &row.consent.reasons);
        if row.consent.required && !reasons.is_empty() {
            widened.push(WidenedInstall {
                id: id.into_owned(),
                scope: row.scope.clone(),
                reasons,
            });
        }
    }
    widened
}

/// The widened installations whose confirmation may be carried over: the ones already on record.
///
/// A widening renews an answer, it never creates one. The user confirmed this installation's code
/// once, so a replacement that adds a reason keeps that answer - but an installation whose
/// confirmation was *withdrawn* has no answer to carry, and re-recording one here would silently
/// undo the withdrawal. Such a row stays switched off and its switch asks the page's own question
/// again, which is the state a withdrawal leaves behind.
pub(crate) fn renewals<'a>(
    widened: &'a [WidenedInstall],
    grants: &[PluginGrantRow],
) -> Vec<&'a WidenedInstall> {
    widened
        .iter()
        .filter(|target| is_granted(grants, &target.id, &target.scope))
        .collect()
}

/// Which installation an import addresses: the scope the caller named, the only one there is, or a
/// refusal when a plugin is installed in both and the caller named neither.
///
/// The same rule the engine's own upgrade applies (`upgradePlugin` refuses a plugin installed in both
/// scopes when no scope is named), decided from the workspace's rows rather than re-derived from the
/// engine's answer: an import has to name the installation it replaces *before* it asks, because the
/// request carries the scope it installs into.
pub(crate) fn import_target_scope(
    installs: &[InstallRef],
    scope: Option<&'static str>,
) -> IpcResult<&'static str> {
    if let Some(named) = scope {
        return match installs.iter().find(|row| row.scope == named) {
            Some(_) => Ok(named),
            None => Err(IpcError::from_message(
                INVALID_INPUT,
                format!("The plugin is not installed in the {named} scope."),
            )),
        };
    }
    match installs {
        [only] => match only.scope.as_str() {
            "user" => Ok("user"),
            "project" => Ok("project"),
            // A scope this build cannot name is one it cannot address either.
            _ => Err(IpcError::new(
                INVALID_INPUT,
                "The plugin is installed in an unknown scope.",
            )),
        },
        _ => Err(IpcError::new(
            INVALID_INPUT,
            "The plugin is installed in both scopes; name the one to import into.",
        )),
    }
}

/// One installation's answer to the enable gate: whether its code would run in the agent process,
/// and whether a confirmation of that very installation is on record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct GateAnswer {
    pub(crate) consent_required: bool,
    pub(crate) granted: bool,
}

/// The enable gate over every installation the write could address.
///
/// `consent_required` is the OR over the answers and `granted` is the AND, which is the fail-closed
/// pair: a write that names no scope lets the engine choose which installation it flips, so it is
/// allowed only when every one of them is confirmed, while a single installation that runs code is
/// enough to make a confirmation necessary at all. An empty list is not answered here - a caller
/// that found no row has already refused the write with `PLUGIN_NOT_FOUND`.
pub(crate) fn gate(answers: &[GateAnswer]) -> IpcResult<()> {
    let required = answers.iter().any(|answer| answer.consent_required);
    let granted = answers.iter().all(|answer| answer.granted);
    consent_block(required, granted, true)
}

/// The scope a plugin write can be attributed to when the caller named none: the only scope this id
/// is installed at, or nothing when the list cannot say which installation was addressed.
///
/// Used for the audit line, never for a decision: the alternative, picking one of two scopes, would
/// put a fact in the trail that nobody observed.
pub(crate) fn sole_scope(installs: &[InstallRef]) -> Option<&str> {
    let mut scopes = installs.iter().map(|install| install.scope.as_str());
    match (scopes.next(), scopes.next()) {
        (Some(scope), None) => Some(scope),
        _ => None,
    }
}

/// The scope a grant write records: the caller's own, or the only scope this id is installed at.
///
/// The installation has to be one the workspace can see. A confirmation recorded for something that
/// is not installed would be waiting for a later install of that id at that scope - and would admit
/// it without the user ever being shown what it runs, which is exactly what this record exists to
/// prevent. A write that names no scope and cannot be answered with one - an id the list does not
/// hold, or one installed at both scopes at once - is refused rather than recorded against a guess.
pub(crate) fn grant_scope(
    rows: &[EnginePluginRow],
    id: &str,
    scope: Option<&str>,
) -> IpcResult<String> {
    let targets = installs(rows, id, scope);
    if targets.is_empty() {
        return Err(IpcError::new(
            PLUGIN_NOT_FOUND,
            match scope {
                Some(_) => "The plugin is not installed at that scope.",
                None => "The plugin is not installed.",
            },
        ));
    }
    if let Some(scope) = scope {
        return Ok(scope.to_owned());
    }
    sole_scope(&targets).map(str::to_owned).ok_or_else(|| {
        IpcError::new(
            INVALID_INPUT,
            "This plugin is installed at more than one scope; name the scope to confirm.",
        )
    })
}

/// The scope whose installation is one and the same everywhere: the user scope lives in the host's
/// own plugin directory, so it needs no workspace to name it and every answer about it is keyed by
/// the empty string (`services::plugins::grants`).
const USER_SCOPE: &str = "user";

/// The `project_key` an answer about one installation is stored under: the workspace a project-scope
/// installation belongs to, or the empty string for the user scope, which belongs to none of them.
///
/// This is the identity half of the consent chain, and the same one the reads are keyed by, so a
/// confirmation given here is the confirmation the enable gate finds: the user scope is one
/// installation in every workspace, while a project-scope installation exists once per workspace and
/// the workspace's own registry key is what names it. A caller that named no workspace - or one the
/// registry does not hold - has no identity to record a project-scope answer under, and the write is
/// refused rather than stored under a value that stands for no project: a key nothing can be
/// resolved from would answer for an installation nobody confirmed, in whatever workspace happened
/// to be addressed next.
pub(crate) fn grant_key(scope: &str, workspace_key: Option<&str>) -> IpcResult<String> {
    if scope == USER_SCOPE {
        return Ok(String::new());
    }
    workspace_key.map(str::to_owned).ok_or_else(|| {
        IpcError::new(
            INVALID_INPUT,
            "A project-scope confirmation must name the workspace it was given in.",
        )
    })
}

#[cfg(test)]
mod tests;
