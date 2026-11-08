//! Read-only projection of the engine's memory roots: the documents a workspace's memory lives in.
//!
//! The engine owns these files. `getMemoryRoot(agentDir, cwd)` derives the directory from the
//! working directory, and the local backend writes the documents that land in it - `MEMORY.md`,
//! `memory_summary.md` (the prompt-time summary), `raw_memories.md`, `learned.md`,
//! `rollout_summaries/*.md` and `skills/<name>/SKILL.md`. Nothing here writes, renames, repairs or
//! migrates one of them; the walk lists regular files directly under a root the host named, stat's
//! each one, and stops. A symlink is skipped rather than followed, so a link planted inside a root
//! cannot make this read reach outside it, and the engine's data directory stays read-only for
//! everything but the engine process itself.
//!
//! The root only exists for `memory.backend=local`: the other backends keep their memories in a
//! remote service or in SQLite, so a caller with no root gets no rows rather than a guess.

use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::models::capabilities::{EngineMemoryFile, EngineMemoryWorkspace};

/// Files one workspace contributes to the catalog.
///
/// The engine's own memory root holds a handful of documents, so this bound is not a page size: it
/// is the stop that keeps a root someone filled with thousands of files from turning one read into
/// an unbounded listing.
pub(crate) const MEMORY_FILE_ROWS_MAX: usize = 200;

/// One workspace to read: the store's identity for it, plus the root the host derived.
pub(crate) struct MemoryRootTarget {
    pub(crate) workspace_id: i64,
    pub(crate) label: String,
    pub(crate) cwd: String,
    pub(crate) root: String,
}

/// Reads every target's root, in the order the targets arrived.
///
/// A root that does not exist yet is a workspace the engine has not remembered anything for; it
/// answers with an empty file list rather than an error, because that is exactly what it is.
pub(crate) fn scan(targets: &[MemoryRootTarget]) -> Vec<EngineMemoryWorkspace> {
    targets
        .iter()
        .map(|target| EngineMemoryWorkspace {
            workspace_id: target.workspace_id,
            label: target.label.clone(),
            cwd: target.cwd.clone(),
            root: target.root.clone(),
            files: files_in(Path::new(&target.root)),
        })
        .collect()
}

/// The regular files directly under one root, sorted by name.
///
/// Directories are not rows: the catalog lists memory documents, and the engine's own subdirectories
/// (`rollout_summaries/`, `skills/`) hold documents that belong to a consolidation pass rather than
/// to a workspace's memory summary. Unreadable entries are skipped - one locked file must not hide
/// the rest of a root.
fn files_in(root: &Path) -> Vec<EngineMemoryFile> {
    let mut files = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return files;
    };
    for entry in entries.flatten() {
        if files.len() >= MEMORY_FILE_ROWS_MAX {
            break;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        // `is_file()` is false for a symlink even when it points at a file, which is the wanted
        // result here: a link is not one of the engine's memory documents.
        if !file_type.is_file() {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        files.push(EngineMemoryFile {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            bytes: i64::try_from(metadata.len()).unwrap_or(i64::MAX),
            modified_at_ms: modified_ms(&metadata),
        });
    }
    files.sort_by(|left, right| left.name.cmp(&right.name));
    files
}

/// Last modification in milliseconds since the epoch, or `None` when the platform will not say.
fn modified_ms(metadata: &fs::Metadata) -> Option<i64> {
    let modified = metadata.modified().ok()?;
    let elapsed = modified.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(elapsed.as_millis()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch memory root: one file per name, plus whatever the test adds to it.
    fn scratch_root(tag: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("omp-memory-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("memory root");
        root
    }

    /// The catalog lists the engine's documents: regular files directly under the root, sorted by
    /// name, with their size and timestamp — and nothing else. A directory is not a document, a
    /// symlink is not followed (a link inside a root must not reach outside it), and a root that
    /// does not exist yet is an empty list rather than a failure, because that is what a workspace
    /// the engine has not remembered anything for looks like.
    #[test]
    fn scan_lists_regular_files_only() {
        let root = scratch_root("scan");
        fs::write(root.join("MEMORY.md"), b"# memory").expect("MEMORY.md");
        fs::write(root.join("memory_summary.md"), b"summary").expect("summary");
        fs::write(root.join("learned.md"), b"lesson").expect("learned");
        fs::create_dir_all(root.join("rollout_summaries")).expect("subdirectory");
        fs::write(root.join("rollout_summaries").join("01.md"), b"rollout").expect("nested file");

        // A symlink inside a root is skipped rather than followed: the catalog must not be able to
        // read a file outside the root through a link someone planted in it. Creating one needs a
        // privilege on Windows, so only the platforms where it is available assert this.
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("MEMORY.md"), root.join("link.md")).expect("symlink");

        let targets = vec![MemoryRootTarget {
            workspace_id: 7,
            label: "workspace".to_owned(),
            cwd: "C:/workspace".to_owned(),
            root: root.to_string_lossy().into_owned(),
        }];
        let scanned = scan(&targets);
        let workspace = scanned.first().expect("one workspace");
        let names: Vec<&str> = workspace
            .files
            .iter()
            .map(|file| file.name.as_str())
            .collect();
        assert_eq!(names, vec!["MEMORY.md", "learned.md", "memory_summary.md"]);
        assert_eq!(workspace.files[0].bytes, 8);
        assert!(workspace.files[0].modified_at_ms.is_some());
        assert_eq!(workspace.workspace_id, 7);
        assert_eq!(workspace.label, "workspace");

        let missing = vec![MemoryRootTarget {
            workspace_id: 8,
            label: "gone".to_owned(),
            cwd: "C:/gone".to_owned(),
            root: root.join("never-created").to_string_lossy().into_owned(),
        }];
        assert!(scan(&missing)
            .first()
            .expect("one workspace")
            .files
            .is_empty());

        let _ = fs::remove_dir_all(&root);
    }
}
