//! Files an earlier installation left beside the application executable.
//!
//! Switching the host from a compiled `omp-host.exe` to the `bundle/` directory leaves the old
//! artifact in place: an installer writes the files it ships and removes none it does not, so a
//! 178 MB unsigned executable that this build will never start survives every upgrade. That file is
//! what antivirus engines flag, and it is dead weight on disk besides.
//!
//! The rule is an allowlist of exact names, in one directory, never recursive:
//!
//! - `omp_desktop.exe.old*` - the backup the update path makes of the previous application binary.
//! - `omp-host.exe` and `omp-host.json` - *only* when a `bundle/` directory ships beside them,
//!   because then the compiled layout is the retired one. Without a bundle these two are the host.
//!
//! Nothing under the data root is touched, and nothing in the installation directory is matched by
//! pattern beyond the `.old` prefix: `plugin-templates`, `builtin-browser-marketplace`, `bundle`,
//! an installed plugin directory or a user's own file are all left alone.

use std::fs;
use std::path::{Path, PathBuf};

use crate::services::log;

/// Names the compiled layout owned, removed only when the bundle layout replaced it.
const COMPILED_LAYOUT: &[&str] = &["omp-host.exe", "omp-host.json"];

/// Prefix of the backups the update path leaves behind.
const APPLICATION_BACKUP_PREFIX: &str = "omp_desktop.exe.old";

/// One removed file, for the log line and for the caller's own report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Removed {
    pub(crate) file: PathBuf,
    pub(crate) bytes: u64,
}

/// Removes the files an earlier installation left behind, and nothing else.
///
/// `directory` is the application's own directory. `bundle_present` says whether this build ships
/// the non-compiled layout there; only then is a compiled host considered retired. A directory that
/// cannot be read is not an error: residue is a cleanup, and a start must never fail over it.
pub(crate) fn sweep(directory: &Path, bundle_present: bool) -> Vec<Removed> {
    let mut removed = Vec::new();
    let Ok(entries) = fs::read_dir(directory) else {
        return removed;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let retired = name.starts_with(APPLICATION_BACKUP_PREFIX)
            || (bundle_present && COMPILED_LAYOUT.contains(&name));
        if !retired {
            continue;
        }
        let path = entry.path();
        // A directory that happens to carry one of these names is not the file this removes; the
        // allowlist is about files, and deleting a tree is not a cleanup an upgrade may decide.
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        if fs::remove_file(&path).is_ok() {
            removed.push(Removed {
                file: path,
                bytes: metadata.len(),
            });
        }
    }
    removed
}

/// Runs the sweep for this installation and writes one line when it removed anything.
pub(crate) fn sweep_installation(install_directory: &Path, bundle_present: bool) {
    let removed = sweep(install_directory, bundle_present);
    if removed.is_empty() {
        return;
    }
    let bytes: u64 = removed.iter().map(|entry| entry.bytes).sum();
    log::info(&format!(
        "residue: removed {} file(s), {bytes} bytes, left by an earlier installation",
        removed.len()
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(case: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("omp-residue-{case}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create workspace");
        root
    }

    fn touch(directory: &Path, name: &str) -> PathBuf {
        let path = directory.join(name);
        fs::write(&path, b"bytes").expect("write file");
        path
    }

    /// The regression this covers: the retired compiled host survives an upgrade and stays on disk
    /// as an unrecognized executable that this build never starts.
    #[test]
    fn the_retired_compiled_host_is_removed_when_a_bundle_ships() {
        let root = workspace("retired");
        fs::create_dir_all(root.join("bundle")).expect("bundle");
        let host = touch(&root, "omp-host.exe");
        let manifest = touch(&root, "omp-host.json");

        let removed = sweep(&root, true);

        assert_eq!(removed.len(), 2);
        assert!(!host.exists() && !manifest.exists());
        let _ = fs::remove_dir_all(&root);
    }

    /// Without a bundle the compiled host *is* the host: removing it would break the installation
    /// that just started.
    #[test]
    fn the_compiled_host_is_kept_when_no_bundle_ships() {
        let root = workspace("kept");
        let host = touch(&root, "omp-host.exe");

        let removed = sweep(&root, false);

        assert!(removed.is_empty());
        assert!(host.exists());
        let _ = fs::remove_dir_all(&root);
    }

    /// The update path's own backups go regardless of layout; they are never started.
    #[test]
    fn application_backups_are_removed() {
        let root = workspace("backups");
        let old = touch(&root, "omp_desktop.exe.old");
        let dated = touch(&root, "omp_desktop.exe.old-20261025002801");

        let removed = sweep(&root, false);

        assert_eq!(removed.len(), 2);
        assert!(!old.exists() && !dated.exists());
        let _ = fs::remove_dir_all(&root);
    }

    /// The rule is an allowlist: a user's plugin directory, the shipped resources and an unrelated
    /// executable stay where they are however much they look like residue.
    #[test]
    fn nothing_outside_the_allowlist_is_touched() {
        let root = workspace("allowlist");
        fs::create_dir_all(root.join("plugin-templates")).expect("templates");
        fs::create_dir_all(root.join("bundle")).expect("bundle");
        let keeps = [
            "plugin-templates",
            "builtin-browser-marketplace",
            "bundle",
            "omp_desktop.exe",
            "uninstall.exe",
            "my-plugin",
            "omp-host.exe.bak",
        ];
        for name in keeps {
            if name.ends_with("templates") || name == "bundle" {
                continue;
            }
            touch(&root, name);
        }

        let removed = sweep(&root, true);

        assert!(removed.is_empty(), "removed {removed:?}");
        for name in keeps {
            if name == "plugin-templates" || name == "bundle" {
                assert!(root.join(name).is_dir());
            } else {
                assert!(root.join(name).exists(), "{name} must survive");
            }
        }
        let _ = fs::remove_dir_all(&root);
    }
}
