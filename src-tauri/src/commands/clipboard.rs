use crate::errors::IpcError;
use crate::services::clipboard;

/// Replace the clipboard with a copy's text and its files.
///
/// The renderer can write text on its own, but not a file list: `CF_HDROP` has no web clipboard
/// equivalent, so a copy that carries images or files — a message's attachments, a draft's chips —
/// comes here to publish them. Reading and writing the clipboard is blocking OS work, so it runs
/// off the async runtime.
///
/// `Ok(false)` means the clipboard refused the write (another process held it, or the text was past
/// the size it takes); the caller then writes the words through the web API, which is what a copy
/// with no files would have done anyway.
#[tauri::command]
pub(crate) async fn copy_text_and_files(
    text: String,
    files: Vec<String>,
) -> Result<bool, IpcError> {
    if files.len() > clipboard::COPIED_FILES_MAX {
        return Err(IpcError::new(
            "INVALID_INPUT",
            "Too many files in one copy.",
        ));
    }
    tauri::async_runtime::spawn_blocking(move || clipboard::copy_text_and_files(&text, &files))
        .await
        .map_err(|_| IpcError::new("CLIPBOARD_TASK_FAILED", "Clipboard task failed."))
}

/// The clipboard's own text, for a paste the webview reports as files only.
///
/// A clipboard that holds a file list hides its text from the page: Chromium - the engine inside
/// WebView2 - exposes `Files` and no `text/plain` for `CF_HDROP` + `CF_UNICODETEXT` (measured
/// 2026-10-24), so a copy this app wrote as "words and files" — a message with an image, pasted
/// back — would arrive as the image alone.
/// The words are still on the clipboard, and this is where the composer reads them back.
///
/// An empty string is the honest answer for "nothing to recover": no text, a clipboard another
/// process is holding, one past the size this build takes, or a platform whose clipboard this build
/// cannot read. None of those is a paste failure — the files part of the paste is unaffected.
#[tauri::command]
pub(crate) async fn read_clipboard_text() -> Result<String, IpcError> {
    tauri::async_runtime::spawn_blocking(clipboard::text)
        .await
        .map_err(|_| IpcError::new("CLIPBOARD_TASK_FAILED", "Clipboard task failed."))
        .map(|found| match found {
            clipboard::ClipboardText::Text(text) => text,
            clipboard::ClipboardText::Empty
            | clipboard::ClipboardText::Unreadable
            | clipboard::ClipboardText::TooLarge => String::new(),
        })
}
