//! What this process does before it goes away, in one place.
//!
//! Two exits run it: the ordinary `RunEvent::Exit`, and the Windows installer's forced exit
//! (`tauri-plugin-updater`'s `on_before_exit`). The second one matters because the installer replaces
//! files under the installation directory while the host and the shells are still running from
//! them; a process that left those children behind would have its update fail on a locked file.
//!
//! The order is the ownership order: the engine host first (it holds the sessions), then the
//! process's own children (terminals, plugin workers), then the watchers and guest webviews, and
//! only then the run's closing log line.

use tauri::Manager;

use crate::state::AppState;

pub(crate) fn run(app: &tauri::AppHandle) {
    // The state is absent when the start-up path refused before it was managed (the store could not
    // be opened): there is nothing to shut down then, and the exit path must not turn that refusal
    // into a second failure.
    if let Some(state) = app.try_state::<AppState>() {
        state.runtime.shutdown_now();
        // The shells are this process's own children, so the host's shutdown above does not reach
        // them: every live pty is ended here, before the process goes away.
        state.terminal.shutdown_all();
        // The plugin processes are children too. Each is asked to unload first (a plugin gets its
        // `onUnload`), and the whole stop is bounded - a worker that hangs must not hold the exit
        // path.
        state.plugin_process.shutdown_all();
        // The workspace watch is an OS handle and a thread of this process: the exit path ends it
        // here rather than leaving both to the process teardown.
        state.workspace_watch.stop();
        // Browser guests are child webviews this process hosts; closing them here is the quit
        // path's dispose, and it releases every profile controller before the window goes away.
        if let Some(browser) = &state.browser {
            browser.dispose_all();
        }
    }
    // The run's last record, after everything this process owns has been ended. It is written past
    // the file's ceiling (`log::end_run`), because the next start's "did the previous run close?"
    // check reads exactly this line; its absence is what a hard crash, a kill, or a power loss
    // leaves (`services::crash`).
    crate::services::log::end_run();
}
