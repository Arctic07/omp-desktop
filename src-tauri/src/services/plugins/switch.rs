//! The switch of source: moving one installation from one marketplace to another
//! (`rules.md#plugin-system`).
//!
//! The engine cannot do this in one step. `upgradePlugin` reinstalls `name@marketplace` in place, and
//! the runtime link a scope holds allows only one marketplace to be live at a time - so the move is
//! uninstall, install, re-enable, and there is no state in between that the engine can be asked to
//! finish. What that costs is stated in the page's confirmation card (§8.4); what this module owes is
//! an honest answer about where the installation ended up.
//!
//! The sequence is [`SwitchMachine`]: a machine over the three engine writes, driven by the result of
//! the last one. It is not async and it holds no host, which is what makes the three transitions that
//! decide what the user is left with - switched, switched back, gone - readable and testable against
//! scripted results (`mod tests`). [`switch_source`] is the same walk in this process: it reads the
//! list, resolves the installation the caller named, runs the machine against the runtime, and leaves
//! the consent chain answered (a package that widened what it may do is not left running under the old
//! confirmation, exactly as an in-place upgrade's replacement is not).
//!
//! Nothing here forgets a consent record: the confirmation is keyed by the plugin's own id (store v9),
//! so it survives the installation being replaced from another marketplace - which is the whole reason
//! the switch does not ask the user again.

use crate::errors::{
    IpcError, IpcResult, INVALID_INPUT, PLUGIN_NOT_FOUND, PLUGIN_UPDATE_SWITCH_FAILED,
};
use crate::models::plugins::identity;
use crate::models::plugins::{EnginePluginsView, PluginUpdateSwitch};
use crate::services::log;
use crate::services::plugins::audit;
use crate::services::plugins::consent_flow;
use crate::state::AppState;

/// The installation a switch starts from: the facts recorded before anything is removed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SwitchStart {
    pub(crate) plugin_id: String,
    pub(crate) scope: String,
    /// The marketplace the plugin is installed from now.
    pub(crate) marketplace: String,
    /// The engine handle it is installed under now (`name@marketplace`).
    pub(crate) install_spec: String,
    /// The version the engine reports for it, for the log.
    pub(crate) version: Option<String>,
    pub(crate) enabled: bool,
}

/// One engine write the sequence asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SwitchStep {
    /// Remove the installation the switch starts from.
    Uninstall { install_spec: String },
    /// Install the plugin from a marketplace: the target one, or the previous one when rolling back.
    Install { install_spec: String },
    /// Put an installation back in the enabled state it had.
    Enable { install_spec: String },
}

/// Why a switch did not happen, and what it left behind.
///
/// `cause` is the answer the caller gets. `rolled_back` and `rollback_failed` are the two states a
/// user has to be told apart - "we put it back" and "we could not" - and only the second has an audit
/// event of its own (`plugin.update.rollback_failed`).
#[derive(Debug)]
pub(crate) struct SwitchFailure {
    pub(crate) cause: IpcError,
    pub(crate) rolled_back: bool,
    pub(crate) rollback_failed: bool,
}

/// What a switch ended as.
#[derive(Debug)]
pub(crate) enum SwitchEnd {
    Switched(PluginUpdateSwitch),
    Failed(SwitchFailure),
}

/// Where the sequence is between two engine writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// Nothing has been written yet: the previous installation is still there.
    Start,
    /// The previous installation is gone and the target marketplace is being installed.
    InstallingTarget,
    /// The target is installed; only the enabled state is left.
    EnablingTarget,
    /// The target install failed and the previous marketplace is being installed again.
    RollingBack,
    /// The previous installation is back; only its enabled state is left.
    EnablingRolledBack,
    /// There is nothing left to write.
    Done,
}

/// The switch sequence, as data.
///
/// Two methods: what to write next ([`Self::step`]) and what the result means
/// ([`Self::advance`]). The second answers `None` while there is more to do and the end of the
/// sequence otherwise, so the caller is a loop over three engine calls and nothing else.
pub(crate) struct SwitchMachine {
    start: SwitchStart,
    target_marketplace: String,
    target_spec: String,
    phase: Phase,
    /// The failure of the target install, kept while the rollback runs because the answer reports it.
    cause: Option<IpcError>,
}

impl SwitchMachine {
    pub(crate) fn new(start: SwitchStart, target_marketplace: &str) -> Self {
        let target_spec = install_spec_of(&start.plugin_id, target_marketplace);
        Self {
            start,
            target_marketplace: target_marketplace.to_owned(),
            target_spec,
            phase: Phase::Start,
            cause: None,
        }
    }

    /// The engine write to make next, or `None` when the sequence has ended.
    pub(crate) fn step(&self) -> Option<SwitchStep> {
        match self.phase {
            Phase::Start => Some(SwitchStep::Uninstall {
                install_spec: self.start.install_spec.clone(),
            }),
            Phase::InstallingTarget => Some(SwitchStep::Install {
                install_spec: self.target_spec.clone(),
            }),
            Phase::RollingBack => Some(SwitchStep::Install {
                install_spec: self.start.install_spec.clone(),
            }),
            Phase::EnablingTarget => Some(SwitchStep::Enable {
                install_spec: self.target_spec.clone(),
            }),
            Phase::EnablingRolledBack => Some(SwitchStep::Enable {
                install_spec: self.start.install_spec.clone(),
            }),
            Phase::Done => None,
        }
    }

    /// Feeds the result of the step it asked for back into the sequence.
    pub(crate) fn advance(&mut self, result: IpcResult<()>) -> Option<SwitchEnd> {
        match self.phase {
            Phase::Done => None,
            Phase::Start => match result {
                // Nothing was removed, so there is nothing to roll back: the engine's own failure is
                // the answer, and the installation is exactly as it was.
                Err(cause) => Some(SwitchEnd::Failed(SwitchFailure {
                    cause,
                    rolled_back: false,
                    rollback_failed: false,
                })),
                Ok(()) => {
                    self.phase = Phase::InstallingTarget;
                    None
                }
            },
            Phase::InstallingTarget => match result {
                Ok(()) => {
                    if self.start.enabled {
                        self.phase = Phase::EnablingTarget;
                        None
                    } else {
                        self.phase = Phase::Done;
                        Some(SwitchEnd::Switched(self.switched()))
                    }
                }
                // One rollback attempt: the installation is gone at this point and the marketplace it
                // came from is the only way back. A second attempt would be a different decision than
                // the one the user confirmed.
                Err(error) => {
                    self.cause = Some(error);
                    self.phase = Phase::RollingBack;
                    None
                }
            },
            Phase::RollingBack => match result {
                Ok(()) if self.start.enabled => {
                    self.phase = Phase::EnablingRolledBack;
                    None
                }
                Ok(()) => {
                    self.phase = Phase::Done;
                    Some(SwitchEnd::Failed(self.restored()))
                }
                // Both halves failed. The plugin is uninstalled and its confirmation is deliberately
                // kept (this module never writes to the store), so installing it again from any source
                // does not ask the user again.
                Err(rollback) => {
                    self.phase = Phase::Done;
                    Some(SwitchEnd::Failed(self.lost(rollback)))
                }
            },
            Phase::EnablingRolledBack => {
                if let Err(error) = result {
                    log::warn(&format!(
                        "the plugin {} was put back after a failed source switch but could not be enabled again: code={} message={}",
                        self.start.plugin_id, error.code, error.message
                    ));
                }
                self.phase = Phase::Done;
                Some(SwitchEnd::Failed(self.restored()))
            }
            Phase::EnablingTarget => match result {
                Ok(()) => {
                    self.phase = Phase::Done;
                    Some(SwitchEnd::Switched(self.switched()))
                }
                // The switch happened and the plugin is left switched off. Reported as a failure
                // because the state the user had is not the state they got, and the answer says which
                // one it is instead of pretending either.
                Err(error) => {
                    self.phase = Phase::Done;
                    Some(SwitchEnd::Failed(SwitchFailure {
                        cause: IpcError::from_message(
                            PLUGIN_UPDATE_SWITCH_FAILED,
                            format!(
                                "The plugin was installed from {} but could not be switched on again ({}); it is installed and switched off.",
                                self.target_marketplace, error.message
                            ),
                        ),
                        rolled_back: false,
                        rollback_failed: false,
                    }))
                }
            },
        }
    }

    fn switched(&self) -> PluginUpdateSwitch {
        PluginUpdateSwitch {
            from: self.start.install_spec.clone(),
            to: self.target_spec.clone(),
            marketplace: self.target_marketplace.clone(),
            rolled_back: false,
        }
    }

    fn restored(&self) -> SwitchFailure {
        SwitchFailure {
            cause: IpcError::from_message(
                PLUGIN_UPDATE_SWITCH_FAILED,
                format!(
                    "The plugin could not be installed from {} ({}); the previous installation from {} was restored.",
                    self.target_marketplace,
                    self.cause
                        .as_ref()
                        .map(|cause| cause.message.as_str())
                        .unwrap_or_default(),
                    self.start.marketplace
                ),
            ),
            rolled_back: true,
            rollback_failed: false,
        }
    }

    fn lost(&self, rollback: IpcError) -> SwitchFailure {
        SwitchFailure {
            cause: IpcError::from_message(
                PLUGIN_UPDATE_SWITCH_FAILED,
                format!(
                    "The plugin could not be installed from {} ({}) and could not be put back either ({}): it is now uninstalled, and you can install it again from the marketplace page. Your confirmation for it was kept.",
                    self.target_marketplace,
                    self.cause
                        .as_ref()
                        .map(|cause| cause.message.as_str())
                        .unwrap_or_default(),
                    rollback.message
                ),
            ),
            rolled_back: false,
            rollback_failed: true,
        }
    }
}

/// The row one installation spec names, or `None` when the list does not hold it.
///
/// The switch steps address installations by the engine's own handle (`name@marketplace`), and the
/// process supervisor is keyed by the plugin's identity: this is the one place the two are related.
async fn installed_row(
    state: &AppState,
    cwd: Option<&str>,
    install_spec: &str,
    scope: &str,
) -> Option<crate::models::plugins::EnginePluginRow> {
    let view = state.runtime.plugins(cwd).await.ok()?;
    view.plugins.into_iter().find(|row| {
        row.scope == scope && crate::models::plugins::identity::install_spec(row) == install_spec
    })
}

/// The handle an installation of `plugin_id` from `marketplace` is recorded under.
fn install_spec_of(plugin_id: &str, marketplace: &str) -> String {
    format!("{plugin_id}@{marketplace}")
}

/// Performs one step on the runtime.
async fn perform(
    state: &AppState,
    cwd: Option<&str>,
    step: &SwitchStep,
    scope: &str,
) -> IpcResult<()> {
    match step {
        SwitchStep::Uninstall { install_spec } => {
            // The package has to be free before the engine unlinks it: a running worker's working
            // directory is that package, and Windows answers `EBUSY` while it exists (2026-10-27).
            if let Some(row) = installed_row(state, cwd, install_spec, scope).await {
                let row_id = crate::models::plugins::identity::plugin_id(&row).into_owned();
                state
                    .plugin_process
                    .stop_installation(&row_id, &row.scope)?;
            }
            state
                .runtime
                .plugin_uninstall(cwd, install_spec, Some(scope))
                .await
                .map(|_| ())
        }
        SwitchStep::Install { install_spec } => state
            .runtime
            .plugin_install(cwd, install_spec, Some(scope))
            .await
            .map(|_| ()),
        SwitchStep::Enable { install_spec } => state
            .runtime
            .plugin_set_enabled(cwd, install_spec, true, Some(scope))
            .await
            .map(|_| ()),
    }
}

/// Moves one plugin from the marketplace it is installed from to `target_marketplace`, and answers
/// with the list as it stands afterwards.
///
/// The scope is required (`INVALID_INPUT` when it is missing or unknown): a plugin installed in both
/// scopes has two installations, the engine's writes address one at a time, and which one to move is
/// the user's decision rather than a guess this layer makes - the same posture the engine takes.
/// The installation has to be a marketplace one; an npm or linked install has no marketplace to
/// switch from and is refused rather than silently reinstalled as something else.
pub(crate) async fn switch_source(
    state: &AppState,
    cwd: Option<&str>,
    project_key: Option<&str>,
    plugin_id: &str,
    scope: Option<&'static str>,
    target_marketplace: &str,
) -> IpcResult<(EnginePluginsView, PluginUpdateSwitch)> {
    let Some(scope) = scope else {
        return Err(IpcError::new(
            INVALID_INPUT,
            "A source switch has to name the scope it moves.",
        ));
    };
    let before = state.runtime.plugins(cwd).await?;
    let start = start_of(&before, plugin_id, scope, target_marketplace)?;
    let mut machine = SwitchMachine::new(start, target_marketplace);
    let end = loop {
        let Some(step) = machine.step() else {
            break None;
        };
        let result = perform(state, cwd, &step, scope).await;
        if let Some(end) = machine.advance(result) {
            break Some(end);
        }
    };
    let switched = match end {
        Some(SwitchEnd::Switched(switched)) => switched,
        Some(SwitchEnd::Failed(failure)) => {
            if failure.rollback_failed {
                audit::update_rollback_failed(plugin_id, Some(scope), target_marketplace);
            }
            log::warn(&format!(
                "plugin source switch failed: plugin={plugin_id} scope={scope} target={target_marketplace} rolled_back={} rollback_failed={} code={}",
                failure.rolled_back, failure.rollback_failed, failure.cause.code
            ));
            return Err(failure.cause);
        }
        None => {
            return Err(IpcError::new(
                PLUGIN_UPDATE_SWITCH_FAILED,
                "The source switch ended without an answer.",
            ))
        }
    };
    // The consent chain an upgrade runs, for the same reason: the package that now runs may bring
    // reasons the confirmed version did not, and a replacement the engine has already performed is
    // reconciled here rather than left running under an answer about the old code (spec §6.5).
    let after = state.runtime.plugins(cwd).await?;
    let reconciled =
        consent_flow::reconfirm_widened(state, cwd, project_key, &before.plugins, after).await?;
    let plugins = consent_flow::quarantine_unconfirmed(state, cwd, project_key, reconciled).await?;
    audit::update_switch(plugin_id, Some(scope), target_marketplace);
    Ok((plugins, switched))
}

/// The installation one switch starts from, or the refusal the request earns.
///
/// The row is found by the plugin's own id and the scope the caller named: an id this workspace does
/// not hold at that scope is `PLUGIN_NOT_FOUND` (there is nothing to move), a row that is not a
/// marketplace installation is `INVALID_INPUT` (there is no source to switch from), and so is a
/// target that is the marketplace it already comes from.
fn start_of(
    view: &EnginePluginsView,
    plugin_id: &str,
    scope: &str,
    target_marketplace: &str,
) -> IpcResult<SwitchStart> {
    let Some(row) = view
        .plugins
        .iter()
        .find(|row| identity::plugin_id(row) == plugin_id && row.scope == scope)
    else {
        return Err(IpcError::from_message(
            PLUGIN_NOT_FOUND,
            format!("The plugin is not installed in the {scope} scope."),
        ));
    };
    let Some(marketplace) = identity::source_marketplace(row) else {
        return Err(IpcError::new(
            INVALID_INPUT,
            "Only a plugin installed from a marketplace can switch source.",
        ));
    };
    if marketplace == target_marketplace {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The plugin is already installed from that marketplace.",
        ));
    }
    Ok(SwitchStart {
        plugin_id: plugin_id.to_owned(),
        scope: row.scope.clone(),
        marketplace: marketplace.to_owned(),
        install_spec: identity::install_spec(row).to_owned(),
        version: row.version.clone(),
        enabled: row.enabled,
    })
}

#[cfg(test)]
mod tests;
