//! The report a start that cannot open its own data gets.
//!
//! `AppState::new` can refuse before any window or webview exists: an unreadable store, a store
//! written by a newer build, a migration that failed. Neither the UI nor an IPC error can carry
//! that message at that point, so the one channel left is the operating system's own dialog -
//! on Windows a message box - stating the file that was refused and what to do about it. The log
//! keeps the same text for support, and the process leaves after the dialog is dismissed rather
//! than run against data it does not understand (`rules.md#startup-upgrade-and-downgrade`).

use crate::errors::IpcError;
use crate::services::log;

/// Reports a fatal start-up failure to the user and to the log; returns when the dialog is gone.
pub(crate) fn report_fatal(error: &IpcError) {
    log::error(&format!(
        "omp: start-up refused ({}): {}",
        error.code, error.message
    ));
    show_dialog(&error.message);
}

/// The OS dialog on Windows.
///
/// A message box needs nothing but a window station, which is exactly why it is used here: the
/// dialog plugins reach their dialogs through the event loop this failed start never got to.
#[cfg(target_os = "windows")]
fn show_dialog(message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND,
    };

    /// One NUL-terminated UTF-16 argument.
    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    let title = wide("OMP Desktop");
    let body = wide(message);
    // SAFETY: both buffers are NUL-terminated UTF-16 that outlive the call, and the box copies its
    // strings before it returns.
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            body.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR | MB_SETFOREGROUND,
        );
    }
}

/// Other platforms keep the line on stderr, the one channel an unattended start always has.
///
/// This path is unverified by this project (only Windows has been exercised); the message is the
/// same one the log and the Windows dialog carry.
#[cfg(not(target_os = "windows"))]
fn show_dialog(message: &str) {
    eprintln!("OMP Desktop could not start: {message}");
}
