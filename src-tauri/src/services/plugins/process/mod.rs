//! The resident plugin processes: what one installation's JavaScript is, who may start it, and the
//! table the page renders (`rules.md#plugin-system`).
//!
//! A plugin with `omp.desktop.main` is not a document this process serves; it is a *program* that
//! runs beside this application, in its own child process, and reaches the desktop only through the
//! frames this module relays. The split is the same one the rest of the plugin domain uses:
//!
//! - [`PluginProcess`] (in `supervise.rs`) owns the children - one per installation, at most
//!   [`MAX_LIVE_PROCESSES`] live, each with its own handshake, budgets, crash budget and stop path.
//!   It is a process-level singleton in `AppState`, so the table survives every page and every
//!   workspace switch, and the application's own exit is what ends it.
//! - `api.rs` answers the one thing a worker may ask for (`worker_invoke`): the *same* gates the
//!   bridge applies to a plugin page (`services::plugins::bridge`, `gates`, `net`, `grants`), never a
//!   second permission table.
//! - `frames.rs` is the wire format, and nothing else.
//!
//! This file holds the vocabulary the three share: the protocol constants (mirrored from
//! `host/src/constants.ts`, because the two halves must refuse the same bytes and the same versions),
//! the row facts one process is started from, the supervisor's answer shape, and the availability
//! rule. The rule is here rather than in the page because it is a *decision*: a built-in this
//! application verified may run without the permission, a third-party installation needs the
//! declaration **and** the user's confirmation recorded for it, and an installation that spells a
//! reserved id without having come from the verified bundle gets neither. A page that decided this
//! for itself would be a second authority over the same question (`rules.md#plugin-system`).

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

use crate::models::plugins::{identity, EngineDesktopBlock, EnginePluginRow};
use crate::services::plugins::builtin;
use crate::services::plugins::pages::{FsScopes, PageGrants};

mod api;
mod frames;
mod supervise;
#[cfg(test)]
mod tests;

pub(crate) use supervise::PluginProcess;

// ---- the protocol (mirrored from `host/src/constants.ts`) ----

/// The worker protocol this build speaks (`PLUGIN_WORKER_PROTOCOL`).
///
/// A worker that advertises another version is refused rather than driven: the two halves agree on
/// the frame vocabulary as a whole, and a number that differs is the only advance warning this side
/// gets that it would be speaking a language the other does not know
/// (`plugin.process.protocol_mismatch`, plan §8.1).
pub(crate) const WORKER_PROTOCOL: u32 = 1;

/// How many installations may have a live process at once (plan §6.4).
///
/// Owner: [`PluginProcess`]. Limit: this many `starting`/`running` children. Release: the
/// least-recently-used live installation is stopped (unload, then kill) before the next one starts -
/// one child per installation is the invariant, and this is the ceiling on installations running at
/// the same moment.
pub(crate) const MAX_LIVE_PROCESSES: usize = 16;

/// How many times one process is restarted after crashing before it stays `crashed` (plan §6.4).
///
/// Each restart doubles the wait between [`BACKOFF_FIRST`] and [`BACKOFF_MAX`]; the count resets when
/// a process has stayed alive for [`SURVIVAL_RESET`] (a plugin that worked for a minute and then died
/// is a new crash, not the sixth of a burst), and a manual restart resets it too. A package whose
/// manifest turns the restarts off (`omp.desktop.autoRestart: false`) is not restarted at all: it
/// goes straight to `crashed` and waits for the reader. Nothing here ever disables the plugin - a
/// crash is a process state, and the user's switch is theirs to move.
pub(crate) const MAX_RESTARTS: u32 = 5;

/// The first wait after a crash (1 s), doubled per restart: 1, 2, 4, 8, 16 seconds.
///
/// A crash is usually a plugin that cannot start, so the sequence starts slow enough that a broken
/// package is not respawned in a tight loop while the user reads the reason.
pub(crate) const BACKOFF_FIRST: Duration = Duration::from_secs(1);

/// The longest wait between two restarts (30 s): the doubling stops here.
///
/// With [`MAX_RESTARTS`] at five the sequence never reaches it (16 s is the last wait); the ceiling
/// exists so the formula stays a formula - a build that raised the count would not multiply its way
/// to an hour.
pub(crate) const BACKOFF_MAX: Duration = Duration::from_secs(30);

/// How long a process has to stay alive for its crash budget to be forgotten.
///
/// A plugin that ran for a minute and then died crashed *once* - it did not fail to start. Without
/// this reset a plugin that crashes once a day would spend its five restarts across a week and then
/// keep failing until the reader noticed.
pub(crate) const SURVIVAL_RESET: Duration = Duration::from_secs(60);

/// How long the start waits for `worker_hello` (a package that resolved, loaded and ran `onLoad`).
pub(crate) const LOAD_TIMEOUT: Duration = Duration::from_secs(15);

/// How long a graceful stop waits for `worker_unload` to be answered before the child is killed.
pub(crate) const UNLOAD_TIMEOUT: Duration = Duration::from_secs(5);

/// How long one `worker_call` waits for its `worker_result`.
///
/// A call that runs past it is the plugin not answering rather than the call being slow: the process
/// is stopped (`plugin.process.timeout`) and the installation stays `crashed` until the reader
/// restarts it, which is the same posture as the host's own request budget (`rules.md#implementation-requirements`).
pub(crate) const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// How many `worker_invoke` calls may be waiting for an answer at once (`PLUGIN_WORKER_MAX_PENDING_INVOKES`).
///
/// Owner: one worker process. Limit: unanswered invokes it has sent. Release: each answer, written
/// or refused, gives one slot back; the process ending drops the table. Past it the invoke is
/// refused (`too_many_requests`) instead of queued - a plugin's own pace is not this side's to
/// buffer.
pub(crate) const MAX_PENDING_INVOKES: usize = 64;

/// How many invokes one process may send inside [`INVOKE_WINDOW`] (`PLUGIN_WORKER_INVOKES_PER_SECOND`).
pub(crate) const MAX_INVOKES_PER_SECOND: usize = 200;

/// The rolling window the invoke rate is counted over.
pub(crate) const INVOKE_WINDOW: Duration = Duration::from_secs(1);

/// How many `worker_call`s may be waiting for their `worker_result` at once.
///
/// Owner: one worker process. Limit: this many outstanding calls, which is also the number of
/// dispatch threads a worker can have. Release: each answer, timeout or process exit. A caller past
/// the limit is refused (`too_many_requests`) rather than queued without end (`rules.md#resource-bounds-and-release-points`).
pub(crate) const MAX_PENDING_CALLS: usize = 64;

/// How many command ids one installation may have registered at run time (`PLUGIN_DESKTOP_COMMANDS_MAX`).
///
/// Owner: one installation's process. Limit: this many ids. Release: an `unregister`, a stop, or an
/// upgrade (the process's registry is the worker's own, and it goes with the process).
pub(crate) const MAX_REGISTERED_COMMANDS: usize = 32;

/// The activation event that asks for a live process as soon as the application is (plan §6.1).
///
/// The three families this build implements are `onStartup`, `onCommand:<id>` and `onView:<id>`;
/// the host drops every other spelling (`host/src/plugins-desktop-process.ts`), so a declared list is
/// already limited to these. Only the first two are spelled here: a view event is built by the page
/// that became visible (`onView:<entryId>`) and validated against the declaration, so this side never
/// composes one.
pub(crate) const ACTIVATION_STARTUP: &str = "onStartup";

/// The prefix of a command's activation event: the load frame names the command that woke it.
pub(crate) const ACTIVATION_COMMAND_PREFIX: &str = "onCommand:";

/// A plugin needs this declared to run a process, unless it is a verified built-in (plan §6.1).
pub(crate) const PROCESS_PERMISSION: &str = "plugin.process";

/// A plugin needs this declared to add commands of its own to the palette (plan §6.1).
pub(crate) const COMMAND_PERMISSION: &str = "command.register";

/// The view permission the two `ui.*` calls need (the block's own rule for views, spec §3.2).
pub(crate) const VIEW_PERMISSION: &str = "ui.view";

/// The row's refusal tokens, worded by the page (`src/settings/sections/plugins/process-copy.ts`).
pub(crate) const UNAVAILABLE_PERMISSION_MISSING: &str = "plugin_process_permission_missing";
pub(crate) const UNAVAILABLE_BUILTIN_UNVERIFIED: &str = "plugin_process_builtin_unverified";

/// The crash reasons a crashed row carries, worded by the page (same file).
pub(crate) const REASON_CRASHED: &str = "plugin.process.crashed";
pub(crate) const REASON_TIMEOUT: &str = "plugin.process.timeout";
pub(crate) const REASON_PROTOCOL_MISMATCH: &str = "plugin.process.protocol_mismatch";

/// The audit/log line the protocol mismatch leaves (`plugin.process.protocol_mismatch`).
pub(crate) const PROTOCOL_MISMATCH_LOG: &str = "plugin.process.protocol_mismatch";

// ---- the supervisor's vocabulary ----

/// One installation's process state (plan §6.4). There is no `disabled`: a crash never switches a
/// plugin off, so the plugin's own enabled state is the row's, not this table's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProcessState {
    /// Nothing is running and nothing is scheduled to start.
    Stopped,
    /// A child exists but has not answered `worker_hello` yet.
    Starting,
    /// The worker is live: `onLoad` returned and frames are being exchanged.
    Running,
    /// The process ended without being asked to, and either used up its restarts or failed in a way
    /// a retry cannot fix (a protocol mismatch, a timeout, a startup refusal). Manual restart only.
    Crashed,
}

impl ProcessState {
    pub(crate) fn token(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Crashed => "crashed",
        }
    }

    /// Whether a child exists in this state (the two states that count against the live ceiling).
    pub(crate) fn is_live(self) -> bool {
        matches!(self, Self::Starting | Self::Running)
    }
}

/// One command the manifest contributes, as the supervisor checks an execution against it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InstallCommand {
    pub(crate) id: String,
}

/// One installation as the supervisor needs it: everything a child is spawned with, everything the
/// gates judge by, and the workspace the process was published for.
///
/// It is a *snapshot* of one plugin list read rather than a row this table keeps alive: the list is
/// read again on every settings visit, and a process must be driven by the facts that were true when
/// it was published (a later list replaces the descriptor, which is also what stops a process whose
/// package changed under it).
#[derive(Debug, Clone)]
pub(crate) struct ProcessInstall {
    /// The engine's handle (`name@marketplace`, or the package name for an npm/link install): the
    /// supervisor keys by it together with the scope.
    pub(crate) install: String,
    pub(crate) plugin_id: String,
    pub(crate) name: String,
    pub(crate) scope: String,
    pub(crate) root: PathBuf,
    /// The commands the manifest contributes (the palette's static half; the worker registers the
    /// handlers at load time).
    pub(crate) commands: Vec<InstallCommand>,
    /// The activation events the manifest declares (`omp.desktop.activationEvents`, plan §6.1), as
    /// the host forwarded them: `onStartup`, `onCommand:<id>`, `onView:<id>`. Carried beside
    /// `commands` for the same reason - a wake-up event must be judged against the declaration the
    /// row was published from, not against a plugin list read per call.
    pub(crate) activation_events: Vec<String>,
    /// The methods its slot module may reach through `plugin.call` (`omp.desktop.rendererCallMethods`,
    /// plan §7.1), as the block this side re-checked declared them.
    ///
    /// Carried beside `commands` for the same reason: a renderer click must be judged against the
    /// declaration the row was published from, not against a plugin list read per call. Empty for an
    /// installation with no slot module - and then no method is declared, which refuses rather than
    /// guesses.
    pub(crate) renderer_call_methods: Vec<String>,
    /// What the installation's pages may ask the bridge for - the *same* table the worker's calls
    /// are judged by (`services::plugins::bridge`), taken from the block this side re-checked.
    pub(crate) grants: PageGrants,
    /// The engine's own enabled state when the descriptor was published.
    pub(crate) enabled: bool,
    /// The workspace the process belongs to: a project-scope installation is only addressable from
    /// the project it lives in, and its settings are the engine's settings *for that workspace*.
    pub(crate) workspace: Option<PathBuf>,
    /// Whether this installation wants its process restarted after a crash (`omp.desktop.autoRestart`).
    ///
    /// The one thing about the crash budget a manifest may decide: a plugin that knows it cannot be
    /// restarted in place (it holds a lock, it wrote an incomplete file) says so and goes straight to
    /// `crashed`, where the reader's own restart still works. Absent means `true`.
    pub(crate) auto_restart: bool,
    /// What a package change looks like: the version together with the entry. An upgrade keeps id,
    /// scope and enabled state, so this is the only thing a restart can be detected by.
    pub(crate) revision: String,
}

impl ProcessInstall {
    /// The origin key the page registry and the session grants use for this installation.
    pub(crate) fn key(&self) -> String {
        crate::services::plugins::pages::origin_key(&self.plugin_id, &self.scope)
    }

    /// Whether this installation asks to be live as soon as the application is (`onStartup`).
    ///
    /// A descriptor only exists for an installation a process may run for at all - `install_of`
    /// returns none without a `main`, without the permission or without the recorded confirmation -
    /// so this answers the last two facts: the engine runs the plugin, and the manifest lists the
    /// event. "Listed" is exact: the host has already dropped every spelling it does not know, and a
    /// near miss here would be this side inventing an event.
    pub(crate) fn wants_startup(&self) -> bool {
        self.enabled
            && self
                .activation_events
                .iter()
                .any(|event| event == ACTIVATION_STARTUP)
    }

    /// Whether this installation may be woken for `event`: the manifest has to list it.
    ///
    /// Used by the explicit activation call (`PluginProcess::activate`), which is how a view event
    /// (`onView:<entryId>`) wakes a process: the page that became visible names the event, and only a
    /// declaration the package made may act on it.
    pub(crate) fn declares(&self, event: &str) -> bool {
        self.activation_events
            .iter()
            .any(|declared| declared == event)
    }

    /// Whether this installation is the workspace's project scope, which needs a workspace to be
    /// addressable at all.
    pub(crate) fn is_project(&self) -> bool {
        self.scope == "project"
    }
}

/// Whether one installation may run a process, or the token that says why it may not.
///
/// The three answers are the plan's own (§6.1, D3): a *verified* built-in (`row.builtin`, which only
/// `services::plugins::builtin` sets after reading the reserved marketplace's source) is the
/// application's own surface and needs no manifest name for it; an installation that *spells* a
/// built-in id without that verification is refused, because a package can choose its own name; and
/// anything else needs `plugin.process` declared **and** the user's confirmation recorded for that
/// installation.
pub(crate) fn availability(
    builtin: bool,
    plugin_id: &str,
    declared: bool,
    granted: bool,
) -> Result<(), &'static str> {
    if builtin {
        return Ok(());
    }
    if builtin::is_builtin_plugin(plugin_id) {
        return Err(UNAVAILABLE_BUILTIN_UNVERIFIED);
    }
    if !declared || !granted {
        return Err(UNAVAILABLE_PERMISSION_MISSING);
    }
    Ok(())
}

/// One host row as a process descriptor, or `None` when the row asks for no process or may not run
/// one.
///
/// `checked` is the block this side re-read (`models::plugins::recheck_desktop`), because its
/// verdict - and its cleaned `net.domains`/`fsScopes` - is what the worker's calls are judged by. A
/// block the re-check refused contributes nothing: half a block is not a reach, and a process is the
/// most reach a manifest can ask for.
pub(crate) fn install_of(
    row: &EnginePluginRow,
    checked: Option<&EngineDesktopBlock>,
    granted: bool,
    workspace: Option<&Path>,
) -> Option<ProcessInstall> {
    let block = checked.filter(|block| block.valid)?;
    let process = block.process.as_ref()?;
    let main = process.main.as_deref()?.trim();
    if main.is_empty() {
        return None;
    }
    let plugin_id = identity::plugin_id(row);
    let declared = block
        .permissions
        .iter()
        .any(|name| name == PROCESS_PERMISSION);
    availability(row.builtin, plugin_id.as_ref(), declared, granted).ok()?;
    let root = row.root_path.as_deref().map(str::trim)?;
    if root.is_empty() {
        return None;
    }
    Some(ProcessInstall {
        install: identity::install_spec(row).to_owned(),
        plugin_id: plugin_id.into_owned(),
        name: row.name.clone(),
        scope: row.scope.clone(),
        root: PathBuf::from(root),
        commands: process
            .commands
            .iter()
            .filter(|command| !command.id.trim().is_empty())
            .map(|command| InstallCommand {
                id: command.id.clone(),
            })
            .collect(),
        activation_events: process.activation_events.clone(),
        renderer_call_methods: block
            .renderer
            .as_ref()
            .map(|renderer| renderer.call_methods.clone())
            .unwrap_or_default(),
        grants: PageGrants {
            permissions: block.permissions.clone(),
            fs_scopes: FsScopes {
                read: block.fs_scopes.read.clone(),
                write: block.fs_scopes.write.clone(),
                delete: block.fs_scopes.delete.clone(),
            },
            net_domains: block.net_domains.clone(),
            // A resident process is held to the same two keys a page is (`PageGrants::net_policy`):
            // this is the block's flag, and the permission beside it is checked there.
            net_any_host: block.net_any_host,
            // These grants are the resident process's, which is the one surface with a channel this
            // application can call into (`bridge::capabilities::judge_bus_subscribe`).
            resident: true,
        },
        enabled: row.enabled,
        workspace: workspace.map(Path::to_path_buf),
        auto_restart: process.auto_restart,
        revision: format!("{}\u{0}{main}", row.version.as_deref().unwrap_or_default()),
    })
}

// ---- the answer shape ----

/// One worker answer: `{ ok, value?, code?, message? }` (`rules.md#plugin-system`).
///
/// A refusal carries the code the plugin branches on - the bridge's own tokens for a gate
/// (`permission_denied`, `out_of_scope`, ...), the worker's for its own (`not_found`,
/// `unknown_method`, ...), this side's for a process that cannot be called
/// (`PLUGIN_PROCESS_UNAVAILABLE`, ...). The three vocabularies are deliberate: each names the party
/// that refused, and the frontend shows the code rather than re-deriving a reason from a sentence.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Settlement {
    pub(crate) ok: bool,
    pub(crate) value: Option<Value>,
    pub(crate) code: Option<String>,
    pub(crate) message: Option<String>,
}

impl Settlement {
    /// The answer a successful call carries; `value` is whatever the worker returned.
    pub(crate) fn ok(value: Value) -> Self {
        Self {
            ok: true,
            value: Some(value),
            code: None,
            message: None,
        }
    }

    /// The answer a refused call carries.
    pub(crate) fn refused(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            value: None,
            code: Some(code.into()),
            message: Some(message.into()),
        }
    }
}

/// Locks a mutex, treating a poisoned one as usable: every holder mutates one small map and nothing
/// a previous holder could have left half-written is read as a fact.
pub(super) fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The wait before restart number `restarts` (already performed), or `None` when the budget is spent.
///
/// The sequence is 1, 2, 4, 8 and 16 seconds and then nothing: the fifth crash after the first start
/// leaves the process `crashed` until a reader restarts it by hand, which is the plan's own bound
/// (§6.4) and what stops a package that cannot start from being respawned forever. Two things reset
/// the count - a manual restart, and a process that stayed alive for [`SURVIVAL_RESET`] - so the
/// sequence starts over from 1 s rather than accumulating across days.
pub(crate) fn backoff_delay(restarts: u32) -> Option<Duration> {
    if restarts >= MAX_RESTARTS {
        return None;
    }
    let delay = BACKOFF_FIRST.saturating_mul(1u32.checked_shl(restarts).unwrap_or(u32::MAX));
    Some(delay.min(BACKOFF_MAX))
}
