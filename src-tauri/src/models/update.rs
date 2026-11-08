use serde::Serialize;

/// Where the application's own update check stands.
///
/// A closed vocabulary this repository owns: the front end switches on it exhaustively, so a new
/// phase is a compile error there until it is drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum UpdatePhase {
    /// Nothing has been asked yet, or the last answer was forgotten.
    Idle,
    /// A development build: it has no installed copy to update.
    Unsupported,
    /// A check is in flight.
    Checking,
    /// The feed answered, and the running build is the newest one.
    Current,
    /// The feed announced a strictly newer version.
    Available,
    /// That version's installer is being downloaded.
    Downloading,
    /// It is downloaded, verified, and waiting for a restart.
    Ready,
    /// The last check or download failed; `error` says how.
    Error,
}

/// What the shell reports about an update, as one whole value.
///
/// The service publishes a complete status on every transition rather than a diff, so a reader that
/// subscribed late and a reader that saw every event draw the same thing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateStatus {
    pub(crate) phase: UpdatePhase,
    /// The announced version, while there is one to name.
    pub(crate) version: Option<String>,
    /// The release notes the feed carried, capped by the service.
    pub(crate) notes: Option<String>,
    /// Whole percent while a download's total is known, `None` while it is not.
    pub(crate) progress: Option<u8>,
    /// The failure's own words; present only with [`UpdatePhase::Error`].
    pub(crate) error: Option<String>,
}

impl UpdateStatus {
    pub(crate) fn idle() -> Self {
        Self {
            phase: UpdatePhase::Idle,
            version: None,
            notes: None,
            progress: None,
            error: None,
        }
    }

    /// A status that names a phase and nothing else.
    pub(crate) fn phase(phase: UpdatePhase) -> Self {
        Self {
            phase,
            version: None,
            notes: None,
            progress: None,
            error: None,
        }
    }
}
