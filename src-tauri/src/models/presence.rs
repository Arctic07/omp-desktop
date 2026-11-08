use serde::Serialize;

/// The answer to `presence_get` / `presence_set`: whether closing the window leaves the
/// application running in the system tray.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PresenceSettings {
    pub(crate) close_to_tray: bool,
}
