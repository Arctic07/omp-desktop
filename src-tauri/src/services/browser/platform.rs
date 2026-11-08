//! Platform facts the browser page needs without owning a webview.
//!
//! Split from `page` (`rules.md#single-file-line-limit`): the WebView2 error status is a protocol vocabulary, not a
//! page's state, and the page only needs the Chromium-style label the chrome and the agent read.

use tauri::{AppHandle, Manager, Window};

/// The Chromium-style error label for one WebView2 `COREWEBVIEW2_WEB_ERROR_STATUS` value.
///
/// The label is Chromium's own name (`ERR_NAME_NOT_RESOLVED`), so
/// the chrome's failure copy and the agent's `state` read the same vocabulary on this platform.
#[cfg(windows)]
pub(crate) fn web_error_label(status: i32) -> Option<String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    let label = match status {
        value if value == COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN.0 => "ERR_FAILED",
        value if value == COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_COMMON_NAME_IS_INCORRECT.0 => {
            "ERR_CERT_COMMON_NAME_INVALID"
        }
        value if value == COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_EXPIRED.0 => {
            "ERR_CERT_DATE_INVALID"
        }
        value if value == COREWEBVIEW2_WEB_ERROR_STATUS_CLIENT_CERTIFICATE_CONTAINS_ERRORS.0 => {
            "ERR_BAD_SSL_CLIENT_AUTH_CERT"
        }
        value if value == COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_REVOKED.0 => "ERR_CERT_REVOKED",
        value if value == COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_IS_INVALID.0 => {
            "ERR_CERT_AUTHORITY_INVALID"
        }
        value if value == COREWEBVIEW2_WEB_ERROR_STATUS_SERVER_UNREACHABLE.0 => {
            "ERR_ADDRESS_UNREACHABLE"
        }
        value if value == COREWEBVIEW2_WEB_ERROR_STATUS_TIMEOUT.0 => "ERR_TIMED_OUT",
        value if value == COREWEBVIEW2_WEB_ERROR_STATUS_ERROR_HTTP_INVALID_SERVER_RESPONSE.0 => {
            "ERR_INVALID_HTTP_RESPONSE"
        }
        value if value == COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_ABORTED.0 => {
            "ERR_CONNECTION_ABORTED"
        }
        value if value == COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_RESET.0 => {
            "ERR_CONNECTION_RESET"
        }
        value if value == COREWEBVIEW2_WEB_ERROR_STATUS_DISCONNECTED.0 => "ERR_CONNECTION_CLOSED",
        value if value == COREWEBVIEW2_WEB_ERROR_STATUS_CANNOT_CONNECT.0 => {
            "ERR_CONNECTION_REFUSED"
        }
        value if value == COREWEBVIEW2_WEB_ERROR_STATUS_HOST_NAME_NOT_RESOLVED.0 => {
            "ERR_NAME_NOT_RESOLVED"
        }
        value if value == COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED.0 => "ERR_ABORTED",
        value if value == COREWEBVIEW2_WEB_ERROR_STATUS_REDIRECT_FAILED.0 => {
            "ERR_TOO_MANY_REDIRECTS"
        }
        value
            if value
                == COREWEBVIEW2_WEB_ERROR_STATUS_VALID_AUTHENTICATION_CREDENTIALS_REQUIRED.0 =>
        {
            "ERR_HTTP_AUTH_REQUIRED"
        }
        value if value == COREWEBVIEW2_WEB_ERROR_STATUS_VALID_PROXY_AUTHENTICATION_REQUIRED.0 => {
            "ERR_PROXY_AUTH_UNSUPPORTED"
        }
        _ => return None,
    };
    Some(label.to_owned())
}

#[cfg(not(windows))]
pub(crate) fn web_error_label(_status: i32) -> Option<String> {
    None
}

/// The hidden window a page is parked in, when one exists.
pub(crate) fn backing_window(app: &AppHandle) -> Option<Window> {
    if let Some(window) = app.get_window("browser-backing") {
        return Some(window);
    }
    let builder = tauri::window::WindowBuilder::new(app, "browser-backing")
        .title("OMP Browser")
        .decorations(false)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .inner_size(1024.0, 768.0);
    // The backing window is never shown. A visible off-screen window is still a real top-level
    // window on Windows (the window manager clamps negative positions onto the desktop), which put
    // a white guest window over the app. The guest's controller is kept visible instead, so CDP
    // capture and the accessibility tree keep working without a window on the reader's screen.
    builder.visible(false).build().ok()
}
