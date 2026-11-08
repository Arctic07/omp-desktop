//! How this application yields the machine to whatever is in front of it.
//!
//! The reader who is playing a game or building something in another window should not feel this
//! app. Its own work — the engine host, its language servers, its tool processes — must keep
//! running, but it must stop competing for cores with the thing the reader is actually doing.
//!
//! Windows has exactly that lever: a **below-normal priority class** plus **EcoQoS** execution-speed
//! throttling (`PROCESS_POWER_THROTTLING_STATE`, the same mechanism Task Manager's "Efficiency
//! mode" uses). They do not stop work; they let the scheduler prefer the foreground application and
//! run this one on the machine's spare capacity, and the power manager may keep it off the fast
//! cores entirely. The class is also inherited by processes the host spawns afterwards (language
//! servers, terminals), which is the rest of the app's CPU.
//!
//! **A turn in flight is the one case that is not "spare capacity".** A demoted, throttled host on a
//! loaded machine answers late and streams late — the window reports `the engine host did not answer
//! in time`, the reader watches a turn that never produces a token, and closing and reopening the
//! application changes nothing because the first thing the next run does is run another turn the
//! same way (measured 2026-10-30: a demoted host committed 725 MB, was trimmed to a 45 MB working set
//! while idle, and then answered nothing for 45 s). So the demotion is suspended while any
//! conversation has a turn running and taken up again when the last one ends: the reader's answer is
//! scheduled like the work in front of the window, and everything else still runs on spare capacity.
//!
//! Focus is the signal and the frontend owns it (`state/session-store.ts::syncView`): background on
//! blur or hide, normal on focus. The last state is remembered here so a host spawned *while* the
//! app is in the background is born at the background class instead of waiting for the next focus
//! change to be demoted. The turn is the second signal and the host's own frames carry it
//! (`runtime/host/protocol.rs::note_turn_activity`).
//!
//! Every call is best-effort: an OS (or a policy) that refuses the hint must not fail a focus
//! change, so failures are discarded rather than propagated. This module owns no memory beyond three
//! scalars.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::Threading::{
        GetCurrentProcess, OpenProcess, ProcessPowerThrottling, SetPriorityClass,
        SetProcessInformation, BELOW_NORMAL_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS,
        PROCESS_POWER_THROTTLING_CURRENT_VERSION, PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
        PROCESS_POWER_THROTTLING_STATE, PROCESS_SET_INFORMATION,
    },
};

/// The last state the window reported, so a host spawned in the background starts demoted.
static BACKGROUND: AtomicBool = AtomicBool::new(false);

/// Whether any conversation has a turn running. While one does, nothing here is demoted.
static TURN_RUNNING: AtomicBool = AtomicBool::new(false);

/// The engine host's process id, for applying the class to it. `0` while no host is running.
///
/// Kept here rather than asked of the runtime on every frame: the frame that starts or ends a turn
/// is what moves [`TURN_RUNNING`], and reading the runtime's own pid would take its state lock per
/// streamed token. A host that exits clears it (`runtime/host/lifecycle.rs::finalize`), so a
/// recycled process id is never demoted on the dead host's behalf.
static HOST_PID: AtomicU32 = AtomicU32::new(0);

/// Applies the reported state to this process and, when it is running, to the engine host.
///
/// `host_pid` is the host's process id, or `None` while no host is running. Setting the class on a
/// process that has already exited fails harmlessly; the spawn path re-applies it (`adopt_host`).
pub(crate) fn set_background(background: bool, host_pid: Option<u32>) {
    BACKGROUND.store(background, Ordering::Relaxed);
    if let Some(pid) = host_pid.filter(|pid| *pid != 0) {
        HOST_PID.store(pid, Ordering::Relaxed);
    }
    apply_self();
    apply_host();
}

/// Records whether a conversation has a turn in flight, and re-applies the class when that changes.
///
/// Called from the frame path, so an unchanged value costs one atomic: the reader's window may
/// stream thousands of frames through here in a turn, and only the two edges matter.
pub(crate) fn set_turn_running(running: bool) {
    if TURN_RUNNING.swap(running, Ordering::Relaxed) == running {
        return;
    }
    apply_self();
    apply_host();
}

/// Applies the last reported state to a host that has just been spawned.
///
/// A host started while the reader is in another application must not run at normal priority until
/// the next focus change; the state the window last reported is the best answer available. It is
/// applied even when that state is "normal": a child inherits its parent's class, and this
/// application may have been demoted by the time the host is born.
pub(crate) fn adopt_host(pid: u32) {
    if pid != 0 {
        HOST_PID.store(pid, Ordering::Relaxed);
    }
    apply_host();
}

/// Forgets the host, so the class is never applied to a process id that no longer belongs to it.
///
/// A host that is gone has no turn in flight either: whatever it was running ended with it, and
/// this process is spare capacity again while the window is in the background.
pub(crate) fn forget_host() {
    HOST_PID.store(0, Ordering::Relaxed);
    TURN_RUNNING.store(false, Ordering::Relaxed);
    apply_self();
}

/// Whether the two signals together say "spare capacity only".
fn throttled() -> bool {
    BACKGROUND.load(Ordering::Relaxed) && !TURN_RUNNING.load(Ordering::Relaxed)
}

fn apply_self() {
    #[cfg(windows)]
    {
        // SAFETY: `GetCurrentProcess` returns a pseudo-handle that needs no closing and is always
        // valid for this process; the call only writes this process's scheduling state.
        unsafe { apply(GetCurrentProcess(), throttled()) };
    }
}

fn apply_host() {
    let pid = HOST_PID.load(Ordering::Relaxed);
    if pid == 0 {
        return;
    }
    #[cfg(windows)]
    {
        // SAFETY: the handle is opened, used and closed within this block; the calls only change the
        // target process's scheduling state. A failed open (host already gone) yields a null handle.
        unsafe {
            let handle = OpenProcess(PROCESS_SET_INFORMATION, 0, pid);
            if !handle.is_null() {
                apply(handle, throttled());
                CloseHandle(handle);
            }
        }
    }
    #[cfg(not(windows))]
    let _ = pid;
}

/// Sets the priority class and the EcoQoS state of one process handle.
///
/// # Safety
///
/// `handle` must be a valid process handle with `PROCESS_SET_INFORMATION` (or the current-process
/// pseudo-handle). The calls only write scheduling state.
#[cfg(windows)]
unsafe fn apply(handle: HANDLE, background: bool) {
    let class = if background {
        BELOW_NORMAL_PRIORITY_CLASS
    } else {
        NORMAL_PRIORITY_CLASS
    };
    let _ = SetPriorityClass(handle, class);
    // `ControlMask` says which fields the caller is asking about; `StateMask` carries their values.
    // Clearing both releases the throttle, which is how a focused window returns to normal speed.
    let mask = if background {
        PROCESS_POWER_THROTTLING_EXECUTION_SPEED
    } else {
        0
    };
    let state = PROCESS_POWER_THROTTLING_STATE {
        Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
        ControlMask: mask,
        StateMask: mask,
    };
    let _ = SetProcessInformation(
        handle,
        ProcessPowerThrottling,
        &state as *const PROCESS_POWER_THROTTLING_STATE as *const core::ffi::c_void,
        std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
    );
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetPriorityClass, BELOW_NORMAL_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS,
    };

    /// The class is process-wide state, and these tests share one process: each takes this guard so
    /// one test's demotion is never read by another's assertion.
    static PRIORITY: Mutex<()> = Mutex::new(());

    fn guarded() -> MutexGuard<'static, ()> {
        let guard = PRIORITY
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        set_turn_running(false);
        set_background(false, None);
        guard
    }

    fn class() -> u32 {
        unsafe { GetPriorityClass(GetCurrentProcess()) }
    }

    /// The OS accepts the demotion and the restore (the rest of the hint — EcoQoS — has no reader).
    ///
    /// Both facts are read *after* the class is restored, so a failing assertion can never leave the
    /// test process demoted for the tests running beside it.
    #[test]
    fn the_process_drops_to_below_normal_and_comes_back() {
        let _guard = guarded();
        set_background(true, None);
        let lowered = class() == BELOW_NORMAL_PRIORITY_CLASS;
        set_background(false, None);
        let restored = class() == NORMAL_PRIORITY_CLASS;
        assert!(
            lowered,
            "the background state is a below-normal priority class"
        );
        assert!(restored, "focus returns this process to normal");
    }

    /// A turn in flight keeps the work the reader is waiting on at normal priority, in both orders:
    /// the turn that starts after the window went away (the reader alt-tabbed into a build) and the
    /// one already running when it happened.
    #[test]
    fn a_running_turn_is_not_throttled() {
        let _guard = guarded();

        set_background(true, None);
        set_turn_running(true);
        let running = class() == NORMAL_PRIORITY_CLASS;

        set_turn_running(false);
        let ended = class() == BELOW_NORMAL_PRIORITY_CLASS;

        set_background(false, None);
        let focused = class() == NORMAL_PRIORITY_CLASS;

        assert!(running, "a turn in flight runs at normal priority");
        assert!(ended, "the last turn ending restores the demotion");
        assert!(focused, "focus returns this process to normal");
    }

    /// The turn signal is re-applied on its edges only; a repeat that changed nothing leaves the
    /// class the window asked for alone.
    #[test]
    fn a_repeated_turn_signal_changes_nothing() {
        let _guard = guarded();
        set_background(true, None);
        set_turn_running(true);
        set_turn_running(true);
        set_turn_running(false);
        set_turn_running(false);
        let after = class() == BELOW_NORMAL_PRIORITY_CLASS;
        set_background(false, None);
        assert!(after, "the class follows the first edge of a signal");
    }
}
