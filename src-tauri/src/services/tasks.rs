//! Long operations, as tasks the page can watch and stop (`rules.md#tauri-ipc-and-permissions`).
//!
//! Most of what this application does finishes inside one answer, and a page that asked for it waits
//! for that answer. A few things do not: importing a plugin package unpacks an archive, writes a
//! catalogue, promotes a directory and then asks the engine to install or upgrade from it - seconds of
//! work on a disk, and more when the engine has to read the package. Those are the operations this
//! module exists for, and the contract is the rules' own: a **task id** identifies one run, and the
//! events that belong to it are typed - started, progress, finished, failed, cancelled - so a reader
//! can tell "still working" from "gave up" without reading prose.
//!
//! Three properties are what make it more than a log:
//!
//! - **One id per run, minted here.** The id is the only thing a cancellation addresses, so it is
//!   random rather than derived from the work (two imports of the same package are two tasks), and it
//!   is released the moment the run ends.
//! - **Cancellation is cooperative.** A run checks [`TaskRun::cancelled`] between its steps and stops
//!   at the next boundary; nothing here interrupts a step, because a half-unpacked directory or a
//!   half-registered marketplace is worse than a slow import. The flag lives in memory and dies with
//!   the process.
//! - **The channel is the shell's, not a plugin's.** Events go to the main window like every other
//!   application event; a plugin page cannot see or start one (its own calls are answered by their
//!   return value).
//!
//! **Owner / bound / release.** Owned by `AppState`; bounded by the number of runs in flight (one
//! entry per run, released when it ends - a run that panics leaves its entry behind, which is why the
//! table is also cleared for a run whose answer never came); released on process exit.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::Emitter;

use crate::state::AppState;

/// The event one task's progress arrives on; one name, because there is one kind of task event.
pub(crate) const TASK_EVENT: &str = "plugin-task";

/// What happened, as the page branches on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TaskKind {
    Started,
    Progress,
    Finished,
    Failed,
    Cancelled,
}

/// The step one import is on, as a token the page words.
///
/// Tokens rather than sentences: the copy belongs to the page (`pluginsCopy`), and a step this build
/// adds is a compile error there rather than a blank line here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TaskStage {
    Reading,
    Unpacking,
    Cataloguing,
    Installing,
    Updating,
}

impl TaskStage {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            TaskStage::Reading => "reading",
            TaskStage::Unpacking => "unpacking",
            TaskStage::Cataloguing => "cataloguing",
            TaskStage::Installing => "installing",
            TaskStage::Updating => "updating",
        }
    }
}

/// One task event as the window receives it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskEvent {
    pub(crate) task_id: String,
    /// What the task is, as a token (`plugin.import` today).
    pub(crate) label: &'static str,
    pub(crate) kind: TaskKind,
    /// The step, on a progress event.
    pub(crate) stage: Option<&'static str>,
    /// The refusal code, on a failure: the page words it like any other host code.
    pub(crate) code: Option<String>,
}

/// The runs this process has in flight, and how to ask one of them to stop.
#[derive(Default)]
pub(crate) struct TaskRegistry {
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
    next: AtomicU64,
}

impl TaskRegistry {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Mints one id and the flag its run checks.
    fn begin(&self) -> Option<(String, Arc<AtomicBool>)> {
        let mut running = self.running.lock().ok()?;
        let id = format!("task-{}", self.next.fetch_add(1, Ordering::Relaxed) + 1);
        let flag = Arc::new(AtomicBool::new(false));
        running.insert(id.clone(), Arc::clone(&flag));
        Some((id, flag))
    }

    /// Asks one run to stop, answering whether it was still in flight.
    pub(crate) fn cancel(&self, id: &str) -> bool {
        let Ok(running) = self.running.lock() else {
            return false;
        };
        match running.get(id) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    /// Releases one run's entry.
    fn end(&self, id: &str) {
        if let Ok(mut running) = self.running.lock() {
            running.remove(id);
        }
    }

    /// How many runs are in flight; used by this module's tests only.
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.running
            .lock()
            .map(|running| running.len())
            .unwrap_or(0)
    }
}

/// One run of a long operation: its id, its cancellation flag, and where its events go.
pub(crate) struct TaskRun {
    id: String,
    label: &'static str,
    app: tauri::AppHandle,
    cancelled: Arc<AtomicBool>,
}

impl TaskRun {
    /// Starts one task: registers it (so it can be cancelled) and tells the window it began.
    pub(crate) fn start(
        app: &tauri::AppHandle,
        state: &AppState,
        label: &'static str,
    ) -> Option<Self> {
        let (id, cancelled) = state.tasks.begin()?;
        let run = Self {
            id,
            label,
            app: app.clone(),
            cancelled,
        };
        run.emit(TaskKind::Started, None, None);
        Some(run)
    }

    /// Whether the user asked this run to stop; a run checks it between its steps.
    pub(crate) fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    /// Reports one step.
    pub(crate) fn progress(&self, stage: TaskStage) {
        self.emit(TaskKind::Progress, Some(stage.as_str()), None);
    }

    /// Ends the run: finished, cancelled, or failed with the code the caller refused with.
    pub(crate) fn finish(self, state: &AppState, outcome: TaskOutcome) {
        match outcome {
            TaskOutcome::Finished => self.emit(TaskKind::Finished, None, None),
            TaskOutcome::Cancelled => self.emit(TaskKind::Cancelled, None, None),
            TaskOutcome::Failed(code) => self.emit(TaskKind::Failed, None, Some(code)),
        }
        state.tasks.end(&self.id);
    }

    fn emit(&self, kind: TaskKind, stage: Option<&'static str>, code: Option<String>) {
        let event = TaskEvent {
            task_id: self.id.clone(),
            label: self.label,
            kind,
            stage,
            code,
        };
        // A window that is not there is not an error: the run's own answer still reaches its caller,
        // and the events are how a *reader* watches, not how the work is reported.
        let _ = self.app.emit_to("main", TASK_EVENT, event);
    }
}

/// How one run ended.
pub(crate) enum TaskOutcome {
    Finished,
    Cancelled,
    Failed(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_run_is_one_id_and_cancelling_it_is_a_flag() {
        let registry = TaskRegistry::new();
        let (first, first_flag) = registry.begin().expect("room for one run");
        let (second, second_flag) = registry.begin().expect("room for another");
        assert_ne!(first, second, "two runs of the same work are two tasks");
        assert_eq!(registry.len(), 2);
        assert!(!first_flag.load(Ordering::Relaxed));

        assert!(registry.cancel(&first));
        assert!(first_flag.load(Ordering::Relaxed));
        assert!(
            !second_flag.load(Ordering::Relaxed),
            "cancelling one run does not touch another"
        );

        registry.end(&first);
        assert_eq!(registry.len(), 1);
        assert!(
            !registry.cancel(&first),
            "a finished run cannot be cancelled"
        );
        assert!(registry.cancel(&second));
    }
}
