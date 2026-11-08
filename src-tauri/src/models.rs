pub(crate) mod agent;
pub(crate) mod capabilities;
pub(crate) mod omp_import;
pub(crate) mod plugins;
pub(crate) mod presence;
pub(crate) mod store;
pub(crate) mod update;

use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub(crate) struct FileEntry {
    pub(crate) name: String,
    pub(crate) kind: String,
    pub(crate) size: u64,
}

#[derive(Serialize)]
pub(crate) struct ListWorkspaceEntriesResult {
    pub(crate) entries: Vec<FileEntry>,
}

#[derive(Serialize)]
pub(crate) struct FileReadResult {
    pub(crate) kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) content: Option<String>,
    #[serde(rename = "dataUrl", skip_serializing_if = "Option::is_none")]
    pub(crate) data_url: Option<String>,
    pub(crate) size: u64,
}

#[derive(Serialize)]
pub(crate) struct ReviewLine {
    #[serde(rename = "type")]
    pub(crate) line_type: String,
    pub(crate) text: String,
}

#[derive(Serialize)]
pub(crate) struct ReviewHunk {
    pub(crate) header: String,
    pub(crate) lines: Vec<ReviewLine>,
}

#[derive(Serialize)]
pub(crate) struct ReviewFile {
    pub(crate) path: String,
    #[serde(rename = "oldPath", skip_serializing_if = "Option::is_none")]
    pub(crate) old_path: Option<String>,
    pub(crate) status: String,
    pub(crate) additions: usize,
    pub(crate) deletions: usize,
    pub(crate) binary: bool,
    #[serde(rename = "tooLarge")]
    pub(crate) too_large: bool,
    pub(crate) hunks: Vec<ReviewHunk>,
}

/// How far this branch and its upstream have drifted apart, as git records it locally.
#[derive(Serialize)]
pub(crate) struct WorkspaceBranch {
    /// The upstream ref the way git names it (`origin/master`).
    pub(crate) upstream: String,
    /// Commits this branch has that the upstream does not.
    pub(crate) ahead: u32,
    /// Commits the upstream has that this branch does not.
    pub(crate) behind: u32,
}

/// One local branch, as the sidebar's branch picker lists it.
#[derive(Serialize)]
pub(crate) struct RepositoryBranch {
    pub(crate) name: String,
    /// The branch's last commit time, in Unix seconds; `0` when git reports none.
    #[serde(rename = "updatedAt")]
    pub(crate) updated_at: i64,
    /// That commit's subject line.
    pub(crate) subject: String,
    pub(crate) author: String,
    /// Whether this is the branch HEAD points at.
    pub(crate) current: bool,
}

/// What the sidebar's branch picker draws: the repository, where HEAD is, and its local branches.
#[derive(Serialize)]
pub(crate) struct WorkspaceBranches {
    /// The repository directory's own name, for the row's second line.
    #[serde(rename = "repoName")]
    pub(crate) repo_name: String,
    /// The checked-out branch; `None` is a detached HEAD.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) current: Option<String>,
    /// The short commit HEAD points at when it is detached.
    #[serde(rename = "detachedAt", skip_serializing_if = "Option::is_none")]
    pub(crate) detached_at: Option<String>,
    /// How far the checked-out branch and its upstream have drifted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) sync: Option<WorkspaceBranch>,
    pub(crate) branches: Vec<RepositoryBranch>,
}

#[derive(Serialize)]
pub(crate) struct WorkspaceReview {
    pub(crate) repo: bool,
    pub(crate) clean: bool,
    #[serde(rename = "stagedFiles")]
    pub(crate) staged_files: Vec<ReviewFile>,
    #[serde(rename = "unstagedFiles")]
    pub(crate) unstaged_files: Vec<ReviewFile>,
    pub(crate) truncated: bool,
    /// The repository root every [`ReviewFile::path`] is named against; `None` when this workspace
    /// is not inside a working tree, or when the review carries no rows to name.
    ///
    /// `git status` prints a path relative to the repository whatever directory it ran in, while
    /// the frontend only holds the workspace root - so a workspace that is a *subdirectory* of its
    /// repository needs this root to turn a row back into the file on disk.
    #[serde(rename = "repositoryRoot", skip_serializing_if = "Option::is_none")]
    pub(crate) repository_root: Option<String>,
    /// The commit HEAD points at (the whole object name), or `None` when the repository has no
    /// commit yet. A moved HEAD is the panel's signal that the tree its message box described was
    /// committed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) head: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) branch: Option<WorkspaceBranch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct WorkspaceReviewDelta {
    #[serde(rename = "stagedFiles")]
    pub(crate) staged_files: Vec<ReviewFile>,
    #[serde(rename = "unstagedFiles")]
    pub(crate) unstaged_files: Vec<ReviewFile>,
}

#[derive(Serialize)]
pub(crate) struct WorkspaceSearchMatch {
    pub(crate) kind: String,
    pub(crate) path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) snippet: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct WorkspaceSearchResult {
    pub(crate) matches: Vec<WorkspaceSearchMatch>,
    pub(crate) truncated: bool,
    #[serde(rename = "scannedFiles")]
    pub(crate) scanned_files: usize,
}

/// The answer to a path completion: workspace-relative files whose path matched the query.
///
/// Only paths, because this is the answer the `@` picker in the composer draws: a file is named,
/// never quoted, and the picker attaches it by path.
#[derive(Serialize)]
pub(crate) struct WorkspacePathSearchResult {
    pub(crate) paths: Vec<String>,
    /// True when the workspace held more matching files than the answer was allowed to carry.
    pub(crate) truncated: bool,
}

/// The applications this machine can open a workspace directory with, in menu order.
///
/// Only ids: the page owns the names (`i18nCopyZh`/`En`), and an id the page cannot name stays off
/// the menu rather than appearing as a raw token.
#[derive(Serialize)]
pub(crate) struct OpenInAppAppsResult {
    pub(crate) apps: Vec<String>,
}

/// One application's own icon, as a `data:` URL the menu row draws directly.
#[derive(Serialize)]
pub(crate) struct OpenInAppIconResult {
    #[serde(rename = "dataUrl")]
    pub(crate) data_url: String,
}

#[derive(Serialize)]
pub(crate) struct RevealWorkspaceFileResult {
    pub(crate) ok: bool,
}

#[derive(Deserialize)]
pub(crate) struct ComposerPasteFile {
    #[serde(default, rename = "name")]
    pub(crate) name: Option<String>,
    #[serde(default, rename = "mimeType")]
    pub(crate) mime_type: Option<String>,
    #[serde(rename = "data")]
    pub(crate) data: String,
}

#[derive(Serialize)]
pub(crate) struct ComposerAttachment {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) kind: String,
    #[serde(rename = "mimeType")]
    pub(crate) mime_type: String,
    pub(crate) size: u64,
}

#[derive(Serialize)]
pub(crate) struct ImportComposerFilesResult {
    pub(crate) files: Vec<ComposerAttachment>,
    #[serde(rename = "skippedDirectories")]
    pub(crate) skipped_directories: usize,
}

/// One pasted file as the renderer saw it: the leaf name it has and the byte length it read.
#[derive(Deserialize)]
pub(crate) struct ClipboardFileQuery {
    pub(crate) name: String,
    pub(crate) size: u64,
}

/// A shell that was just started: the id every later call on that tab carries, and the label the
/// tab draws (the page owns no shell detection of its own).
#[derive(Serialize)]
pub(crate) struct TerminalOpened {
    pub(crate) id: String,
    pub(crate) shell: String,
    #[serde(rename = "ownerSessionId")]
    pub(crate) owner_session_id: String,
    #[serde(rename = "ownerSessionFile")]
    pub(crate) owner_session_file: String,
    #[serde(rename = "workspaceKey")]
    pub(crate) workspace_key: String,
    pub(crate) cwd: String,
}

/// One frame of a terminal's stream: what the shell printed, or the exit that ends the stream.
///
/// Output travels as base64 because a pty read is arbitrary bytes and the stream is JSON; one
/// frame is one read, so the page appends them in order.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum TerminalFrame {
    Data { data: String },
    Exit { code: i32 },
}

#[derive(Clone, Serialize)]
pub(crate) struct TerminalSummaryDto {
    pub(crate) id: String,
    pub(crate) shell: String,
    pub(crate) cwd: String,
    #[serde(rename = "ownerSessionId")]
    pub(crate) owner_session_id: String,
    #[serde(rename = "ownerSessionFile")]
    pub(crate) owner_session_file: String,
    #[serde(rename = "workspaceKey")]
    pub(crate) workspace_key: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum TerminalUiEvent {
    Open {
        terminal: TerminalSummaryDto,
    },
    Exit {
        terminal: TerminalSummaryDto,
        code: i32,
    },
}

/// Which producer wrote a log file: this application's own two files, or the engine host's own log.
///
/// The page lists both in one table, because a report is read from both and a reader should not have
/// to know which process wrote a line before finding the file it is in.
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub(crate) enum LogFileSource {
    App,
    Engine,
}

/// One file in a logs directory, as the settings row lists it.
#[derive(Serialize)]
pub(crate) struct LogFileInfo {
    pub(crate) name: String,
    pub(crate) bytes: u64,
    /// When the file was last written, in milliseconds since the Unix epoch.
    #[serde(rename = "modifiedMs")]
    pub(crate) modified_ms: u64,
    pub(crate) source: LogFileSource,
}

/// Where the logs live, what the directories hold and what the caches weigh: everything the settings
/// page needs before it offers to open or to clear anything.
#[derive(Serialize)]
pub(crate) struct LogsOverview {
    pub(crate) directory: String,
    /// The engine's own directory: the SDK writes its per-process logs there, and it cannot be
    /// merged into `directory` (see `DataPaths::engine_logs`).
    #[serde(rename = "engineDirectory")]
    pub(crate) engine_directory: String,
    pub(crate) files: Vec<LogFileInfo>,
    #[serde(rename = "cacheBytes")]
    pub(crate) cache_bytes: u64,
}

/// The directory the file manager was handed, and whether it took it.
#[derive(Serialize)]
pub(crate) struct OpenLogsResult {
    pub(crate) path: String,
    pub(crate) opened: bool,
}

/// What one clear freed and what it left behind, so the page reports both without a second walk.
#[derive(Serialize)]
pub(crate) struct ClearOutcome {
    #[serde(rename = "freedBytes")]
    pub(crate) freed_bytes: u64,
    #[serde(rename = "remainingBytes")]
    pub(crate) remaining_bytes: u64,
    /// The part of `freedBytes` the engine reclaimed in its own tree.
    ///
    /// Its own answer rather than a subtraction: a page that reports "731 MB freed" over a clear
    /// that only touched this application's profiles would be claiming work the engine did not do.
    /// Zero when the host is not running - the rest of the clear still happened.
    #[serde(rename = "engineFreedBytes")]
    pub(crate) engine_freed_bytes: u64,
    /// The bytes the engine kept, and the one line that says why an entry was kept.
    #[serde(rename = "engineSkippedBytes")]
    pub(crate) engine_skipped_bytes: u64,
}
