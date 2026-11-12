use std::borrow::Cow;

use serde::Serialize;

/// Stable engine error codes. The frontend branches on these values, so they must not change.
///
/// Artifact-level failures keep their historical names; process-level failures of the host use
/// the host's own lowercase codes (contract §2.8), which the frontend classifier accepts
/// alongside these.
pub(crate) const ENGINE_NOT_FOUND: &str = "ENGINE_NOT_FOUND";
pub(crate) const ENGINE_SPAWN_FAILED: &str = "ENGINE_SPAWN_FAILED";
pub(crate) const ENGINE_PROTOCOL: &str = "ENGINE_PROTOCOL";
pub(crate) const ENGINE_REQUEST_FAILED: &str = "ENGINE_REQUEST_FAILED";
/// The host bundle does not match the digests recorded in its own `manifest.json`, so it is
/// refused instead of being executed.
pub(crate) const ENGINE_CHECKSUM_MISMATCH: &str = "ENGINE_CHECKSUM_MISMATCH";
/// The host process answered nothing: it exited, was killed, or the pipe to it is gone.
pub(crate) const HOST_EXITED: &str = "host_exited";
/// The host process died abnormally (non-zero exit or a signal) after it had started.
pub(crate) const HOST_CRASHED: &str = "host_crashed";
/// No host is running and this call will not start one.
pub(crate) const HOST_NOT_READY: &str = "host_not_ready";
/// The host is up, but this process already has as many commands in flight as it will queue
/// (`MAX_IN_FLIGHT_COMMANDS`). Raised on this side only: it says the host is not draining what it
/// is being given, which is a condition this application refuses rather than buffers without end.
pub(crate) const HOST_BUSY: &str = "host_busy";
/// A command that did not answer inside its budget. Replaces the retired `engine_timeout`.
pub(crate) const TIMEOUT: &str = "timeout";
/// The host refused the directories it was pinned to (`host_fatal`). Never retried.
pub(crate) const ENV_PIN_FAILED: &str = "env_pin_failed";
/// Handshake version mismatch; the host exits with code 3 behind it.
pub(crate) const PROTOCOL_MISMATCH: &str = "protocol_mismatch";
pub(crate) const PROMPT_TOO_LARGE: &str = "PROMPT_TOO_LARGE";
/// A transcript too large to load in one call (`HISTORY_BYTES_LIMIT`). Raised instead of returning
/// a shortened history: a transcript that is missing its tail without saying so is worse than one
/// that is refused.
pub(crate) const HISTORY_TOO_LARGE: &str = "HISTORY_TOO_LARGE";
/// An outbound command that does not fit the engine's physical frame limit and is not a
/// prompt (a prompt has its own, more specific code).
pub(crate) const FRAME_TOO_LARGE: &str = "FRAME_TOO_LARGE";
pub(crate) const SESSION_NOT_FOUND: &str = "SESSION_NOT_FOUND";
/// A session file that is not inside the host's own session directory (contract §2.8).
pub(crate) const INVALID_SESSION_PATH: &str = "invalid_session_path";
pub(crate) const WORKSPACE_NOT_FOUND: &str = "WORKSPACE_NOT_FOUND";
/// Reserved: workspaces are keyed by a canonical root key and `workspace_add` is idempotent,
/// so nothing raises this today. Kept because the code set is part of the frozen IPC contract.
#[allow(dead_code)]
pub(crate) const WORKSPACE_DUPLICATE: &str = "WORKSPACE_DUPLICATE";
pub(crate) const STORE_UNAVAILABLE: &str = "STORE_UNAVAILABLE";
pub(crate) const STORE_VERSION_TOO_NEW: &str = "STORE_VERSION_TOO_NEW";
/// The copy a migration takes before it touches anything could not be written, so the migration
/// never started. Raised only on the start-up path (`services::store::Store::open`).
pub(crate) const STORE_BACKUP_FAILED: &str = "STORE_BACKUP_FAILED";
/// A store migration failed. The pre-migration copy was restored when possible; the message says
/// which happened and where both files are. Raised only on the start-up path.
pub(crate) const STORE_MIGRATION_FAILED: &str = "STORE_MIGRATION_FAILED";
pub(crate) const CREDENTIAL_STORE_UNAVAILABLE: &str = "CREDENTIAL_STORE_UNAVAILABLE";
pub(crate) const INVALID_INPUT: &str = "INVALID_INPUT";
/// The address was well-formed, but the operating system refused to hand it to a browser: the
/// shell verb failed (`services::system_open`). Raised on this side only, at the one command that
/// opens addresses and at the engine's own `open_url` request.
pub(crate) const EXTERNAL_OPEN_FAILED: &str = "EXTERNAL_OPEN_FAILED";
/// The host refused a branch before rewriting anything: the engine's `session_before_branch` event
/// is cancellable, and an installed hook (the engine's own `git-checkpoint` example is one) can
/// decline it. Nothing was written, so the caller keeps the conversation it had.
pub(crate) const BRANCH_CANCELLED: &str = "branch_cancelled";
/// The open-in-app id names no application this build offers on this platform.
pub(crate) const OPEN_IN_APP_UNKNOWN: &str = "OPEN_IN_APP_UNKNOWN";
/// The application was found, but launching it (or extracting its icon) failed.
pub(crate) const OPEN_IN_APP_FAILED: &str = "OPEN_IN_APP_FAILED";
/// A restart was asked for while no downloaded update was waiting. Raised on this side
/// only: the state that earns a restart is the one the update service published.
pub(crate) const UPDATE_NOT_READY: &str = "UPDATE_NOT_READY";
pub(crate) const CUSTOM_PROVIDER_INVALID: &str = "CUSTOM_PROVIDER_INVALID";
pub(crate) const CUSTOM_PROVIDER_FETCH_FAILED: &str = "CUSTOM_PROVIDER_FETCH_FAILED";
pub(crate) const CUSTOM_PROVIDER_MODELS_EMPTY: &str = "CUSTOM_PROVIDER_MODELS_EMPTY";
/// A plugin that runs code inside the agent process was asked to be enabled before the user
/// confirmed it. Raised on this side only (`services::plugins::validate::consent_block`), because
/// the answer it turns on - has this user agreed - is this application's own record.
pub(crate) const PLUGIN_CONSENT_REQUIRED: &str = "PLUGIN_CONSENT_REQUIRED";
/// A plugin installation that would run code without a confirmation could not be switched off: the
/// disable came back without an error and the row is still enabled, so the caller is told what
/// actually failed - the installation could not be stopped - rather than that a confirmation is
/// missing, which is an answer the user could give. Raised on this side only
/// (`services::plugins::consent_flow::{quarantine_unconfirmed, set_grant}`), because disabling a
/// plugin and reading the row back is this application's own write.
pub(crate) const PLUGIN_DISABLE_FAILED: &str = "PLUGIN_DISABLE_FAILED";
/// The plugin the caller named is not installed in the workspace it named. Restates the host's
/// `plugin_not_found` (`services::plugins::map_host_error`), so the frontend branches on one
/// spelling; the host's message travels unchanged.
pub(crate) const PLUGIN_NOT_FOUND: &str = "PLUGIN_NOT_FOUND";
/// The install source is not one the engine accepts: a marketplace entry, npm spec or path that
/// names nothing. Restates the host's `plugin_invalid_spec`.
pub(crate) const PLUGIN_INVALID_SPEC: &str = "PLUGIN_INVALID_SPEC";
/// The install or upgrade itself failed - the network, the download, the unpack. Restates the
/// host's `plugin_install_failed`.
pub(crate) const PLUGIN_INSTALL_FAILED: &str = "PLUGIN_INSTALL_FAILED";
/// An install could not even be attempted, because an external tool it runs on - the engine's own
/// runtime, a repository fetch, the npm registry - is missing or unusable on this machine.
/// Restates the host's `plugin_install_unavailable`, which the host raises instead of
/// `plugin_install_failed` so the page can name the missing tool rather than report the plugin as
/// broken.
pub(crate) const PLUGIN_INSTALL_UNAVAILABLE: &str = "PLUGIN_INSTALL_UNAVAILABLE";
/// A plugin asked for something the desktop does not grant without permission. Registered now
/// because the codes are part of the frozen IPC contract and the host registers the same token
/// (`host/src/protocol/errors.ts`); P1 raises it from neither side, and the host's own
/// `plugin_permission_required` is restated into it if a later host sends one.
pub(crate) const PLUGIN_PERMISSION_REQUIRED: &str = "PLUGIN_PERMISSION_REQUIRED";
/// The package file the user picked is not one this application can install: it is not a readable
/// archive, it breaks one of the unpacking guards (path escape, links, entry count, unpacked size),
/// its checksums do not match, or its manifest declares no usable plugin name. Raised on this side
/// only (`services::plugins::package`), because unpacking a package file is this application's own
/// work - the engine is handed a normal marketplace catalogue afterwards (spec §2.3).
pub(crate) const PLUGIN_PACKAGE_INVALID: &str = "PLUGIN_PACKAGE_INVALID";
/// The path the caller handed the package import is not one this application will read: empty, not
/// absolute, not a file, or not a package suffix. Raised by the same layer as
/// [`PLUGIN_PACKAGE_INVALID`] and kept apart from it because the two ask the caller to fix different
/// things - which file was named, versus what is inside it.
pub(crate) const INVALID_PACKAGE_PATH: &str = "INVALID_PACKAGE_PATH";
/// One package could not be fetched from the URL the user pasted: the address was refused (not
/// `https`, a redirect that left it, more hops than this build follows), the download failed or
/// exceeded its ceiling, or the bytes did not hash to the checksum the caller declared. Raised on
/// this side only (`services::plugins::download`), because the download is this application's own
/// work - the engine is handed a normal package file afterwards (spec §2.2, R3 §2.2). Kept apart
/// from [`PLUGIN_INSTALL_FAILED`], which is the engine's answer about the work *it* ran: this one
/// says nothing was ever unpacked.
pub(crate) const PLUGIN_DOWNLOAD_FAILED: &str = "PLUGIN_DOWNLOAD_FAILED";
/// A built-in plugin could not be restored, because this build has no readable copy of it to seed:
/// the bundled catalogue is missing, or its manifest declares no usable package name or version.
/// Raised on this side only (`services::plugins::builtin`), and kept apart from the seed's own
/// silence about a missing bundle - a restore is a user action, so it is told why nothing was
/// restored rather than answered with a list that quietly did not change. The same code answers the
/// scaffold command when a template this build ships cannot be read: both are "this build does not
/// have the copy it ships", which is not the caller's input to fix.
pub(crate) const PLUGIN_BUILTIN_UNAVAILABLE: &str = "PLUGIN_BUILTIN_UNAVAILABLE";
/// A write that would remove a plugin this application ships with: switching it off, or
/// uninstalling it. Built-in plugins are the application's own surfaces - the terminal's tab and
/// the skills it carries - so the plugin is not the user's to remove: switching it off would take
/// away a feature the build promises. Their controls are disabled in the page, and this code
/// answers a write that arrives anyway (an older caller, a shortcut, a stale list).
pub(crate) const PLUGIN_BUILTIN_PROTECTED: &str = "PLUGIN_BUILTIN_PROTECTED";
/// The caller asked to restore something that is not the plugin this application ships with. Raised
/// on this side only (`services::plugins::builtin`): the restore route seeds one fixed installation,
/// so an id it does not ship is refused rather than silently seeding whatever the caller named.
pub(crate) const PLUGIN_BUILTIN_UNKNOWN: &str = "PLUGIN_BUILTIN_UNKNOWN";
/// A removal of the marketplace this application's built-in plugins are published from was refused,
/// because the row really points at the bundle this application shipped with. Kept apart from the
/// codes about the installation itself because the two ask the user to do different things: this
/// one is about a catalogue that is simply not theirs to remove (and which is deliberately removable
/// when it holds the reserved name against somebody else's source,
/// `services::plugins::builtin`).
pub(crate) const PLUGIN_MARKETPLACE_RESERVED: &str = "PLUGIN_MARKETPLACE_RESERVED";
/// A direct install of a reserved built-in installation spec was refused: that installation is
/// seeded by the application itself, and an install is a write the engine is free to enable, so this
/// route could replace it or re-enable a copy the user switched off. The installation cannot be
/// installed by hand either: it is the application's (`PLUGIN_BUILTIN_PROTECTED`).
pub(crate) const PLUGIN_INSTALL_RESERVED: &str = "PLUGIN_INSTALL_RESERVED";
/// A page a plugin contributes could not be opened or served: the installation is disabled, the
/// panel it names is not one it declares, its entry is not a path this build will load, or the
/// plugin-window ceiling is reached. Raised on this side only (`services::plugins::{pages,panels}`),
/// because what a page may load and how many windows may exist are this application's rules - the
/// manifest that declared the page was already validated by the host.
pub(crate) const PLUGIN_PAGE_UNAVAILABLE: &str = "PLUGIN_PAGE_UNAVAILABLE";
/// A theme's declared stylesheet could not be applied: the file is missing or unreadable, over its
/// byte ceiling, not UTF-8, not CSS this build can sanitise (an `@import`, a script door, an
/// unbalanced construct, a control character), or a `url()` in it naming something the theme did not
/// declare. Raised on this side only (`services::plugins::theme_css`), because reading and cleaning
/// the bytes is this application's own work - the manifest that declared the file was already
/// validated by the host.
///
/// It is a *per-theme* refusal, not a failed command: the theme keeps its tokens, the plugin keeps
/// its pages, and the row carries the short reason token (`theme_css_invalid`) beside the log line
/// this constant names.
pub(crate) const PLUGIN_THEME_CSS_INVALID: &str = "PLUGIN_THEME_CSS_INVALID";
/// A switch-source update did not happen: the two-step move (uninstall, then install from the new
/// marketplace) failed, and the message says whether the previous installation was put back or the
/// plugin is now uninstalled. Raised on this side only (`services::plugins::switch`), because the
/// engine cannot move a plugin between marketplaces at all - `upgradePlugin` reinstalls within one
/// `name@marketplace` - so the sequence is this application's own work and its failure is its own
/// answer. The confirmation record is kept either way: a plugin installed again from any source is
/// still the plugin the user confirmed (`plugin_grants.plugin_id` is the plugin id, store v9).
pub(crate) const PLUGIN_UPDATE_SWITCH_FAILED: &str = "PLUGIN_UPDATE_SWITCH_FAILED";
/// No process may run for the installation the caller named: the row declares no `omp.desktop.main`,
/// this build refuses it one (`plugin_process_permission_missing` /
/// `plugin_process_builtin_unverified` on the row), the installation is disabled, or the engine host
/// artifact a worker is launched from could not be located and verified. Raised on this side only
/// (`services::plugins::process`): whether a resident process may run is the supervisor's judgement,
/// not the manifest's, and the page only renders what this side decided.
pub(crate) const PLUGIN_PROCESS_UNAVAILABLE: &str = "PLUGIN_PROCESS_UNAVAILABLE";
/// The installation's process is in its terminal `crashed` state - it exited unexpectedly and used up
/// its restart budget, or a call timed out and it was stopped - so nothing is sent to it until the
/// reader presses "restart" (plan §6.4). Never answered by silently starting another one: a plugin is
/// not disabled by a crash, and a crash is not retried past its limit.
pub(crate) const PLUGIN_PROCESS_CRASHED: &str = "PLUGIN_PROCESS_CRASHED";
/// The worker that answered speaks another `PLUGIN_WORKER_PROTOCOL` than this build, so it was
/// stopped and the installation's process is `crashed` (`plugin.process.protocol_mismatch` in the
/// log and on the row). Kept apart from [`PLUGIN_PROCESS_CRASHED`] because the two ask different
/// things of the reader: one is a package that has to be reinstalled against this build, the other
/// is a process to restart.
pub(crate) const PLUGIN_PROCESS_PROTOCOL_MISMATCH: &str = "PLUGIN_PROCESS_PROTOCOL_MISMATCH";
/// A slot component asked for an action or a `plugin.call` method the manifest did not declare
/// (plan §7.3). Well-formed and in the vocabulary, but outside the two whitelists the row carries:
/// the manifest is the authority on what its own module may reach, and this is the answer that says
/// the request was understood and refused (`services::plugins::renderer::method_refusal`).
pub(crate) const PLUGIN_ACTION_UNDECLARED: &str = "PLUGIN_ACTION_UNDECLARED";
/// A slot component asked for a dispatch the vocabulary does not contain at all: a word that is not
/// a method name, or an action token this build never serves. Kept apart from
/// [`PLUGIN_ACTION_UNDECLARED`] because the two say different things to an author - "declare it" is
/// possible for one, and the other is a spelling this build will never accept.
pub(crate) const PLUGIN_ACTION_UNKNOWN: &str = "PLUGIN_ACTION_UNKNOWN";
/// A long operation the user asked to stop (`services::tasks`): raised at the next step boundary, so
/// nothing it had already changed is half-changed.
pub(crate) const TASK_CANCELLED: &str = "task_cancelled";
/// The blocking task behind a diagnostics command (reading or clearing the logs and caches) could
/// not be joined, which means that thread panicked. Raised on this side only
/// (`commands::diagnostics`).
pub(crate) const DIAGNOSTICS_TASK_FAILED: &str = "DIAGNOSTICS_TASK_FAILED";
/// The strip's tool menu popup window could not be created or its anchor could not be measured.
/// The terminal the caller named is not one this process holds: the shell exited on its own, the
/// tab was closed, or the id was never one this run handed out. Raised on this side only
/// (`services::terminal`), and answered to the agent's own tool as well as to the page - both
/// address a terminal by the id the desktop issued.
pub(crate) const TERMINAL_NOT_FOUND: &str = "TERMINAL_NOT_FOUND";
/// A live terminal could not be written to or read: the pty refused, or the input was over this
/// build's ceiling. Kept apart from [`TERMINAL_NOT_FOUND`] because the two ask the caller to do
/// different things - list the terminals again, versus stop sending what was refused.
pub(crate) const TERMINAL_FAILED: &str = "TERMINAL_FAILED";
/// The built-in browser is not available: its plugin is not served, no window can host a guest, or
/// the tab the caller named has been closed. Raised by `services::browser` and the host's browser
/// lane, and reported to the model as the tool's own refusal.
pub(crate) const BROWSER_UNAVAILABLE: &str = "BROWSER_UNAVAILABLE";
/// This platform has no in-process DevTools channel for a guest page (`Browser`'s CDP actions).
pub(crate) const BROWSER_UNSUPPORTED: &str = "BROWSER_UNSUPPORTED";
/// One page's console buffer is past what a single read carries, so it is refused rather than
/// reported as empty (a page is free to log a megabyte in one line).
pub(crate) const BROWSER_CONSOLE_TOO_LARGE: &str = "BROWSER_CONSOLE_TOO_LARGE";

#[derive(Debug, Clone, Serialize)]
pub(crate) struct IpcError {
    pub(crate) code: Cow<'static, str>,
    pub(crate) message: String,
}

impl IpcError {
    pub(crate) fn new(code: &'static str, message: &'static str) -> Self {
        Self {
            code: Cow::Borrowed(code),
            message: message.to_owned(),
        }
    }

    pub(crate) fn from_message(code: &'static str, message: String) -> Self {
        Self {
            code: Cow::Borrowed(code),
            message,
        }
    }

    /// Maps an engine response failure onto an IPC error. The engine's own `code`
    /// (`session_busy`, `stale_cursor`, ...) is passed through when it is a plain
    /// machine token, so the frontend can branch on it without matching message text.
    pub(crate) fn from_engine(code: Option<&str>, message: String) -> Self {
        let code = match code {
            Some(value) if is_machine_code(value) => Cow::Owned(value.to_owned()),
            _ => Cow::Borrowed(ENGINE_REQUEST_FAILED),
        };
        Self { code, message }
    }
}

fn is_machine_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 40
        && value.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
        })
}

pub(crate) type IpcResult<T> = Result<T, IpcError>;

#[cfg(test)]
mod tests {
    use super::*;

    /// A rejected command must stay distinguishable from a dead or slow engine: the
    /// frontend relies on the code, not on the message text.
    #[test]
    fn engine_failures_keep_a_machine_code_or_fall_back() {
        assert_eq!(
            IpcError::from_engine(Some("session_busy"), "busy".to_owned()).code,
            "session_busy"
        );
        assert_eq!(
            IpcError::from_engine(Some("stale_cursor"), "stale".to_owned()).code,
            "stale_cursor"
        );

        let rejected = IpcError::from_engine(None, "The session header is malformed.".to_owned());
        assert_eq!(rejected.code, ENGINE_REQUEST_FAILED);
        assert_ne!(rejected.code, HOST_EXITED);
        assert_ne!(rejected.code, TIMEOUT);

        // Engine text never becomes a code.
        assert_eq!(
            IpcError::from_engine(Some("Not A Code"), "x".to_owned()).code,
            ENGINE_REQUEST_FAILED
        );
    }
}
