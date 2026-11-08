use std::path::{Path, PathBuf};

use tauri::Manager;

use crate::errors::{IpcError, IpcResult, STORE_UNAVAILABLE};

/// Every path the application owns. `data_root` is the local application data directory
/// (`%LOCALAPPDATA%\com.omp.desktop` on Windows).
///
/// The name comes from the build's own `identifier`, which is why a development run owns a
/// different root: `pnpm tauri:dev` merges `src-tauri/tauri.dev.conf.json`
/// (`com.omp.desktop.dev`), so a dev instance shares no store, host data, engine home or webview
/// profile with an installed build (`rules.md#artifact-rebuild` step 1).
///
/// The engine runs as a single host process whose data lives under `<data_root>/host`; every
/// location it reads or writes is derived from the `--data-root` argument this application passes
/// it, and the variables pinned at spawn name the same directories. One exception, by contract
/// §1.3: the host's home directory is `<data_root>/home`, a sibling of `host` rather than a
/// directory inside it, and the SDK's config root follows from it. Nothing outside `data_root`
/// belongs to the application.
#[derive(Debug, Clone)]
pub(crate) struct DataPaths {
    pub(crate) data_root: PathBuf,
    /// Subtree the host process owns: its agent directory, sessions, worktrees and XDG root all
    /// live below this path.
    pub(crate) host_root: PathBuf,
    /// `OMP_DESKTOP_CODING_AGENT_DIR`: the host's agent directory (`models.yml`, provider state).
    /// The engine reads the same directory under its own key, `PI_CODING_AGENT_DIR`.
    pub(crate) agent_dir: PathBuf,
    /// The host's own session store, `<host_root>/sessions`. The host is its only writer.
    pub(crate) host_sessions: PathBuf,
    /// `HOME` and `USERPROFILE` for the host: `<data_root>/home`.
    ///
    /// Pinned to the value the host derives and asserts (contract §1.3, `host/src/env.ts`). It is
    /// deliberately not `<host_root>/home`: the host refuses to start when the two disagree
    /// (`host_fatal` with `env_pin_failed`), and `PI_CONFIG_DIR` resolves against it, so this is
    /// where the SDK actually writes its config root.
    pub(crate) host_home: PathBuf,
    /// `XDG_DATA_HOME` for the host: `<host_root>/xdg`. `<xdg>/omp` is pre-created, because the
    /// native addon falls back to the real user directory when it cannot extract there.
    pub(crate) host_xdg: PathBuf,
    pub(crate) scratch: PathBuf,
    /// `<data_root>/plugin-imports`: the plugin packages this application unpacked itself.
    ///
    /// Each one is kept as a real marketplace source the engine can read again — that is what makes
    /// an imported plugin upgradeable rather than a one-shot install (spec §2.3): the catalogue
    /// beside it is what `plugins_check_updates` reads and what an upgrade installs from. It is
    /// application data, not scratch: nothing here is deleted because it is old, only when its
    /// marketplace is removed.
    pub(crate) plugin_imports: PathBuf,
    /// `<data_root>/plugin-data`: the one writable directory a plugin owns, one subdirectory per
    /// installation ([`Self::plugin_data_dir`]).
    ///
    /// This application's own, never the engine's: the engine's plugin directory is read by the
    /// engine and written only through its own commands, and a plugin that could write there would
    /// be editing the installation registry it is installed by.
    pub(crate) plugin_data: PathBuf,
    pub(crate) logs: PathBuf,
    pub(crate) worktrees: PathBuf,
    /// `<data_root>/browser`: the built-in browser's own WebView2 profile.
    ///
    /// Deliberately not the application's own webview profile: the browser shows pages this
    /// application does not own, and their cookies, storage and cache stay in this directory.
    pub(crate) browser: PathBuf,
    pub(crate) app_sqlite: PathBuf,
}

impl DataPaths {
    pub(crate) fn resolve(app: &tauri::AppHandle) -> IpcResult<Self> {
        let data_root = app.path().app_local_data_dir().map_err(|_| {
            IpcError::new(
                STORE_UNAVAILABLE,
                "Cannot resolve the application data directory.",
            )
        })?;
        Ok(Self::from_root(data_root))
    }

    pub(crate) fn from_root(data_root: PathBuf) -> Self {
        let host_root = data_root.join("host");
        Self {
            agent_dir: host_root.join("agent"),
            host_sessions: host_root.join("sessions"),
            // Contract §1.3 / `host/src/env.ts`: the host derives and asserts this exact path, so
            // it is the data root's own `home`, not one nested inside the host subtree.
            host_home: data_root.join("home"),
            host_xdg: host_root.join("xdg"),
            worktrees: host_root.join("worktrees"),
            scratch: data_root.join("scratch"),
            plugin_imports: data_root.join("plugin-imports"),
            plugin_data: data_root.join("plugin-data"),
            logs: data_root.join("logs"),
            browser: data_root.join("browser"),
            app_sqlite: data_root.join("app.sqlite"),
            host_root,
            data_root,
        }
    }

    /// Creates every directory the host is started with, before the first spawn.
    ///
    /// The layout is the one the host itself derives and asserts: `agent`, `sessions`, `xdg` and
    /// `worktrees` live under `<data_root>/host`, while the pinned home - and therefore the SDK's
    /// config root below it - is `<data_root>/home`.
    ///
    /// `<XDG_DATA_HOME>/omp` has to exist up front: the host's native addon extracts into it and
    /// silently falls back to the real user directory when it cannot - which would put engine
    /// data outside this application's data root.
    pub(crate) fn ensure_host_dirs(&self) -> IpcResult<()> {
        let directories = [
            &self.data_root,
            &self.host_root,
            &self.agent_dir,
            &self.host_sessions,
            &self.host_home,
            &self.host_xdg,
            &self.worktrees,
            &self.scratch,
            &self.plugin_imports,
            &self.plugin_data,
            &self.logs,
            &self.browser,
        ];
        for dir in directories {
            std::fs::create_dir_all(dir).map_err(|_| {
                IpcError::new(
                    STORE_UNAVAILABLE,
                    "Cannot create the application data directory.",
                )
            })?;
        }
        std::fs::create_dir_all(self.host_xdg.join("omp")).map_err(|_| {
            IpcError::new(
                STORE_UNAVAILABLE,
                "Cannot create the application data directory.",
            )
        })
    }

    /// `<data_root>/sessions-index.sqlite`: the persisted projection of the engine's session store
    /// (see `services::session_index::projection`).
    ///
    /// Beside `app.sqlite` rather than inside it, and deliberately its own file: every row is
    /// derived from a transcript and rebuildable by one scan, so the file can be deleted at any
    /// time - which is not true of anything the application's own store holds, and is why the two
    /// do not share a schema version or a backup policy.
    pub(crate) fn session_index_sqlite(&self) -> PathBuf {
        self.data_root.join("sessions-index.sqlite")
    }

    /// `<data_root>/plugin-data/<key>`: the one directory an installation may write freely.
    ///
    /// The name is [`pages::origin_key`] - the same opaque, collision-free key the installation's
    /// origin, its grants and its panels are keyed by - rather than its own id. Deliberate: a plugin
    /// id is a package name, so it may be `@scope/name`, hold characters no filesystem accepts, or
    /// spell a Windows device name, and a sanitiser would have to be right on every platform. A
    /// plugin learns its own path from `plugin.dataDir`; nothing else needs to spell it.
    ///
    /// One directory per `(id, scope)`, so the user-scope and project-scope copies of one plugin do
    /// not share state - the same reason their grants are separate.
    pub(crate) fn plugin_data_dir(&self, plugin_id: &str, scope: &str) -> PathBuf {
        self.plugin_data
            .join(crate::services::plugins::pages::origin_key(
                plugin_id, scope,
            ))
    }

    /// `<data_root>/browser/profile`: the WebView2 profile every browser page shares.
    ///
    /// One profile, like a `persist:work-browser` partition: every tab is one
    /// browser with one cookie jar and one login, and deleting this directory is what "clear the
    /// browser's data" means.
    pub(crate) fn browser_profile(&self) -> PathBuf {
        self.browser.join("profile")
    }

    /// `<data_root>/home/omp-desktop`: the host's config root, pinned through `PI_CONFIG_DIR`.
    pub(crate) fn config_root(&self) -> PathBuf {
        self.host_home.join("omp-desktop")
    }

    /// `<data_root>/home/omp-desktop/logs`: the engine's own logs, one file per host process.
    ///
    /// The SDK resolves this from the pinned home and `PI_CONFIG_DIR`, not from anything this
    /// process hands the host, so it cannot be moved here (`pi-utils`' `getLogsDir`, and its XDG
    /// override is Linux/macOS only). It is therefore read, listed and pruned like `logs/` rather
    /// than merged into it.
    pub(crate) fn engine_logs(&self) -> PathBuf {
        self.config_root().join("logs")
    }

    /// Canonical form of a directory this application owns, for containment checks against
    /// `std::fs::canonicalize` results. Both forms compare equally through
    /// [`normalize_for_compare`]; canonicalizing the root also resolves a symlinked data root.
    pub(crate) fn canonical_dir(&self, dir: &Path) -> PathBuf {
        std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf())
    }
}

/// True when `path` is inside `root` after both are normalized for comparison.
pub(crate) fn is_within(root: &Path, path: &Path) -> bool {
    let root = normalize_for_compare(root);
    let path = normalize_for_compare(path);
    match path.strip_prefix(&root) {
        Some(rest) => rest.is_empty() || rest.starts_with('/'),
        None => false,
    }
}

/// Whether one plugin import directory may be deleted recursively: only a strict subdirectory of
/// `import_root` qualifies.
///
/// The comparison is [`normalize_for_compare`]'s on both sides, so a source that names the root
/// under another spelling - folded case, a trailing separator, the verbatim prefix
/// `std::fs::canonicalize` hands back on Windows - is the root rather than something inside it. The
/// root is application data whose removal would take every import with it, so nothing is deleted
/// then. A path carrying `..` is refused outright rather than resolved: normalization folds
/// separators and case but does not walk a traversal, so `root/x/..` reads as a directory inside
/// the root while naming the root itself, and `root/../y` reads as a sibling of `x` while naming
/// something else entirely.
pub(crate) fn import_dir_removable(import_root: &Path, source: &Path) -> bool {
    let root = normalize_for_compare(import_root);
    let target = normalize_for_compare(source);
    let climbs = source
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir));
    target != root && target.starts_with(&format!("{root}/")) && !climbs
}

/// Separator-normalized, case-folded, prefix-free form used for path comparison.
///
/// `std::fs::canonicalize` returns a verbatim path on Windows (`\\?\C:\dir`), while the paths
/// this application owns come from `app_local_data_dir()` without that prefix. Comparing the two
/// forms directly fails for every path, so the prefix is stripped first: `\\?\C:\x` becomes
/// `C:\x` and `\\?\UNC\server\share` becomes `\\server\share`.
pub(crate) fn normalize_for_compare(path: &Path) -> String {
    let text = strip_verbatim_prefix(&path.to_string_lossy());
    let text = text.replace('\\', "/");
    let text = text.trim_end_matches('/');
    if cfg!(windows) {
        text.to_ascii_lowercase()
    } else {
        text.to_owned()
    }
}

/// The verbatim prefix removed, but separators and case kept exactly as the filesystem wrote
/// them.
///
/// Anything this application hands to the frontend is spelled this way: the frontend's session
/// index holds plain paths, and a verbatim path sent to it would never match the row the user
/// clicked. Only the prefix is removed, so a path that is already plain comes back unchanged.
pub(crate) fn plain_path(path: &str) -> String {
    const VERBATIM: [(&str, Option<&str>); 4] = [
        (r"\\?\UNC\", Some(r"\\")),
        (r"\\?\unc\", Some(r"\\")),
        ("//?/UNC/", Some(r"\\")),
        ("//?/unc/", Some(r"\\")),
    ];
    for (prefix, replacement) in VERBATIM {
        if let Some(rest) = path.strip_prefix(prefix) {
            return format!("{}{rest}", replacement.unwrap_or_default());
        }
    }
    for prefix in [r"\\?\", "//?/"] {
        if let Some(rest) = path.strip_prefix(prefix) {
            return rest.to_owned();
        }
    }
    path.to_owned()
}

/// The ceiling a plain Win32 path has. A longer location can only be named in the verbatim form,
/// which is why [`plain_process_path`] keeps the prefix there.
const MAX_PATH: usize = 260;

/// The spelling one path is handed to another process in - a working directory or an argument.
///
/// Windows `canonicalize` answers with the verbatim form (`\\?\C:\...`,
/// `\\?\UNC\server\share\...`), and a program started in that does not see a drive or a share:
/// the location turns into a provider path, so PowerShell's prompt reads
/// `PS Microsoft.PowerShell.Core\FileSystem::\\?\C:\...>` instead of the drive the user asked for.
/// The prefix is dropped only while the plain text still fits `MAX_PATH`, though: past that
/// ceiling the verbatim form is the one a process can be created in at all, so it is handed on.
pub(crate) fn plain_process_path(path: &Path) -> PathBuf {
    use std::path::{Component, Prefix};

    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return path.to_path_buf();
    };
    // Only the two forms that name a location Win32 takes plainly lose the prefix. A device path
    // (`\\?\Volume{...}`) has no plain spelling, and anything else is already plain.
    let plain_prefix = match prefix.kind() {
        Prefix::VerbatimDisk(drive) => format!("{}:", drive as char),
        Prefix::VerbatimUNC(server, share) => format!(
            "\\\\{}\\{}",
            server.to_string_lossy(),
            share.to_string_lossy()
        ),
        _ => return path.to_path_buf(),
    };
    // What is left after the prefix component is exactly the tail the path came in with, so the
    // spelling of the rest survives; joining it back onto the plain prefix roots the result.
    let plain = Path::new(&plain_prefix).join(components.as_path());
    // The bytes of a WTF-8 path are never fewer than the UTF-16 units the Win32 ceiling counts, so
    // a path that fits here is one the plain form can be created with.
    if plain.as_os_str().len() <= MAX_PATH {
        plain
    } else {
        path.to_path_buf()
    }
}

/// Removes the Windows verbatim prefix, keeping UNC paths in their plain `\\server\share` form.
///
/// Both spellings (`\\?\C:\x` and `//?/C:/x`) collapse into the same slashed form first, so one
/// check covers them.
fn strip_verbatim_prefix(text: &str) -> String {
    let slashed = text.replace('\\', "/");
    let Some(rest) = slashed.strip_prefix("//?/") else {
        return text.to_owned();
    };
    match rest
        .strip_prefix("UNC/")
        .or_else(|| rest.strip_prefix("unc/"))
    {
        Some(unc) => format!("//{unc}"),
        None => rest.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The regression this covers: `fs::canonicalize` hands back a verbatim path on Windows while
    /// the data root is plain, so every session file looked like it lived outside the root.
    #[test]
    fn verbatim_and_plain_paths_compare_equal() {
        let plain = Path::new("C:/Users/user/AppData/Local/com.omp.desktop");
        let verbatim = Path::new(r"\\?\C:\Users\user\AppData\Local\com.omp.desktop");
        assert_eq!(
            normalize_for_compare(plain),
            normalize_for_compare(verbatim)
        );

        let sessions = plain.join("host/sessions");
        let canonical_session = Path::new(
            r"\\?\C:\Users\user\AppData\Local\com.omp.desktop\host\sessions\2026-09-20T01-00-00-000Z_abc.jsonl",
        );
        assert!(is_within(&sessions, canonical_session));
    }

    #[test]
    fn unc_verbatim_paths_fall_back_to_their_plain_form() {
        let verbatim = Path::new(r"\\?\UNC\server\share\dir\file.jsonl");
        let plain = Path::new(r"\\server\share\dir\file.jsonl");
        assert_eq!(
            normalize_for_compare(verbatim),
            normalize_for_compare(plain)
        );

        assert!(is_within(Path::new(r"\\server\share\dir"), verbatim));
    }

    #[cfg(windows)]
    #[test]
    fn case_and_trailing_separators_are_folded() {
        assert_eq!(
            normalize_for_compare(Path::new(r"C:\Users\")),
            normalize_for_compare(Path::new(r"c:\users"))
        );
        assert!(is_within(
            Path::new(r"C:\Data\sessions"),
            Path::new(r"c:\data\SESSIONS\x.jsonl")
        ));
    }

    /// A path that merely shares a name prefix is not inside the root, and a real escape is
    /// rejected in either form.
    #[test]
    fn containment_still_rejects_escapes() {
        let root = Path::new("C:/Data/com.omp.desktop");
        assert!(!is_within(
            root,
            Path::new("C:/Data/com.omp.desktop-evil/x.jsonl")
        ));
        assert!(!is_within(
            &root.join("host/sessions"),
            Path::new(r"\\?\C:\Windows\System32\drivers\etc\hosts")
        ));
        assert!(!is_within(root, Path::new("D:/other/x.jsonl")));
    }

    /// What the frontend receives has to be comparable with the paths the session index read off
    /// disk: same spelling, same case, no `\\?\` prefix.
    #[test]
    fn plain_paths_lose_only_the_verbatim_prefix() {
        assert_eq!(
            plain_path(r"\\?\C:\Data\sessions\a.jsonl"),
            r"C:\Data\sessions\a.jsonl"
        );
        assert_eq!(
            plain_path(r"C:\Data\sessions\a.jsonl"),
            r"C:\Data\sessions\a.jsonl"
        );
        assert_eq!(
            plain_path(r"\\?\UNC\server\share\a.jsonl"),
            r"\\server\share\a.jsonl"
        );
    }

    /// The regression this covers: the deletion guard compared the import root with a byte-wise
    /// `PathBuf` inequality while containment folded case and separators, so a source that spelled
    /// the root as `ROOT/` or in another case passed both checks and `remove_dir_all` was handed
    /// the whole import root. Only a strict subdirectory may be removed, and a `..` is never read
    /// as a directory inside the root.
    ///
    /// The paths are written with forward slashes so the components (including `..`) are the same
    /// on every platform: what is under test is the decision, not a separator.
    #[test]
    fn only_a_strict_subdirectory_of_the_import_root_is_removable() {
        let root = Path::new("C:/Data/com.omp.desktop/plugin-imports");
        let child = Path::new("C:/Data/com.omp.desktop/plugin-imports/hello");
        // The root under the spellings a byte-wise comparison used to miss: a trailing separator,
        // and the same path in another case.
        let root_slashed = Path::new("C:/Data/com.omp.desktop/plugin-imports/");
        let root_upper = Path::new("c:/data/COM.OMP.DESKTOP/PLUGIN-IMPORTS");
        // A traversal that lands back on the root, and one that names a sibling of the root's
        // parent - both read as being inside the root if the text is taken at face value.
        let climbs_to_root = Path::new("C:/Data/com.omp.desktop/plugin-imports/hello/..");
        let climbs_out = Path::new("C:/Data/com.omp.desktop/plugin-imports/../other");

        // The root itself, spelled three ways: each names the same directory, and deleting it
        // would take every import with it.
        assert!(!import_dir_removable(root, root));
        assert!(!import_dir_removable(root, root_slashed));
        assert!(!import_dir_removable(root, root_upper));

        // One directory inside it is the only removable shape.
        assert!(import_dir_removable(root, child));

        // A traversal is refused even where it lands back on the root.
        assert!(!import_dir_removable(root, climbs_to_root));
        assert!(!import_dir_removable(root, climbs_out));
    }

    /// The regression: Windows Terminal started in the verbatim form answers with a provider path
    /// prompt, so a path handed to another process is spelled plainly whenever it can be.
    #[cfg(windows)]
    #[test]
    fn a_verbatim_path_is_handed_over_plain() {
        assert_eq!(
            plain_process_path(Path::new(r"\\?\C:\project\demo")),
            PathBuf::from(r"C:\project\demo")
        );
        assert_eq!(
            plain_process_path(Path::new(r"\\?\UNC\server\share\demo")),
            PathBuf::from(r"\\server\share\demo")
        );
        let plain = Path::new(r"C:\project\demo");
        assert_eq!(plain_process_path(plain), plain.to_path_buf());

        // A drive path grown past `MAX_PATH` by repeating one segment: the plain spelling of it is
        // longer than a process can be created in, so the verbatim form is what comes back.
        let long = format!(r"\\?\C:\{}", r"very-long-directory-name\".repeat(20));
        assert_eq!(
            plain_process_path(Path::new(&long)),
            PathBuf::from(long.as_str())
        );
    }

    /// The regression this covers: the host derives and asserts its own locations from
    /// `--data-root` (contract §1.3) and refuses to start when a pinned variable disagrees. The
    /// home directory is the one that got this wrong - `<data_root>/host/home` instead of
    /// `<data_root>/home` - which turned every start into `env_pin_failed`, so the layout is
    /// pinned here rather than left to wherever the variables happen to be set.
    #[test]
    fn the_pinned_layout_matches_what_the_host_derives() {
        let data_root = PathBuf::from(r"D:\Data\com.omp.desktop");
        let paths = DataPaths::from_root(data_root.clone());
        assert_eq!(paths.host_root, data_root.join("host"));
        assert_eq!(paths.agent_dir, data_root.join("host").join("agent"));
        assert_eq!(paths.host_sessions, data_root.join("host").join("sessions"));
        assert_eq!(paths.host_xdg, data_root.join("host").join("xdg"));
        assert_eq!(paths.worktrees, data_root.join("host").join("worktrees"));
        // The one location that is a sibling of `host`, not a directory inside it.
        assert_eq!(paths.host_home, data_root.join("home"));
        assert_eq!(
            paths.config_root(),
            data_root.join("home").join("omp-desktop")
        );
        assert_eq!(
            paths.host_home.parent().map(Path::to_path_buf),
            Some(data_root)
        );
    }
}
