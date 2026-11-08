//! The application's own updates: one fixed feed, a signed installer, and the state the interface
//! shows.
//!
//! Three boundaries are deliberate, and each one is a rule (`rules.md#release-versions-and-publishing`):
//!
//! - **Rust owns the updater.** The webview never names a feed URL, a signature, or an installer;
//!   `tauri-plugin-updater` is registered for this service alone, and no capability grants its
//!   commands to a document. A page can only ask this service to check, install what the feed
//!   announced, or restart into it.
//! - **One feed, one signature.** The endpoint and the public key are `tauri.conf.json`'s, and the
//!   private key never enters the repository. The plugin refuses an artifact whose signature does
//!   not verify, so a compromised download cannot be installed.
//! - **A status is one whole value.** Every transition publishes a complete [`UpdateStatus`], and a
//!   reader that subscribed late reads the same answer through `update_status`; nothing is patched
//!   by the interface.
//!
//! A development build is [`UpdatePhase::Unsupported`]: it has no installed copy to replace, and
//! letting it download an installer would write into an installation it does not own.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::models::update::{UpdatePhase, UpdateStatus};
use crate::services::log;
use crate::services::runtime::truncate_on_char_boundary;

/// The channel every update status travels on. One event per transition, never a diff.
pub(crate) const UPDATE_CHANNEL: &str = "omp:update";

/// How long a check may wait on the feed. The manual path and the automatic one share it: a feed
/// that cannot answer inside twenty seconds is a feed this application does not pin the interface on.
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);

/// How long the installer download may take in total. The check's budget is far too short for a
/// 180 MB installer on a slow connection, and the plugin applies one request timeout to both; this
/// replaces it on the announced update before the download starts.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// The first automatic check runs after the window has settled, not during start-up.
const AUTO_CHECK_DELAY: Duration = Duration::from_secs(15);

/// And then every six hours, which is far more often than a release is cut.
const AUTO_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// How much of a release's notes this application carries. The feed's body is external text and the
/// interface draws it as one paragraph; a whole changelog is a document, not a status line.
const NOTES_LIMIT: usize = 2_000;

/// The update check's state and the two guards that keep one check and one download in flight.
///
/// Owner: the process (`AppState`). Bound: one status, one announced update. Release: with the
/// process; a downloaded update is not persisted, because an installer this process downloaded is
/// re-announced by the same feed on the next start.
pub(crate) struct UpdaterService {
    status: Mutex<UpdateStatus>,
    /// The update the last successful check announced, kept so `install` downloads exactly what the
    /// interface is showing rather than whatever the feed says a second time.
    pending: Mutex<Option<Update>>,
    checking: AtomicBool,
    installing: AtomicBool,
    /// Set by the Windows installer hook before the destructive shutdown runs, so an install that
    /// fails after it can say why the engine is stopped.
    installer_handoff: AtomicBool,
}

impl UpdaterService {
    pub(crate) fn new() -> Self {
        Self {
            status: Mutex::new(UpdateStatus::idle()),
            pending: Mutex::new(None),
            checking: AtomicBool::new(false),
            installing: AtomicBool::new(false),
            installer_handoff: AtomicBool::new(false),
        }
    }

    pub(crate) fn status(&self) -> UpdateStatus {
        lock(&self.status).clone()
    }

    /// Ask the fixed feed whether this build is the newest one.
    ///
    /// An answer that fails is published as [`UpdatePhase::Error`] rather than returned as a
    /// rejected command: the status *is* the report, and a caller that already has the previous
    /// value keeps it while the message says what went wrong.
    pub(crate) async fn check(self: &Arc<Self>, app: &AppHandle) -> UpdateStatus {
        if cfg!(debug_assertions) {
            return self.publish(app, UpdateStatus::phase(UpdatePhase::Unsupported));
        }
        if self.checking.swap(true, Ordering::AcqRel) {
            return self.status();
        }
        // An announced update is not replaced by a second check: the reader is looking at that
        // version, and the answer would be the same one. `pending` is the authority, so a download
        // that failed still refuses the check and keeps its retry; the phase check covers the window
        // before `pending` is written.
        let current = self.status();
        if check_refused(&current, lock(&self.pending).is_some()) {
            self.checking.store(false, Ordering::Release);
            return current;
        }
        let _ = self.publish(app, UpdateStatus::phase(UpdatePhase::Checking));
        let next = self.run_check(app).await;
        self.checking.store(false, Ordering::Release);
        self.publish(app, next)
    }

    async fn run_check(self: &Arc<Self>, app: &AppHandle) -> UpdateStatus {
        let exit_app = app.clone();
        let service = Arc::clone(self);
        let updater = match app
            .updater_builder()
            .timeout(CHECK_TIMEOUT)
            // Windows installers replace this process's files, so the app quits inside the
            // updater's own install step. That path never reaches `RunEvent::Exit`, and this hook
            // is where the host, the shells, and the plugin workers are ended before the installer
            // starts. The flag records that this destructive step ran: if the launch then fails, the
            // install error says the engine was stopped and starts again on the next request.
            .on_before_exit(move || {
                service.installer_handoff.store(true, Ordering::SeqCst);
                crate::services::shutdown::run(&exit_app);
            })
            .build()
        {
            Ok(updater) => updater,
            Err(error) => {
                log::warn(&format!("the updater could not be configured: {error}"));
                return error_status(error.to_string(), None);
            }
        };
        match updater.check().await {
            Ok(Some(mut update)) => {
                let status = announced(&update);
                log::info(&format!(
                    "update available: {} (running {})",
                    update.version, update.current_version
                ));
                update.timeout = Some(DOWNLOAD_TIMEOUT);
                *lock(&self.pending) = Some(update);
                status
            }
            Ok(None) => {
                log::info("update check: this build is the newest stable release");
                UpdateStatus::phase(UpdatePhase::Current)
            }
            Err(error) => {
                log::warn(&format!("update check failed: {error}"));
                error_status(error.to_string(), None)
            }
        }
    }

    /// Download and install the announced update.
    ///
    /// On Windows the installer replaces this process and the function does not return; the restart
    /// is the installer's own. On macOS and Linux the download ends at [`UpdatePhase::Ready`], and
    /// `update_relaunch` is the explicit restart.
    pub(crate) async fn install(self: &Arc<Self>, app: &AppHandle) -> UpdateStatus {
        if cfg!(debug_assertions) {
            return self.status();
        }
        if self.installing.swap(true, Ordering::AcqRel) {
            return self.status();
        }
        self.installer_handoff.store(false, Ordering::SeqCst);
        let current = self.status();
        if !install_allowed(&current) {
            self.installing.store(false, Ordering::Release);
            return current;
        }
        let Some(update) = lock(&self.pending).clone() else {
            self.installing.store(false, Ordering::Release);
            return self.publish(
                app,
                error_status(
                    "The announced update is no longer held; check again.".to_owned(),
                    current.version,
                ),
            );
        };

        let version = update.version.clone();
        let notes = notes_of(&update);
        let mut downloading = UpdateStatus {
            phase: UpdatePhase::Downloading,
            version: Some(version.clone()),
            notes: notes.clone(),
            // Unknown until the first chunk carries a content length: a zero would claim a total
            // the feed never stated.
            progress: None,
            error: None,
        };
        let _ = self.publish(app, downloading.clone());

        let service = Arc::clone(self);
        let status_app = app.clone();
        let mut downloaded: u64 = 0;
        let mut last_percent: Option<u8> = None;
        let outcome = update
            .download_and_install(
                move |chunk_length, content_length| {
                    downloaded = downloaded.saturating_add(chunk_length as u64);
                    let percent = content_length
                        .filter(|total| *total > 0)
                        .map(|total| ((downloaded.min(total) * 100) / total) as u8);
                    if percent == last_percent {
                        return;
                    }
                    last_percent = percent;
                    downloading.progress = percent;
                    let _ = service.publish(&status_app, downloading.clone());
                },
                || {},
            )
            .await;
        self.installing.store(false, Ordering::Release);

        match outcome {
            Ok(()) => {
                log::info(&format!(
                    "update {version} installed; waiting for a restart"
                ));
                self.publish(
                    app,
                    UpdateStatus {
                        phase: UpdatePhase::Ready,
                        version: Some(version),
                        notes,
                        progress: Some(100),
                        error: None,
                    },
                )
            }
            Err(error) => {
                // The hook above runs before the installer is launched. A launch that fails leaves
                // the app alive with its engine already stopped; the message says so rather than
                // leaving the reader with a silent dead host.
                let handed_off = self.installer_handoff.swap(false, Ordering::SeqCst);
                let message = if handed_off {
                    format!(
                        "{error}. The engine was stopped for the installer; it starts again on the next request."
                    )
                } else {
                    error.to_string()
                };
                log::warn(&format!("update install failed: {message}"));
                self.publish(app, error_status(message, Some(version)))
            }
        }
    }

    /// Start the automatic checks: one after the window settles, then one every six hours.
    ///
    /// A development build never asks; neither does a process that already holds an announced or
    /// downloaded update, because a second answer would replace what the reader is looking at.
    pub(crate) fn start_auto_checks(self: &Arc<Self>, app: AppHandle) {
        if cfg!(debug_assertions) {
            return;
        }
        let service = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(AUTO_CHECK_DELAY).await;
            loop {
                if service.should_auto_check() {
                    let _ = service.check(&app).await;
                }
                tokio::time::sleep(AUTO_CHECK_INTERVAL).await;
            }
        });
    }

    fn should_auto_check(&self) -> bool {
        let current = self.status();
        match current.phase {
            UpdatePhase::Idle | UpdatePhase::Current => true,
            // A failed check is worth retrying; a failed download is not, because the announced
            // version is still held and the reader's retry is the explicit path.
            UpdatePhase::Error => current.version.is_none(),
            UpdatePhase::Unsupported
            | UpdatePhase::Checking
            | UpdatePhase::Available
            | UpdatePhase::Downloading
            | UpdatePhase::Ready => false,
        }
    }

    /// Store and announce one complete status. The store write is the commit point: a listener that
    /// reads afterwards sees the same value the event carried.
    fn publish(&self, app: &AppHandle, next: UpdateStatus) -> UpdateStatus {
        *lock(&self.status) = next.clone();
        if app.emit(UPDATE_CHANNEL, &next).is_err() {
            log::warn(&format!("emitting to {UPDATE_CHANNEL} failed"));
        }
        next
    }
}

/// Whether a check would replace an update the interface is already showing.
///
/// `has_pending` is the authoritative fact: a failed download keeps the announced update, and a
/// second check would answer with the feed's newer state while the interface still holds the old
/// one. The phase set covers the moment before `pending` is written.
fn check_refused(status: &UpdateStatus, has_pending: bool) -> bool {
    has_pending
        || matches!(
            status.phase,
            UpdatePhase::Available | UpdatePhase::Downloading | UpdatePhase::Ready
        )
}

/// Whether `install` may run: an announced update, including the retry after a failed download.
fn install_allowed(status: &UpdateStatus) -> bool {
    status.phase == UpdatePhase::Available
        || (status.phase == UpdatePhase::Error && status.version.is_some())
}

/// Whether a restart may run: only a downloaded update earns it.
pub(crate) fn ready_to_restart(status: &UpdateStatus) -> bool {
    status.phase == UpdatePhase::Ready
}

/// The status a successful check announces.
fn announced(update: &Update) -> UpdateStatus {
    UpdateStatus {
        phase: UpdatePhase::Available,
        version: Some(update.version.clone()),
        notes: notes_of(update),
        progress: None,
        error: None,
    }
}

/// The release notes, capped at a status-sized paragraph.
fn notes_of(update: &Update) -> Option<String> {
    update
        .body
        .as_deref()
        .map(str::trim)
        .filter(|notes| !notes.is_empty())
        .map(|notes| truncate_on_char_boundary(notes, NOTES_LIMIT).to_owned())
}

fn error_status(message: String, version: Option<String>) -> UpdateStatus {
    UpdateStatus {
        phase: UpdatePhase::Error,
        version,
        notes: None,
        progress: None,
        error: Some(message),
    }
}

/// A poisoned lock still holds the last complete status; treating it as empty would make the
/// interface forget an announced update because an unrelated writer panicked.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_status(status: UpdateStatus) -> UpdaterService {
        let service = UpdaterService::new();
        *lock(&service.status) = status;
        service
    }

    #[test]
    fn an_announced_update_is_not_replaced_by_an_automatic_check() {
        assert!(with_status(UpdateStatus::idle()).should_auto_check());
        assert!(with_status(UpdateStatus::phase(UpdatePhase::Current)).should_auto_check());

        assert!(!with_status(UpdateStatus::phase(UpdatePhase::Checking)).should_auto_check());
        assert!(!with_status(UpdateStatus::phase(UpdatePhase::Available)).should_auto_check());
        assert!(!with_status(UpdateStatus::phase(UpdatePhase::Downloading)).should_auto_check());
        assert!(!with_status(UpdateStatus::phase(UpdatePhase::Ready)).should_auto_check());
        assert!(!with_status(UpdateStatus::phase(UpdatePhase::Unsupported)).should_auto_check());
    }

    #[test]
    fn a_check_is_refused_while_an_announced_update_is_held() {
        assert!(check_refused(
            &UpdateStatus::phase(UpdatePhase::Available),
            false
        ));
        assert!(check_refused(
            &UpdateStatus::phase(UpdatePhase::Downloading),
            false
        ));
        assert!(check_refused(
            &UpdateStatus::phase(UpdatePhase::Ready),
            false
        ));

        // The blocking case: a failed download still holds the announced update, so a second check
        // would drop the version and the retry the reader is looking at.
        let failed_download = error_status("offline".to_owned(), Some("0.2.0".to_owned()));
        assert!(check_refused(&failed_download, true));

        // With nothing held, both a failed check and a finished one may be asked again.
        assert!(!check_refused(&failed_download, false));
        assert!(!check_refused(
            &error_status("offline".to_owned(), None),
            false
        ));
        assert!(!check_refused(
            &UpdateStatus::phase(UpdatePhase::Current),
            false
        ));
    }

    #[test]
    fn install_runs_only_for_an_announced_update() {
        assert!(install_allowed(&UpdateStatus::phase(
            UpdatePhase::Available
        )));
        assert!(install_allowed(&error_status(
            "offline".to_owned(),
            Some("0.2.0".to_owned())
        )));

        assert!(!install_allowed(&error_status("offline".to_owned(), None)));
        assert!(!install_allowed(&UpdateStatus::phase(UpdatePhase::Current)));
        assert!(!install_allowed(&UpdateStatus::phase(
            UpdatePhase::Downloading
        )));
    }

    #[test]
    fn a_restart_runs_only_for_a_downloaded_update() {
        assert!(ready_to_restart(&UpdateStatus::phase(UpdatePhase::Ready)));
        assert!(!ready_to_restart(&UpdateStatus::phase(
            UpdatePhase::Available
        )));
        assert!(!ready_to_restart(&UpdateStatus::phase(
            UpdatePhase::Downloading
        )));
        assert!(!ready_to_restart(&UpdateStatus::phase(UpdatePhase::Error)));
    }

    #[test]
    fn a_failed_check_is_retried_but_a_failed_download_waits_for_the_reader() {
        assert!(with_status(error_status("offline".to_owned(), None)).should_auto_check());

        // The announced version is still held, so the automatic pass leaves the retry to the
        // interface rather than asking the feed for a different answer.
        let failed_download = error_status("offline".to_owned(), Some("0.2.0".to_owned()));
        assert!(!with_status(failed_download).should_auto_check());
    }
}
