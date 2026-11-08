//! The system's own trash: where a plugin's `fs.delete` puts a file, when it is allowed to.
//!
//! Deleting is the one file operation whose damage re-running the plugin cannot undo, so the removal
//! goes through the shell rather than through the filesystem: `SHFileOperationW` with `FOF_ALLOWUNDO`
//! moves the file to the recycle bin, which is the only reason this module exists at all. A build
//! that cannot offer that (`trash_supported` is false) refuses the call instead of unlinking: "delete"
//! that cannot be undone is not the operation a manifest declared.
//!
//! Nothing here is recursive. A directory is refused by the caller before this module is reached, and
//! the flags below are set so the shell asks nobody anything: the question has already been put to the
//! user by the gate above (`services::plugins::bridge`), and a second dialog from the platform would
//! be a prompt about a decision already made.

use std::path::Path;

/// Whether this build can move a file to the system's trash.
pub(crate) const fn trash_supported() -> bool {
    cfg!(windows)
}

/// Moves one file to the system's trash, reporting whether it went.
///
/// `false` covers every way it can fail - the platform, a file another process holds open, a shell
/// that refused - and the caller answers the plugin with a refusal either way: a file that is still
/// where it was is not a file that was deleted.
#[cfg(windows)]
pub(crate) fn move_to_trash(path: &Path) -> bool {
    use windows_sys::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE,
        SHFILEOPSTRUCTW,
    };

    use std::os::windows::ffi::OsStrExt;

    // `pFrom` is a list: the path, then a second terminator for the list itself.
    let mut from: Vec<u16> = path.as_os_str().encode_wide().collect();
    from.push(0);
    from.push(0);
    let mut operation = SHFILEOPSTRUCTW {
        hwnd: std::ptr::null_mut(),
        wFunc: FO_DELETE,
        pFrom: from.as_ptr(),
        pTo: std::ptr::null(),
        // Undoable, and silent: the user has already been asked by this application's own gate.
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI) as u16,
        fAnyOperationsAborted: 0,
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: std::ptr::null(),
    };
    // SAFETY: `from` outlives the call and carries the double terminator the structure documents;
    // `operation` is a plain struct whose pointers all point at live storage for the duration.
    let result = unsafe { SHFileOperationW(&mut operation) };
    result == 0 && operation.fAnyOperationsAborted == 0
}

/// Moves one file to the system's trash; always `false` where [`trash_supported`] is false.
#[cfg(not(windows))]
pub(crate) fn move_to_trash(_path: &Path) -> bool {
    false
}
