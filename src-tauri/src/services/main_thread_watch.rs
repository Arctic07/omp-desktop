//! The watchdog that notices when the application's own main thread stops answering.
//!
//! Everything the window does runs on the one thread the operating system's event loop owns:
//! painting, input, and every WebView2 call, because a non-`async` command body runs inside the
//! IPC handler on that same thread (`rules.md#main-thread-budget`). The desktop already watches
//! what it does not own - a host that misses its health probes is killed and reported
//! (`runtime::host::lifecycle`) - but nothing watched the thread the user is looking at, so the
//! stall that froze the window on 2026-10-30 wrote no line in `app.log` between the last event and
//! the process being closed by the system's own hang dialog.
//!
//! This thread is that observer. It pings the main thread once a second and measures the answer. A
//! ping that is [`STALL_THRESHOLD`] late is written **while it is still late** - the reader may
//! close a hung window before the thread ever recovers - and the total is written when the answer
//! arrives. A ping that came back after [`SLOW_THRESHOLD`] without ever becoming a stall is written
//! once, at info level: that is the freeze a reader reports and the system never marks, a launch
//! that takes three seconds to come up above all. The line also carries how much of that silence
//! the thread spent on the CPU, which is the first fork of any diagnosis: a thread that used
//! almost none of it was *waiting* (on another process, a lock, a deadlock) and one that used all
//! of it was *computing* (a parse, a serialization). Reading it costs one syscall per ping,
//! because the thread handle is opened once.
//! A stall then gets one stack walk of that thread (`services::main_thread`), so the pair of lines
//! says where it was and not only that it was silent.
//!
//! It never touches the main thread's work, and it ends with the event loop: posting a ping then
//! fails, or the closure is dropped unanswered and the channel disconnects.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError},
    },
    time::{Duration, Instant},
};

use tauri::{AppHandle, Manager, Window};

use crate::services::log;
use crate::services::main_thread::MainThread;
use crate::services::presence::MAIN_WINDOW;

/// How often a healthy main thread is pinged. One second notices a stall while the reader is still
/// looking at the window, and the ping itself is one posted closure the loop handles like any other
/// message.
const PING_INTERVAL: Duration = Duration::from_secs(1);

/// How late a ping has to be before it is a stall rather than a busy frame. Five seconds is where
/// the system's own hang detection starts painting "not responding" over the title bar.
const STALL_THRESHOLD: Duration = Duration::from_secs(5);

/// How late a ping has to be before it is worth a line at all. Two seconds is a freeze a reader
/// notices and the system does not: short of the "not responding" mark, long enough that the
/// window visibly stopped. Without this floor a launch that takes three seconds to come up - the
/// window is created, WebView2 starts and the document loads - left nothing behind, and a reader
/// reporting "it froze for a moment when I opened it" could not be answered.
const SLOW_THRESHOLD: Duration = Duration::from_secs(2);

/// The slice a silent ping waits in, so the end of a stall is noticed within a second of it
/// happening instead of after the whole stall.
const STALL_SLICE: Duration = Duration::from_secs(1);

/// Whether a stall is in progress right now.
///
/// The liveness watcher reads this: a host probe that times out while the window's own thread
/// cannot answer says nothing about the host. It is set when a ping crosses [`STALL_THRESHOLD`] and
/// cleared when the same ping is answered.
static STALLED: AtomicBool = AtomicBool::new(false);

/// Whether the main thread is currently in a stall the watchdog has reported.
pub(crate) fn stalled() -> bool {
    STALLED.load(Ordering::Relaxed)
}

/// Starts the watchdog. Called once, from the setup hook, after the log is open.
pub(crate) fn watch(app: &AppHandle) {
    let window = app.get_window(MAIN_WINDOW);
    let handle = app.clone();
    let spawned = std::thread::Builder::new()
        .name("main-thread-watch".to_owned())
        .spawn(move || run(&handle, window));
    if let Err(error) = spawned {
        log::warn(&format!(
            "the main-thread watchdog could not start, so a frozen window will leave no line: {error}"
        ));
    }
}

fn run(app: &AppHandle, window: Option<Window>) {
    // Opened once for the run: the thread that owns the window does not change, and a handle held
    // open costs one `GetThreadTimes` per ping rather than an open and a close.
    let main = window.as_ref().and_then(MainThread::open);
    // The stack is read once per event, not once per second: the walk suspends the thread for a
    // few microseconds, which is nothing against a freeze this long and is not worth repeating.
    let log_stack = |stalled: bool| {
        let frames = main.as_ref().and_then(MainThread::frames);
        if let Some(line) = frames.as_deref().and_then(stack_line) {
            if stalled {
                log::warn(&line);
            } else {
                log::info(&line);
            }
        }
    };
    loop {
        let (sender, receiver) = mpsc::channel();
        let posted = app.run_on_main_thread(move || {
            let _ = sender.send(());
        });
        if posted.is_err() {
            // The event loop is gone: this run is over and there is nothing left to watch.
            STALLED.store(false, Ordering::Relaxed);
            return;
        }
        let started = Instant::now();
        let before = main.as_ref().and_then(MainThread::used);
        let spent = || {
            before
                .zip(main.as_ref().and_then(MainThread::used))
                .map(|(then, now)| now.saturating_sub(then))
        };
        let mut reported = false;
        loop {
            match receiver.recv_timeout(STALL_SLICE) {
                Ok(()) => {
                    STALLED.store(false, Ordering::Relaxed);
                    let waited = started.elapsed();
                    if reported {
                        if let Some(line) = recovery_line(waited, true) {
                            log::warn(&line);
                        }
                    } else if let Some(line) = slow_line(waited, spent()) {
                        log::info(&line);
                        log_stack(false);
                    }
                    break;
                }
                Err(RecvTimeoutError::Timeout) => {
                    let waited = started.elapsed();
                    if let Some(line) = stall_line(waited, reported, spent()) {
                        reported = true;
                        STALLED.store(true, Ordering::Relaxed);
                        log::warn(&line);
                        log_stack(true);
                    }
                }
                // The closure was dropped without running: the loop that owed the answer is gone.
                Err(RecvTimeoutError::Disconnected) => {
                    STALLED.store(false, Ordering::Relaxed);
                    return;
                }
            }
        }
        std::thread::sleep(PING_INTERVAL);
    }
}

/// The line a still-silent ping owes: one, at the moment the budget is spent, and nothing after -
/// a stall reported every second would bury the lines that came before it.
///
/// `cpu` is what the thread spent on the CPU over the same wait, when the platform can say: it is
/// absent rather than zero when it cannot, so a reader never mistakes "unknown" for "idle".
fn stall_line(waited: Duration, reported: bool, cpu: Option<Duration>) -> Option<String> {
    if reported || waited < STALL_THRESHOLD {
        return None;
    }
    Some(format!(
        "main thread has not answered for {:.1} s{}: the window cannot paint or take input",
        waited.as_secs_f64(),
        cpu_suffix(cpu)
    ))
}

/// The line a ping that came back late owes when it never became a stall: the window stopped for
/// long enough to be felt, short of the point the system paints "not responding" over it.
fn slow_line(waited: Duration, cpu: Option<Duration>) -> Option<String> {
    if waited < SLOW_THRESHOLD || waited >= STALL_THRESHOLD {
        return None;
    }
    Some(format!(
        "main thread took {:.1} s to answer a ping{}",
        waited.as_secs_f64(),
        cpu_suffix(cpu)
    ))
}

/// ` (0.1 s on the CPU)`, or nothing when the platform could not read the clock.
fn cpu_suffix(cpu: Option<Duration>) -> String {
    cpu.map(|cpu| format!(" ({:.1} s on the CPU)", cpu.as_secs_f64()))
        .unwrap_or_default()
}

/// The line an answered ping owes once the stall it ended was reported. A healthy answer says
/// nothing, which is every ping of a normal run.
fn recovery_line(waited: Duration, reported: bool) -> Option<String> {
    if !reported {
        return None;
    }
    Some(format!(
        "main thread answered after {:.1} s",
        waited.as_secs_f64()
    ))
}

/// Where the thread was when the stall was found, as the walk reported it: `module+0xoffset` per
/// frame, innermost first. Empty is a walk that could not run, which owes no line at all rather
/// than a line saying nothing.
fn stack_line(frames: &[String]) -> Option<String> {
    if frames.is_empty() {
        return None;
    }
    Some(format!("main thread stack: {}", frames.join(" <- ")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ping_answered_within_its_budget_says_nothing() {
        assert_eq!(stall_line(Duration::from_millis(10), false, None), None);
        assert_eq!(
            stall_line(Duration::from_millis(4_999), false, Some(Duration::ZERO)),
            None
        );
        assert_eq!(recovery_line(Duration::from_millis(10), false), None);
    }

    #[test]
    fn a_ping_late_past_the_budget_is_reported_once_and_the_end_carries_the_total() {
        let late = stall_line(STALL_THRESHOLD, false, None).expect("five seconds is a stall");
        assert!(late.contains("has not answered for 5.0 s"), "{late}");

        // The next silent slice is the same stall: no second line.
        assert_eq!(stall_line(Duration::from_secs(6), true, None), None);

        let total = recovery_line(Duration::from_secs(59), true).expect("the stall ended");
        assert!(total.contains("answered after 59.0 s"), "{total}");
    }

    /// A freeze the system never calls a hang: reported once, with the CPU it spent, and never for
    /// a ping that became a stall.
    #[test]
    fn a_ping_that_answers_late_is_reported_below_the_stall_threshold() {
        assert_eq!(slow_line(Duration::from_millis(1_999), None), None);
        assert_eq!(slow_line(STALL_THRESHOLD, None), None);

        let line = slow_line(
            Duration::from_millis(3_200),
            Some(Duration::from_millis(100)),
        )
        .expect("three seconds is a freeze a reader feels");
        assert_eq!(
            line,
            "main thread took 3.2 s to answer a ping (0.1 s on the CPU)"
        );
    }

    /// Where the thread was: one line, innermost frame first, and nothing at all when the walk
    /// could not run.
    #[test]
    fn the_stack_is_one_line_of_frames_innermost_first() {
        assert_eq!(stack_line(&[]), None);

        let line = stack_line(&[
            "omp_desktop.exe+0x1a2b3c".to_owned(),
            "combase.dll+0x1234".to_owned(),
            "ntdll.dll+0x9a1b".to_owned(),
        ])
        .expect("three frames");
        assert_eq!(
            line,
            "main thread stack: omp_desktop.exe+0x1a2b3c <- combase.dll+0x1234 <- ntdll.dll+0x9a1b"
        );
    }

    /// The one fact that separates waiting from computing: a thread silent for six seconds that
    /// used a tenth of one second of CPU was blocked on something outside itself.
    #[test]
    fn the_cpu_the_thread_spent_over_the_same_wait_is_named_beside_it() {
        let idle = stall_line(
            Duration::from_secs(6),
            false,
            Some(Duration::from_millis(100)),
        )
        .expect("a stall");
        assert!(idle.contains("(0.1 s on the CPU)"), "{idle}");

        let busy = stall_line(
            Duration::from_secs(6),
            false,
            Some(Duration::from_millis(6_300)),
        )
        .expect("a stall");
        assert!(busy.contains("(6.3 s on the CPU)"), "{busy}");
    }
}
