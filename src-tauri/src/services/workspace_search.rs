/**
 * Workspace search: the content search behind the file panel, and the path completion behind the
 * composer's `@` picker.
 *
 * Both read the same traversal - the git listing when the workspace is a repository, a bounded
 * walk of the directory tree when it is not - and both answer only with paths a caller may open:
 * relative, inside the root, through no symlink. What differs is what each does with a path. The
 * content search reads the file and reports the lines that matched, which is what a search result
 * page is. The path completion ranks the path itself and never opens anything, because a mention
 * is a reference to a file, and a file whose contents happen to contain the query is not one.
 */
use std::{
    fs::{self, File},
    io::{BufReader, Read},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
};

use crate::models::{WorkspaceSearchMatch, WorkspaceSearchResult};
use crate::services::runtime::host::process::hide_console;

use super::workspace::{
    canonical_workspace_root, ignored_name, image_mime, path_is_within_root, safe_git_path,
};

const SEARCH_RESULT_DEFAULT_LIMIT: usize = 200;
const SEARCH_RESULT_MAX_LIMIT: usize = 500;
const SEARCH_FILE_LIMIT: usize = 10_000;
const SEARCH_ENTRY_LIMIT: usize = 50_000;
const SEARCH_FILE_BYTES_LIMIT: usize = 2 * 1024 * 1024;
const SEARCH_LINE_BYTES_LIMIT: usize = 64 * 1024;
const SEARCH_SNIPPET_BYTES_LIMIT: usize = 4 * 1024;
const SEARCH_GIT_OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
const SEARCH_BUFFER_BYTES: usize = 8 * 1024;

/// One content search in flight: the query in its comparison form, the matches collected so far,
/// and the two ceilings the walk holds itself to.
struct WorkspaceSearchState {
    query: String,
    max_results: usize,
    matches: Vec<WorkspaceSearchMatch>,
    truncated: bool,
    scanned_files: usize,
}

impl WorkspaceSearchState {
    fn new(query: String, max_results: usize) -> Self {
        Self {
            query,
            max_results,
            matches: Vec::with_capacity(
                max_results
                    .saturating_add(1)
                    .min(SEARCH_RESULT_DEFAULT_LIMIT + 1),
            ),
            truncated: false,
            scanned_files: 0,
        }
    }

    fn at_limit(&self) -> bool {
        self.matches.len() > self.max_results
    }

    fn push_match(&mut self, search_match: WorkspaceSearchMatch) {
        if self.at_limit() {
            self.truncated = true;
            return;
        }
        self.matches.push(search_match);
    }

    fn into_result(mut self) -> WorkspaceSearchResult {
        let overflowed = self.matches.len() > self.max_results;
        self.matches.truncate(self.max_results);
        WorkspaceSearchResult {
            matches: self.matches,
            truncated: self.truncated || overflowed,
            scanned_files: self.scanned_files,
        }
    }
}

fn normalized_search_relative_path(path: &Path) -> Option<String> {
    let mut normalized = String::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(name) => {
                let name = name.to_str()?;
                if !normalized.is_empty() {
                    normalized.push('/');
                }
                normalized.push_str(name);
            }
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

pub(super) fn bounded_git_file_list(root: &Path) -> Option<(Vec<u8>, bool)> {
    let mut command = Command::new("git");
    command
        .args(["ls-files", "-co", "--exclude-standard", "-z"])
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide_console(&mut command);
    let mut child = command.spawn().ok()?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    };

    let mut reader = BufReader::with_capacity(
        SEARCH_BUFFER_BYTES,
        stdout.take((SEARCH_GIT_OUTPUT_LIMIT + 1) as u64),
    );
    let mut data = Vec::with_capacity(SEARCH_GIT_OUTPUT_LIMIT.min(64 * 1024));
    if reader.read_to_end(&mut data).is_err() {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    }

    let exceeded = data.len() > SEARCH_GIT_OUTPUT_LIMIT;
    if exceeded {
        let _ = child.kill();
    }
    let status = child.wait().ok()?;
    data.truncate(SEARCH_GIT_OUTPUT_LIMIT);

    if status.success() || exceeded {
        Some((data, exceeded))
    } else {
        None
    }
}

fn search_line_text(bytes: &[u8]) -> Result<&str, ()> {
    let text_bytes = if bytes.last().copied() == Some(b'\r') {
        &bytes[..bytes.len().saturating_sub(1)]
    } else {
        bytes
    };
    match std::str::from_utf8(text_bytes) {
        Ok(text) => Ok(text),
        Err(error) if error.error_len().is_none() => {
            std::str::from_utf8(&text_bytes[..error.valid_up_to()]).map_err(|_| ())
        }
        Err(_) => Err(()),
    }
}

fn original_byte_index_for_lowered(text: &str, lowered_index: usize) -> usize {
    let mut lowered_offset = 0;
    for (original_index, character) in text.char_indices() {
        for lowered_character in character.to_lowercase() {
            let lowered_length = lowered_character.len_utf8();
            if lowered_index < lowered_offset + lowered_length {
                return original_index;
            }
            lowered_offset += lowered_length;
        }
    }
    text.len()
}

fn bounded_search_snippet(text: &str) -> String {
    if text.len() <= SEARCH_SNIPPET_BYTES_LIMIT {
        return text.to_owned();
    }

    let mut end = SEARCH_SNIPPET_BYTES_LIMIT.saturating_sub('…'.len_utf8());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    let mut snippet = String::with_capacity(end + '…'.len_utf8());
    snippet.push_str(&text[..end]);
    snippet.push('…');
    snippet
}

fn content_search_match(
    path: &str,
    line_number: usize,
    line: &[u8],
    query: &str,
) -> Result<Option<WorkspaceSearchMatch>, ()> {
    let text = search_line_text(line)?;
    let lowered = text.to_lowercase();
    let Some(lowered_index) = lowered.find(query) else {
        return Ok(None);
    };
    let original_index = original_byte_index_for_lowered(text, lowered_index);
    let column = text[..original_index].chars().count() + 1;

    Ok(Some(WorkspaceSearchMatch {
        kind: "content".to_owned(),
        path: path.to_owned(),
        line: Some(line_number),
        column: Some(column),
        snippet: Some(bounded_search_snippet(text)),
    }))
}

fn scan_workspace_file(
    path: &Path,
    relative_path: &str,
    file_size: u64,
    state: &mut WorkspaceSearchState,
) {
    let remaining = state
        .max_results
        .saturating_add(1)
        .saturating_sub(state.matches.len());
    if remaining == 0 {
        return;
    }

    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return,
    };
    let limited_file = file.take(SEARCH_FILE_BYTES_LIMIT as u64);
    let mut reader = BufReader::with_capacity(SEARCH_BUFFER_BYTES, limited_file);
    let mut buffer = [0_u8; SEARCH_BUFFER_BYTES];
    let mut line = Vec::with_capacity(SEARCH_LINE_BYTES_LIMIT.min(4096));
    let mut line_number = 1;
    let mut pending_matches = Vec::with_capacity(remaining.min(16));
    let mut stop_at_result_limit = false;

    'scan: loop {
        let read = match reader.read(&mut buffer) {
            Ok(read) => read,
            Err(_) => return,
        };
        if read == 0 {
            break;
        }

        for byte in &buffer[..read] {
            if *byte == 0 {
                return;
            }
            if *byte == b'\n' {
                match content_search_match(relative_path, line_number, &line, &state.query) {
                    Ok(Some(search_match)) => {
                        pending_matches.push(search_match);
                        if pending_matches.len() >= remaining {
                            stop_at_result_limit = true;
                            break 'scan;
                        }
                    }
                    Ok(None) => {}
                    Err(_) => return,
                }
                line.clear();
                line_number = line_number.saturating_add(1);
            } else if line.len() < SEARCH_LINE_BYTES_LIMIT {
                line.push(*byte);
            }
        }
    }

    if !stop_at_result_limit && !line.is_empty() {
        match content_search_match(relative_path, line_number, &line, &state.query) {
            Ok(Some(search_match)) => pending_matches.push(search_match),
            Ok(None) => {}
            Err(_) => return,
        }
    }

    for search_match in pending_matches {
        state.push_match(search_match);
    }
    if file_size > SEARCH_FILE_BYTES_LIMIT as u64 {
        state.truncated = true;
    }
}

/// One workspace file a search may use: its canonical path, its relative path and its size.
///
/// Both searches admit a file through the same checks - relative, inside the root through no
/// symlink, a regular file - because both hand it to something that opens it: the content search
/// reads it, and the path completion offers it to a UI that will.
pub(super) fn admit_workspace_file(root: &Path, raw_path: &str) -> Option<(PathBuf, String, u64)> {
    let relative = Path::new(raw_path);
    if !safe_git_path(root, raw_path) {
        return None;
    }
    let relative_path = normalized_search_relative_path(relative)?;
    let candidate = root.join(relative);
    let link_metadata = fs::symlink_metadata(&candidate).ok()?;
    if link_metadata.file_type().is_symlink() {
        return None;
    }

    let canonical = candidate.canonicalize().ok()?;
    if !canonical.starts_with(root) {
        return None;
    }
    let metadata = fs::metadata(&canonical).ok()?;
    if !metadata.is_file() {
        return None;
    }
    Some((canonical, relative_path, metadata.len()))
}

fn search_workspace_candidate(
    root: &Path,
    raw_path: &str,
    state: &mut WorkspaceSearchState,
) -> bool {
    if state.at_limit() {
        return false;
    }

    let Some((canonical, relative_path, size)) = admit_workspace_file(root, raw_path) else {
        return true;
    };
    if state.scanned_files >= SEARCH_FILE_LIMIT {
        state.truncated = true;
        return false;
    }
    state.scanned_files += 1;

    if relative_path.to_lowercase().contains(&state.query) {
        state.push_match(WorkspaceSearchMatch {
            kind: "path".to_owned(),
            path: relative_path.clone(),
            line: None,
            column: None,
            snippet: None,
        });
        if state.at_limit() {
            return false;
        }
    }

    if image_mime(&canonical).is_none() {
        scan_workspace_file(&canonical, &relative_path, size, state);
    }
    !state.at_limit()
}

/// Walks the workspace for its files, answering each one to `visit`; `false` stops the walk.
///
/// This is the route a workspace without git takes, so it admits exactly what the git listing
/// route admits: relative names only, nothing behind a symlink, nothing outside the root, and the
/// ignored names dropped. Returns true when the walk stopped at its entry ceiling, which is the
/// one truncation the walker itself can report.
pub(super) fn walk_workspace_files(root: &Path, visit: &mut impl FnMut(&str) -> bool) -> bool {
    let mut directories = vec![root.to_path_buf()];
    let mut entries_seen = 0;

    while let Some(directory) = directories.pop() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries {
            entries_seen += 1;
            if entries_seen > SEARCH_ENTRY_LIMIT {
                return true;
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            let name = entry.file_name();
            if ignored_name(&name) {
                continue;
            }
            let child = entry.path();
            let metadata = match fs::symlink_metadata(&child) {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            if metadata.file_type().is_symlink() {
                continue;
            }

            let Ok(relative) = child.strip_prefix(root) else {
                continue;
            };
            let Some(relative_path) = normalized_search_relative_path(relative) else {
                continue;
            };
            if !path_is_within_root(root, relative) {
                continue;
            }
            if metadata.is_dir() {
                directories.push(child);
            } else if metadata.is_file() && !visit(&relative_path) {
                return false;
            }
        }
    }
    false
}

fn search_workspace_fallback(root: &Path, state: &mut WorkspaceSearchState) {
    let walk_truncated = walk_workspace_files(root, &mut |relative_path| {
        !state.at_limit() && search_workspace_candidate(root, relative_path, state)
    });
    if walk_truncated {
        state.truncated = true;
    }
}

fn search_workspace_files_blocking(
    root: String,
    query: String,
    max_results: Option<usize>,
) -> Result<WorkspaceSearchResult, String> {
    let normalized_query = query.trim().to_lowercase();
    if normalized_query.is_empty() {
        return Ok(WorkspaceSearchResult {
            matches: Vec::new(),
            truncated: false,
            scanned_files: 0,
        });
    }

    let canonical_root = canonical_workspace_root(&root)?;
    let max_results = max_results
        .unwrap_or(SEARCH_RESULT_DEFAULT_LIMIT)
        .min(SEARCH_RESULT_MAX_LIMIT);
    if max_results == 0 {
        return Ok(WorkspaceSearchResult {
            matches: Vec::new(),
            truncated: true,
            scanned_files: 0,
        });
    }

    let mut state = WorkspaceSearchState::new(normalized_query, max_results);
    if let Some((data, output_truncated)) = bounded_git_file_list(&canonical_root) {
        let complete_end = data
            .iter()
            .rposition(|byte| *byte == 0)
            .map(|index| index + 1)
            .unwrap_or(0);
        for raw_path in data[..complete_end].split(|byte| *byte == 0) {
            let Ok(raw_path) = std::str::from_utf8(raw_path) else {
                continue;
            };
            if raw_path.is_empty() {
                continue;
            }
            if !search_workspace_candidate(&canonical_root, raw_path, &mut state) {
                break;
            }
        }
        if output_truncated {
            state.truncated = true;
        }
    } else {
        search_workspace_fallback(&canonical_root, &mut state);
    }

    Ok(state.into_result())
}

pub(crate) async fn search_workspace_files(
    root: String,
    query: String,
    max_results: Option<usize>,
) -> Result<WorkspaceSearchResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        search_workspace_files_blocking(root, query, max_results)
    })
    .await
    .map_err(|_| "Workspace search task failed".to_owned())?
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use super::search_workspace_files_blocking;

    fn scratch(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("omp-wssearch-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("workspace scratch");
        root
    }

    fn write(root: &Path, relative: &str, content: &str) {
        let file = root.join(relative);
        fs::create_dir_all(file.parent().expect("target directory")).expect("workspace directory");
        fs::write(&file, content).expect("workspace file");
    }

    /// The content search keeps its own contract: a path match and a content match both travel,
    /// and a binary file is never searched.
    #[test]
    fn the_content_search_still_reports_path_and_content_matches() {
        let root = scratch("content-search");
        write(&root, "src/store.ts", "let q = 1;\n");
        write(&root, "docs/notes.md", "the store is open\n");
        write(&root, "blob.bin", "\0store\n");

        let result = search_workspace_files_blocking(
            root.to_string_lossy().into_owned(),
            "store".to_owned(),
            Some(20),
        )
        .expect("content search");
        let kinds: Vec<(&str, &str)> = result
            .matches
            .iter()
            .map(|search_match| (search_match.kind.as_str(), search_match.path.as_str()))
            .collect();
        assert!(kinds.contains(&("path", "src/store.ts")), "{kinds:?}");
        assert!(kinds.contains(&("content", "docs/notes.md")), "{kinds:?}");
        assert!(
            !kinds.iter().any(|(_, path)| *path == "blob.bin"),
            "a binary file has no lines to report: {kinds:?}"
        );
    }
}
