//! The one command behind "open this address for me".
//!
//! The address is validated and handed to the operating system's own opener
//! (`services::system_open`); this application renders nothing of it. A malformed address is
//! refused at this boundary rather than passed to the shell.

use crate::errors::IpcResult;
use crate::services::system_open;

#[tauri::command]
pub(crate) fn open_external(url: String) -> IpcResult<()> {
    system_open::open_web_address(&url)
}
