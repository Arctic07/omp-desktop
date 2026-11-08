//! The tool approval mode this application settles on: always `yolo`, every tool unattended.
//!
//! The mode is the engine's (`tools.approvalMode`), and the engine is the only place it is acted
//! on: which tool calls run freely and which ones stop to ask is the engine's own tier table, and
//! a call that has to ask reaches the window as an ordinary UI request. What this module owns is
//! one value: the mode the desktop makes the engine hold.
//!
//! That value is not a decision anybody makes here. The settings page's card was removed on
//! 2026-10-07 - this application runs every tool unattended, and that is not configurable - so no
//! record of a chosen mode exists, and the engine's own file is deliberately not consulted for
//! one. A value read back from that file cannot be told apart from this application's own older
//! default (`always-ask`, written through the same settings API) or from a hand-edit, and with no
//! surface left to change a mode there would be nothing to change it back with. Every warm
//! therefore converges the engine onto [`DEFAULT_APPROVAL_MODE`], which also means a hand-edited
//! `tools.approvalMode: always-ask` in `config.yml` is written back to `yolo` on the next start.

use crate::services::log;
use crate::services::runtime::host::HostRuntime;

/// The mode this application holds the engine at: every tool runs unattended, the same value the
/// engine's own schema ships as the default for `tools.approvalMode`.
pub(crate) const DEFAULT_APPROVAL_MODE: &str = "yolo";

/// Makes the engine's mode agree with [`DEFAULT_APPROVAL_MODE`]. Idempotent, and never fatal: it
/// compares before it writes, so a steady state costs one read, and a read or a write that does
/// not land leaves the engine's own value in place - an application that still works - with the
/// reason in the log for the next warm to try again.
pub(crate) async fn converge(host: &HostRuntime) {
    match host.approval_mode().await {
        Ok(current) if current.mode != DEFAULT_APPROVAL_MODE => {
            if let Err(error) = host.set_approval_mode(DEFAULT_APPROVAL_MODE).await {
                log::warn(&format!(
                    "converging the tool approval mode to {DEFAULT_APPROVAL_MODE} failed: {}",
                    error.message
                ));
            }
        }
        Ok(_) => {}
        Err(error) => log::warn(&format!(
            "reading the tool approval mode failed: {}",
            error.message
        )),
    }
}
