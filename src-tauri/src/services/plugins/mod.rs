//! The plugin domain as this process knows it: the checks it runs on its own, the consent chain it
//! decides and remembers, the audit trail it writes, and the one place the host's plugin failures
//! are restated in this application's vocabulary.
//!
//! Everything that decides what a plugin *is* stays on the host's side of the pipe - the plugin
//! manager, the marketplace registry, the engine's own install classification - because those are
//! the engine's rules and a second copy here would drift from them. What lives in this module is
//! the part of the plugin system that belongs to the desktop: the shape of the arguments it
//! forwards, the value checks of a settings write, the record of the user's confirmation that a
//! plugin may run code, the decisions read from that record, and the trail those decisions leave.
//!
//! Two of those decisions are *sequences* rather than one answer, and each has an owner of its own:
//! `consent_flow` runs the consent chain (what an install quarantines, what an enable gate is
//! answered with, what a withdrawal stops before it forgets, what an upgrade reconciles, what a
//! removal forgets) in the order the chain requires, reading the host and the store for the pure
//! decisions of `consent`; `import_flow` runs one package file's import (unpack, catalogue, promote,
//! register, install or upgrade) and hands the consent half to `consent_flow`. The command layer
//! (`commands::plugins`) sanitizes, calls one of them and converts the answer.

pub(crate) mod agent_budget;
pub(crate) mod audit;
pub(crate) mod bridge;
pub(crate) mod builtin;
pub(crate) mod bus;
pub(crate) mod capabilities_io;
pub(crate) mod consent;
pub(crate) mod consent_flow;
pub(crate) mod download;
pub(crate) mod gates;
pub(crate) mod glob;
pub(crate) mod grants;
pub(crate) mod import_flow;
pub(crate) mod imports;
pub(crate) mod net;
pub(crate) mod package;
pub(crate) mod pages;
pub(crate) mod panels;
pub(crate) mod process;
pub(crate) mod prompt;
pub(crate) mod protocol;
pub(crate) mod renderer;
pub(crate) mod scaffold;
pub(crate) mod sockets;
pub(crate) mod switch;
pub(crate) mod theme_css;
pub(crate) mod validate;

use crate::errors::{
    IpcError, PLUGIN_INSTALL_FAILED, PLUGIN_INSTALL_UNAVAILABLE, PLUGIN_INVALID_SPEC,
    PLUGIN_NOT_FOUND, PLUGIN_PERMISSION_REQUIRED,
};

/// Restates one host failure in the vocabulary this application publishes.
///
/// The host's plugin codes are lowercase machine tokens (`plugin_not_found`), and the rest of this
/// application's IPC surface speaks in the constants `errors.rs` registers. The two name the same
/// facts, so the code is restated here - once, so a frontend branch can name the constant it
/// declares - and the host's message travels unchanged: it is already redacted on the far side and
/// it is what the user reads.
///
/// A code this table does not know (`plugin_scope_mismatch`, or one a later host adds) passes
/// through as it arrived, which is how the rest of this layer treats a host code: the frontend
/// classifier accepts the host's own lowercase vocabulary alongside these constants, and inventing
/// a constant for a failure this layer cannot describe would be worse than forwarding one it can.
pub(crate) fn map_host_error(error: IpcError) -> IpcError {
    let restated = match error.code.as_ref() {
        "plugin_not_found" => Some(PLUGIN_NOT_FOUND),
        "plugin_invalid_spec" => Some(PLUGIN_INVALID_SPEC),
        "plugin_install_failed" => Some(PLUGIN_INSTALL_FAILED),
        "plugin_install_unavailable" => Some(PLUGIN_INSTALL_UNAVAILABLE),
        "plugin_permission_required" => Some(PLUGIN_PERMISSION_REQUIRED),
        _ => None,
    };
    match restated {
        Some(code) => IpcError::from_message(code, error.message),
        None => error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::INVALID_INPUT;

    /// The plugin codes the host sends arrive as the constants this build publishes, with the
    /// message the host wrote; anything else - another host code, or one of this layer's own
    /// failures - travels through untouched.
    #[test]
    fn host_plugin_codes_are_restated_and_other_codes_pass_through() {
        let restated = map_host_error(IpcError::new("plugin_not_found", "No such plugin."));
        assert_eq!(restated.code.as_ref(), PLUGIN_NOT_FOUND);
        assert_eq!(restated.message, "No such plugin.");

        assert_eq!(
            map_host_error(IpcError::new("plugin_invalid_spec", "Bad spec."))
                .code
                .as_ref(),
            PLUGIN_INVALID_SPEC
        );
        assert_eq!(
            map_host_error(IpcError::new("plugin_install_failed", "Install failed."))
                .code
                .as_ref(),
            PLUGIN_INSTALL_FAILED
        );
        let unavailable = map_host_error(IpcError::new(
            "plugin_install_unavailable",
            "bun is missing.",
        ));
        assert_eq!(unavailable.code.as_ref(), PLUGIN_INSTALL_UNAVAILABLE);
        assert_eq!(
            unavailable.message, "bun is missing.",
            "the host's own words travel with the restated code"
        );

        assert_eq!(
            map_host_error(IpcError::new("plugin_scope_mismatch", "Wrong scope."))
                .code
                .as_ref(),
            "plugin_scope_mismatch"
        );
        assert_eq!(
            map_host_error(IpcError::new(INVALID_INPUT, "Empty source."))
                .code
                .as_ref(),
            INVALID_INPUT
        );
    }
}
