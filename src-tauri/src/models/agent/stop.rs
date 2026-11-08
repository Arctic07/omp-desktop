//! What a session's stop reports: the jobs it still runs in the background, and the outcome of
//! asking it to stop.
//!
//! Split out of [`super`] when the state shape outgrew one file (`rules.md#single-file-line-limit`), the same way
//! [`super::work`] was. The three records belong together because they are read together: the
//! state frame carries the running jobs, and the two stop verbs answer with what they stopped.
//! Re-exported from [`super`], so every caller still names them through `models::agent`.

use serde::Serialize;

/// One background job the host still runs for a session: an async `bash`, `eval` or `task` the
/// engine accepted and that will deliver its result into the conversation on its own.
///
/// The four fields are the wire contract the frontend declares by name: `type` is the engine's own
/// job kind, `label` is the human-readable line the host gives it, and `startedAt` is epoch
/// milliseconds. Nothing here is interpreted by this side - the host is the one that knows what it
/// started, and this process only carries it to the screen.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct BackgroundJob {
    pub(crate) id: String,
    #[serde(rename = "type")]
    pub(crate) kind: String,
    pub(crate) label: String,
    #[serde(rename = "startedAt")]
    pub(crate) started_at: i64,
}

/// What a session stop actually stopped, and what still reads busy after it.
///
/// The host answers this beside the plain acknowledgement so the frontend can say whether the
/// turn, the background jobs or the children are still there instead of assuming a stop that timed
/// out was a stop that worked. Every count is a fact the host reported; a host that predates the
/// payload answers `{}` and every field here reads its zero/false default.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct AbortOutcome {
    pub(crate) aborted: bool,
    #[serde(rename = "cancelledSubagents")]
    pub(crate) cancelled_subagents: usize,
    #[serde(rename = "cancelledJobs")]
    pub(crate) cancelled_jobs: usize,
    /// What still reads busy after the stop, as stable tokens the frontend localizes
    /// (`turn`, `background`, `children`, `queued`). Empty means the session is idle.
    pub(crate) remaining: Vec<String>,
    /// The reader's own queued input the stop withdrew, oldest first.
    ///
    /// A stop withdraws the engine's queue before aborting, because a queued steer or follow-up is
    /// a turn the engine starts as soon as the abort unwinds. The words travel back here so the
    /// screen can return them to the reader instead of losing input nobody sent.
    pub(crate) restored: Vec<String>,
}

/// What one background job's own stop did.
///
/// `false` is not a failure: the job was already settled, or the id belongs to another conversation
/// — the host checks ownership before it cancels anything, because the job manager is process-wide.
/// What the caller asked for ("this job is over") is true either way, so the answer is a fact about
/// the job rather than an error.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct StopJobOutcome {
    pub(crate) stopped: bool,
}

/// What a forced stop did to a session whose ordinary stop was not enough.
///
/// `session_file` is the transcript the host was asked to leave behind when it had to take the
/// process down; `None` means the host did not name one (an older host, or a stop that did not
/// reach the file).
#[derive(Debug, Clone, Serialize)]
pub(crate) struct ForceStopOutcome {
    pub(crate) forced: bool,
    #[serde(rename = "cancelledSubagents")]
    pub(crate) cancelled_subagents: usize,
    #[serde(rename = "cancelledJobs")]
    pub(crate) cancelled_jobs: usize,
    /// The reader's own queued input the stop withdrew, oldest first (see `AbortOutcome`).
    pub(crate) restored: Vec<String>,
    #[serde(rename = "sessionFile")]
    pub(crate) session_file: Option<String>,
}
