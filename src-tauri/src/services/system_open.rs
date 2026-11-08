//! Handing one address to the machine's own browser.
//!
//! This application renders no pages of its own: every address a reader clicks, the engine reports
//! or a plugin asks to open leaves through the operating system's shell verb. The launcher is one
//! function because there is one question - "open this address, in whatever the machine opens
//! addresses with" - and one answer, however the address was arrived at.

use crate::errors::{IpcError, IpcResult, EXTERNAL_OPEN_FAILED, INVALID_INPUT};

/// The longest address this launcher accepts. A link in a transcript is user-visible text, not a
/// document, so this is a boundary rather than a convenience: nothing longer is a real address.
const MAX_ADDRESS_LEN: usize = 2048;

/// Whether `raw` is an address the system browser may be handed: absolute `http(s)`, bounded, with
/// no whitespace (which the shell verb would split on).
pub(crate) fn is_web_address(raw: &str) -> bool {
    let value = raw.trim();
    if value.is_empty() || value.len() > MAX_ADDRESS_LEN || value.chars().any(char::is_whitespace) {
        return false;
    }
    let rest = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"));
    matches!(rest, Some(rest) if !rest.is_empty() && !rest.starts_with('/'))
}

/// Opens one address through the platform's own opener.
///
/// The caller is responsible for the address having passed [`is_web_address`]: plugin capabilities
/// judge their own addresses (`services::plugins::bridge::capabilities`) and the command validates
/// at the IPC boundary, so this is the launch half only.
pub(crate) fn launch(target: &str) -> bool {
    platform_launch(target)
}

/// The command's whole body: validate the address, then hand it to the system browser.
pub(crate) fn open_web_address(raw: &str) -> IpcResult<()> {
    let value = raw.trim();
    if !is_web_address(value) {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The address must be an absolute http(s) URL.",
        ));
    }
    if launch(value) {
        Ok(())
    } else {
        Err(IpcError::new(
            EXTERNAL_OPEN_FAILED,
            "The system browser refused that address.",
        ))
    }
}

/// Opens one existing local file with the platform's default handler.
///
/// The caller is the browser's "open externally" control for a `file:` page. A path that does not
/// exist is refused rather than handed to the shell.
pub(crate) fn open_path(path: &std::path::Path) -> IpcResult<()> {
    if !path.is_file() {
        return Err(IpcError::new(
            INVALID_INPUT,
            "That local file does not exist.",
        ));
    }
    let target = path.to_string_lossy();
    if launch(&target) {
        Ok(())
    } else {
        Err(IpcError::new(
            EXTERNAL_OPEN_FAILED,
            "The operating system refused to open that file.",
        ))
    }
}

#[cfg(target_os = "windows")]
fn platform_launch(target: &str) -> bool {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;

    /// One NUL-terminated UTF-16 argument.
    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    let operation = wide("open");
    let target = wide(target);
    // SW_SHOWNORMAL: the shell's own "open it normally" window state, passed as its literal so the
    // call does not pull in the windowing feature set this build has no other use for.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    result as isize > 32
}

#[cfg(not(target_os = "windows"))]
fn platform_launch(target: &str) -> bool {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    use std::process::{Command, Stdio};
    Command::new(opener)
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_absolute_http_addresses_are_accepted() {
        assert!(is_web_address("https://example.com/a?b=1"));
        assert!(is_web_address("http://127.0.0.1:5173/"));
        assert!(is_web_address("  https://example.com  "));
        assert!(!is_web_address(""));
        assert!(!is_web_address("example.com"));
        assert!(!is_web_address("file:///C:/Windows"));
        assert!(!is_web_address("https://"));
        assert!(!is_web_address("https:///path"));
        assert!(!is_web_address("https://exa mple.com"));
        assert!(!is_web_address(&format!(
            "https://example.com/{}",
            "a".repeat(MAX_ADDRESS_LEN)
        )));
    }

    #[test]
    fn the_command_refuses_what_the_policy_refuses() {
        let error = open_web_address("javascript:alert(1)").expect_err("refused");
        assert_eq!(error.code, INVALID_INPUT);
    }
}
