//! What this application grants the webview stack, and why the answer is almost always "nothing".
//!
//! The engine's own permission model (`agent.extension`) and the plugin bridge (§6.2/§6.3) decide
//! what a plugin may *do*; this module decides what the *browser* may hand out underneath them, which
//! is a different question with a different answer. A webview permission is granted to a document by
//! the platform (WebView2 on Windows, WebKitGTK, WKWebView), it is remembered by that platform
//! between launches, and it is invisible to everything this application audits - so a plugin page
//! that reaches a microphone through it has left the permission matrix entirely.
//!
//! Two postures, one file, because they are one decision:
//!
//! - **A plugin's own window gets nothing.** A panel window is a top-level document of the plugin's
//!   own origin, so the browser would ask *it* for a microphone, a camera, a location, a screen
//!   capture, MIDI, a sensor, a clipboard read, a notification - and hand it over on the platform's
//!   own prompt. Everything a plugin legitimately needs already has a gated channel (the bridge), so
//!   the answer to every kind is a refusal: the permission matrix stays the only way in.
//! - **The application keeps the platform's default, except for the device kinds.** The application
//!   itself uses no microphone, camera, location, screen capture, MIDI or sensor - it says so here
//!   rather than in a prompt the user would have to answer - while the clipboard and notification
//!   APIs it *does* use (`navigator.clipboard` for the composer and the terminal, notifications for
//!   the host's own notices) keep working exactly as before.
//!
//! The docked pages (a view, a settings page, a sidebar tab) live in the main window's webview, so
//! they fall under the application's posture rather than a window's. What keeps them out of the
//! clipboard there is the browser itself: `clipboard-read` is not granted to a cross-origin frame, and
//! the frame is cross-origin by construction (§7.2).

use tauri::webview::{PermissionKind, PermissionResponse};

/// What one permission request from a *plugin's own window* is answered with.
///
/// Every kind, including the ones the application itself keeps: a plugin page has the bridge for
/// what it needs, and the bridge is where the permission matrix, the first-use questions and the
/// audit live.
pub(crate) fn for_plugin_window(_kind: PermissionKind) -> PermissionResponse {
    PermissionResponse::Deny
}

/// What one permission request from the *application's own* documents is answered with.
///
/// The device kinds are refused outright - the application asks for none of them, so a request can
/// only come from a page this application did not write - and everything else keeps the platform's
/// default, which is what the clipboard and notification APIs the application does use rely on.
pub(crate) fn for_application(kind: PermissionKind) -> PermissionResponse {
    if asks_for_a_device(kind) {
        return PermissionResponse::Deny;
    }
    PermissionResponse::Default
}

/// Whether one kind names a device this application never asks for.
///
/// Kept as its own list rather than an exhaustive match on purpose: a kind a future `wry` adds is one
/// this build has no opinion about, and the platform's default is the honest answer for it - while a
/// *device* kind is refused whatever the platform would have said.
fn asks_for_a_device(kind: PermissionKind) -> bool {
    matches!(
        kind,
        PermissionKind::Microphone
            | PermissionKind::Camera
            | PermissionKind::Geolocation
            | PermissionKind::DisplayCapture
            | PermissionKind::Midi
            | PermissionKind::Sensors
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A plugin window is refused everything, including the kinds the application keeps for itself.
    #[test]
    fn a_plugin_window_is_granted_nothing() {
        for kind in [
            PermissionKind::Microphone,
            PermissionKind::Camera,
            PermissionKind::Geolocation,
            PermissionKind::Notifications,
            PermissionKind::ClipboardRead,
            PermissionKind::DisplayCapture,
            PermissionKind::Midi,
            PermissionKind::Sensors,
        ] {
            assert_eq!(for_plugin_window(kind), PermissionResponse::Deny);
        }
    }

    /// The application refuses the device kinds and keeps the platform's default for the rest, which
    /// is what its own clipboard and notification use depends on.
    #[test]
    fn the_application_refuses_devices_and_keeps_the_platform_default_otherwise() {
        for kind in [
            PermissionKind::Microphone,
            PermissionKind::Camera,
            PermissionKind::Geolocation,
            PermissionKind::DisplayCapture,
            PermissionKind::Midi,
            PermissionKind::Sensors,
        ] {
            assert_eq!(for_application(kind), PermissionResponse::Deny, "{kind:?}");
        }
        for kind in [PermissionKind::ClipboardRead, PermissionKind::Notifications] {
            assert_eq!(
                for_application(kind),
                PermissionResponse::Default,
                "{kind:?}"
            );
        }
    }
}
