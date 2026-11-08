//! Workspace path identity.
//!
//! A workspace is identified by its canonical directory path: `root_key` and `root_path` are the
//! same string, and it must match the `cwd` the engine records in its session headers. Windows
//! spellings of one directory (`\\?\D:\x`, `d:\x`, `D:\x\`) therefore have to collapse to a
//! single value.

use std::path::Path;

use crate::errors::{IpcError, IpcResult, INVALID_INPUT, WORKSPACE_NOT_FOUND};

const EMPTY_PATH: &str = "The workspace path must not be empty.";
const NOT_FOUND: &str = "The workspace directory was not found.";

/// Canonical `(root_key, root_path)` for an existing workspace directory.
pub(crate) fn canonicalize_workspace(path: &str) -> IpcResult<(String, String)> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(IpcError::new(INVALID_INPUT, EMPTY_PATH));
    }
    let canonical = std::fs::canonicalize(trimmed)
        .map_err(|_| IpcError::new(WORKSPACE_NOT_FOUND, NOT_FOUND))?;
    let root = normalize_root(&canonical.to_string_lossy());
    if root.is_empty() {
        return Err(IpcError::new(WORKSPACE_NOT_FOUND, NOT_FOUND));
    }
    if !Path::new(&root).is_dir() {
        return Err(IpcError::new(WORKSPACE_NOT_FOUND, NOT_FOUND));
    }
    Ok((root.clone(), root))
}

/// Display name: the last path segment, unless it is empty or a drive root.
pub(crate) fn workspace_name(root_path: &str) -> String {
    match Path::new(root_path).file_name() {
        Some(name) if !name.is_empty() => name.to_string_lossy().into_owned(),
        _ => root_path.to_owned(),
    }
}

/// True when the registered root is no longer a usable directory.
pub(crate) fn is_missing(root_path: &str) -> bool {
    !Path::new(root_path).is_dir()
}

/// Strips the Windows verbatim prefix and unifies the drive letter and final separator.
fn normalize_root(raw: &str) -> String {
    let mut text = raw.to_owned();
    if cfg!(windows) {
        // `std::fs::canonicalize` returns verbatim paths; the engine records plain ones.
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            text = format!(r"\\{rest}");
        } else if let Some(rest) = text.strip_prefix(r"\\?\") {
            text = rest.to_owned();
        }
        let bytes = text.as_bytes();
        let upper_drive = bytes.len() >= 2 && bytes[0].is_ascii_lowercase() && bytes[1] == b':';
        if upper_drive {
            // Only the first byte changes; the rest may be non-ASCII.
            let letter = text[..1].to_ascii_uppercase();
            text.replace_range(..1, &letter);
        }
    }
    trim_trailing_separators(&text)
}

fn trim_trailing_separators(text: &str) -> String {
    let trimmed = text.trim_end_matches(['\\', '/']);
    if trimmed.is_empty() {
        // A bare separator: keep one so the result stays an absolute root.
        return if text.starts_with('/') {
            "/".to_owned()
        } else {
            "\\".to_owned()
        };
    }
    if cfg!(windows) && trimmed.ends_with(':') {
        // `C:` is drive-relative; `C:\` is the root. Keep the separator.
        return format!("{trimmed}\\");
    }
    trimmed.to_owned()
}
