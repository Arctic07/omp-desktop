use tauri::State;

use crate::errors::IpcError;
use crate::models::{
    ClipboardFileQuery, ComposerAttachment, ComposerPasteFile, ImportComposerFilesResult,
};
use crate::services::{attachments, clipboard};
use crate::state::AppState;

/// How many files one paste may ask about. A clipboard holding a file list is a user action; the
/// cap keeps a renderer from turning one command into an unbounded walk.
const MAX_CLIPBOARD_QUERY_FILES: usize = 256;

fn attachment_error(message: String) -> IpcError {
    IpcError::from_message("ATTACHMENT_OPERATION_FAILED", message)
}

#[tauri::command]
pub(crate) async fn save_composer_paste(
    state: State<'_, AppState>,
    session_id: String,
    files: Vec<ComposerPasteFile>,
) -> Result<Vec<ComposerAttachment>, IpcError> {
    // Attachments live under the application data root, next to every other owned file.
    let scratch = state.paths.scratch.clone();
    tauri::async_runtime::spawn_blocking(move || {
        attachments::save_composer_paste(&scratch, &session_id, files)
    })
    .await
    .map_err(|_| IpcError::new("ATTACHMENT_TASK_FAILED", "Attachment task failed."))?
    .map_err(attachment_error)
}

#[tauri::command]
pub(crate) async fn import_composer_files(
    paths: Vec<String>,
) -> Result<ImportComposerFilesResult, IpcError> {
    // The picked files are addressed where they live, so this needs no data-root argument: the
    // stat calls behind each record are the only work, and they stay off the async runtime.
    tauri::async_runtime::spawn_blocking(move || attachments::import_composer_files(paths))
        .await
        .map_err(|_| IpcError::new("ATTACHMENT_TASK_FAILED", "Attachment task failed."))?
        .map_err(attachment_error)
}

/// The real path behind each pasted file, when the platform can name one.
///
/// Windows keeps a copied file list on the clipboard (`CF_HDROP`) that the web layer cannot see; a
/// pasted file is therefore matched against it by leaf name and byte length. `null` per entry means
/// the clipboard does not name that file, so the caller keeps its bytes. Reading the clipboard is
/// blocking work on the OS, so it happens off the async runtime.
#[tauri::command]
pub(crate) async fn resolve_clipboard_file_paths(
    files: Vec<ClipboardFileQuery>,
) -> Result<Vec<Option<String>>, IpcError> {
    if files.len() > MAX_CLIPBOARD_QUERY_FILES {
        return Err(IpcError::new(
            "INVALID_INPUT",
            "Too many files in one paste.",
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let candidates = clipboard::file_list();
        let pasted: Vec<clipboard::PastedFile> = files
            .into_iter()
            .map(|file| clipboard::PastedFile {
                name: file.name,
                size: file.size,
            })
            .collect();
        clipboard::resolve_pasted(&candidates, &pasted)
    })
    .await
    .map_err(|_| IpcError::new("ATTACHMENT_TASK_FAILED", "Attachment task failed."))
}
