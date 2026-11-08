//! Open in app: offering the workspace directory to the applications this machine already has.
//!
//! The catalog (`catalog.rs`) is a table of products and the locators that prove them installed;
//! this module resolves that table against the machine once per application run, launches one
//! resolved entry on a directory, and extracts the resolved application's own icon. Ported from
//! the example project's open-in-app host
//! (`packages/host/open-in-app/src/{catalog,resolver,icons}.ts`): the same detection order, the
//! same launch semantics (detached, a watch window for early failure, one re-resolve and retry
//! after a launcher that turned out to be gone), and the same icon strategy per platform.
//!
//! Everything here is real detection: an application the machine does not have is not offered at
//! all, and the icon a row draws is the one extracted from the installed binary or bundle.

mod catalog;
mod icons;
mod probe;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};

use catalog::{
    app_by_id, catalog, App, FixedLaunch, Handover, Locator, Platform, CURRENT, PATH_TOKEN,
};
use probe::IconData;

/// The early-failure watch window per launch: a launcher still running when it closes counts as
/// launched and keeps running, so this bounds how long a launch holds the request - never how long
/// an application may live (the example project ships `launchWatchMs: 1000`).
const LAUNCH_WATCH: Duration = Duration::from_millis(1000);

/// How often a fresh launcher is checked for its exit while the watch window runs.
const LAUNCH_POLL: Duration = Duration::from_millis(25);

/// What one launch is asked to open: a path this desktop has already resolved and validated,
/// together with what that path is.
pub(crate) struct OpenTarget {
    pub(crate) path: PathBuf,
    pub(crate) kind: TargetKind,
}

/// What one target path is.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum TargetKind {
    Directory,
    File,
}

/// Why a launch request did not happen.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum LaunchFailure {
    /// The id names nothing this catalog offers on this platform.
    Unknown,
    /// The application was found, but the launch failed - or its executable turned out to be gone.
    Failed,
}

/// One resolved launcher: what a click runs, the fallback tried when that fails, and where the
/// application's icon lives.
struct ResolvedLaunch {
    launch: Launch,
    fallback: Option<Launch>,
    icon: Option<IconSource>,
}

/// One verified application.
struct ResolvedApp {
    id: &'static str,
    handover: Handover,
    resolved: ResolvedLaunch,
}

/// One application's launchers, cloned out of the resolved catalog.
struct LaunchPlan {
    launch: Launch,
    fallback: Option<Launch>,
    handover: Handover,
}

/// Where an application's icon pixels come from on this platform.
enum IconSource {
    /// Windows: the artwork is inside the executable itself.
    Executable(PathBuf),
    /// macOS: the artwork lives in the application bundle.
    AppBundle(PathBuf),
}

/// One launch as the resolver proved it.
enum Launch {
    /// The OS shell's open verb on the directory (Explorer, Finder, `xdg-open`).
    ShellOpen,
    /// A detached argv.
    Argv {
        command: PathBuf,
        /// Arguments as declared, before the directory is substituted or appended.
        args: Vec<String>,
        env: Vec<(&'static str, &'static str)>,
        /// Hide the launcher's own console window (a CLI adapter that opens the real GUI itself).
        hide_window: bool,
    },
}

/// The resolved catalog, the icon cache, and the scratch directory icon extraction works in.
pub(crate) struct OpenInApp {
    /// Every application this machine has, in menu order; `None` until the first read resolves it.
    ///
    /// Resolving is a detection pass (file probes, `PATH` lookups, one registry read on Windows),
    /// so it happens once per application run: a click, a menu open or a window reload never
    /// re-runs it. A launch whose launcher turned out to be gone replaces that one entry.
    resolved: Mutex<Option<Vec<ResolvedApp>>>,
    /// Data URLs by catalog id, `None` for an application this machine serves no icon for. The key
    /// set is the catalog - the only ids this is read with - so the cache is bounded by
    /// construction and lives for the process: an icon describes an installed binary, which does
    /// not change under a running application.
    icons: Mutex<HashMap<String, Option<String>>>,
    /// Private work directory for icon extraction (`<dataRoot>/scratch`).
    scratch: PathBuf,
}

impl OpenInApp {
    pub(crate) fn new(scratch: PathBuf) -> Self {
        Self {
            resolved: Mutex::new(None),
            icons: Mutex::new(HashMap::new()),
            scratch,
        }
    }

    /// The ids of the applications this machine has, in menu order.
    pub(crate) fn installed_apps(&self) -> Vec<String> {
        self.with_resolved(|apps| apps.iter().map(|app| app.id.to_owned()).collect())
    }

    /// One installed application's icon as a `data:` URL, or `None` when it has none.
    pub(crate) fn icon(&self, app_id: &str) -> Option<String> {
        if let Some(cached) = self.icons().get(app_id) {
            return cached.clone();
        }
        // An id outside the catalog is not an icon this desktop draws, and not a key it keeps.
        app_by_id(app_id)?;
        let extracted = self.extract_icon(app_id);
        self.icons().insert(app_id.to_owned(), extracted.clone());
        extracted
    }

    /// Launch one installed application on one target.
    ///
    /// `target` is a path the command layer has already resolved and validated - the workspace
    /// root, or a file inside it; the launch passes it as an argument, or opens it through the OS
    /// shell's own verb.
    pub(crate) fn launch(&self, app_id: &str, target: &OpenTarget) -> Result<(), LaunchFailure> {
        let plan = self.launch_plan(app_id)?;
        let mut outcome = launch_resolved(&plan, target);
        if outcome == Outcome::Missing {
            // The verified launcher is gone (uninstalled since resolution): re-resolve this one
            // entry and retry once with the fresh launcher.
            outcome = match self.refresh(app_id) {
                Some(plan) => launch_resolved(&plan, target),
                None => Outcome::Failed,
            };
        }
        match outcome {
            Outcome::Launched => Ok(()),
            Outcome::Missing | Outcome::Failed => Err(LaunchFailure::Failed),
        }
    }

    /// Extract one installed application's icon, outside any lock: extraction runs a host command
    /// (up to ten seconds), and the resolution cache must stay readable while it does.
    fn extract_icon(&self, app_id: &str) -> Option<String> {
        let desktop_id = app_by_id(app_id)
            .and_then(|app| catalog::spec_for(app, CURRENT))
            .and_then(|spec| spec.desktop_id);
        let icon = self.with_resolved(|apps| {
            apps.iter()
                .find(|entry| entry.id == app_id)
                .and_then(|entry| entry.resolved.icon.as_ref().map(clone_icon))
        });
        icons::extract(desktop_id, icon.as_ref(), &self.scratch).map(|data| data_url(&data))
    }

    /// One installed application's launchers and handover, cloned out of the cache.
    fn launch_plan(&self, app_id: &str) -> Result<LaunchPlan, LaunchFailure> {
        self.with_resolved(|apps| {
            let app = apps.iter().find(|app| app.id == app_id)?;
            Some(LaunchPlan {
                launch: clone_launch(&app.resolved.launch),
                fallback: app.resolved.fallback.as_ref().map(clone_launch),
                handover: app.handover,
            })
        })
        .ok_or(LaunchFailure::Unknown)
    }

    /// Re-resolve one entry after its launcher disappeared: the fresh launcher replaces the entry,
    /// and an application that no longer resolves at all leaves the catalog.
    fn refresh(&self, app_id: &str) -> Option<LaunchPlan> {
        let fresh = app_by_id(app_id).and_then(|app| {
            resolve_app(app, &mut Pass::default()).map(|resolved| (app.id, app.handover, resolved))
        });
        let mut cache = self.lock();
        let apps = cache.get_or_insert_with(Vec::new);
        let index = apps.iter().position(|app| app.id == app_id);
        match (fresh, index) {
            (Some((id, handover, resolved)), Some(index)) => {
                apps[index] = ResolvedApp {
                    id,
                    handover,
                    resolved,
                };
                let entry = &apps[index];
                Some(LaunchPlan {
                    launch: clone_launch(&entry.resolved.launch),
                    fallback: entry.resolved.fallback.as_ref().map(clone_launch),
                    handover: entry.handover,
                })
            }
            (Some(_), None) => None,
            (None, Some(index)) => {
                apps.remove(index);
                None
            }
            (None, None) => None,
        }
    }

    /// Run `read` against the resolved catalog, resolving it first when it has not been read yet.
    fn with_resolved<T>(&self, read: impl FnOnce(&[ResolvedApp]) -> T) -> T {
        let mut cache = self.lock();
        let apps = cache.get_or_insert_with(resolve_pass);
        read(apps)
    }

    fn icons(&self) -> MutexGuard<'_, HashMap<String, Option<String>>> {
        lock(&self.icons)
    }

    fn lock(&self) -> MutexGuard<'_, Option<Vec<ResolvedApp>>> {
        lock(&self.resolved)
    }
}

/// A poisoned lock is not a reason to take the application down: every holder only mutates this
/// cache, so the inner value stays usable.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// One clone of a resolved launcher.
fn clone_launch(launch: &Launch) -> Launch {
    match launch {
        Launch::ShellOpen => Launch::ShellOpen,
        Launch::Argv {
            command,
            args,
            env,
            hide_window,
        } => Launch::Argv {
            command: command.clone(),
            args: args.clone(),
            env: env.clone(),
            hide_window: *hide_window,
        },
    }
}

/// One clone of a resolved icon source.
fn clone_icon(icon: &IconSource) -> IconSource {
    match icon {
        IconSource::Executable(path) => IconSource::Executable(path.clone()),
        IconSource::AppBundle(path) => IconSource::AppBundle(path.clone()),
    }
}

/// One `data:` URL carrying an extracted icon.
fn data_url(icon: &IconData) -> String {
    format!("data:{};base64,{}", icon.mime, STANDARD.encode(&icon.bytes))
}

/// The Windows registry view for one resolution pass, read on first use and shared by every entry.
#[derive(Default)]
struct Pass {
    registry: Option<probe::RegistryView>,
}

impl Pass {
    fn registry(&mut self) -> &probe::RegistryView {
        self.registry.get_or_insert_with(probe::read_registry_view)
    }
}

/// Resolve the whole catalog once: every application this machine has, in menu order.
fn resolve_pass() -> Vec<ResolvedApp> {
    let mut pass = Pass::default();
    catalog()
        .iter()
        .filter_map(|app| {
            resolve_app(app, &mut pass).map(|resolved| ResolvedApp {
                id: app.id,
                handover: app.handover,
                resolved,
            })
        })
        .collect()
}

/// Resolve one catalog entry: this platform's locators are tried in order, and the first verified
/// launcher wins.
fn resolve_app(app: &'static App, pass: &mut Pass) -> Option<ResolvedLaunch> {
    for locator in &catalog::spec_for(app, CURRENT)?.locators {
        if let Some(resolved) = locate(locator, pass) {
            return Some(resolved);
        }
    }
    None
}

/// Resolve one locator to a verified launcher, or `None` when it proves nothing.
fn locate(locator: &Locator, pass: &mut Pass) -> Option<ResolvedLaunch> {
    match locator {
        Locator::Fixed { launch, icon } => {
            // A fixed entry ships with its OS, so its icon path is trusted rather than probed; only
            // a variable this machine does not set (`${SystemRoot}`) drops the icon claim, and the
            // entry stays usable without it.
            let icon = probe::expand(icon).map(|path| {
                if CURRENT == Platform::Win32 {
                    IconSource::Executable(path)
                } else {
                    IconSource::AppBundle(path)
                }
            });
            Some(ResolvedLaunch {
                launch: match launch {
                    FixedLaunch::ShellOpen => Launch::ShellOpen,
                    FixedLaunch::Argv { command, args } => {
                        argv(PathBuf::from(command), args, Vec::new(), false)
                    }
                },
                fallback: None,
                icon,
            })
        }
        Locator::App { names } => {
            for root in probe::application_roots() {
                for name in *names {
                    let bundle = root.join(name);
                    if probe::is_dir(&bundle) {
                        return Some(ResolvedLaunch {
                            launch: argv(
                                PathBuf::from("open"),
                                &["-a", bundle.to_string_lossy().as_ref()],
                                Vec::new(),
                                false,
                            ),
                            fallback: None,
                            icon: Some(IconSource::AppBundle(bundle)),
                        });
                    }
                }
            }
            None
        }
        Locator::Xcode => {
            let developer = probe::probe_output("xcode-select", &["-p"])?;
            let bundle = Path::new(developer.trim()).parent()?.parent()?;
            if bundle.extension().and_then(|extension| extension.to_str()) != Some("app")
                || !probe::is_dir(bundle)
            {
                return None;
            }
            let bundle_path = bundle.to_path_buf();
            Some(ResolvedLaunch {
                launch: argv(PathBuf::from("xed"), &[], Vec::new(), false),
                fallback: Some(argv(
                    PathBuf::from("open"),
                    &["-a", bundle_path.to_string_lossy().as_ref()],
                    Vec::new(),
                    false,
                )),
                icon: Some(IconSource::AppBundle(bundle_path)),
            })
        }
        Locator::Cli { name, args } => {
            let found = probe::resolve_executable(name)?;
            let icon = executable_icon(&found);
            Some(ResolvedLaunch {
                launch: argv(found, args, Vec::new(), false),
                fallback: None,
                icon,
            })
        }
        Locator::File { candidates, args } => {
            for candidate in *candidates {
                let Some(path) = probe::expand(candidate) else {
                    continue;
                };
                if probe::is_file(&path) {
                    let icon = executable_icon(&path);
                    return Some(ResolvedLaunch {
                        launch: argv(path, args, Vec::new(), false),
                        fallback: None,
                        icon,
                    });
                }
            }
            None
        }
        Locator::FileIn { root, name, args } => {
            let path = probe::expand(root)?.join(name);
            if !probe::is_file(&path) {
                return None;
            }
            let icon = executable_icon(&path);
            Some(ResolvedLaunch {
                launch: argv(path, args, Vec::new(), false),
                fallback: None,
                icon,
            })
        }
        Locator::Scan {
            root,
            name_prefix,
            relative_launcher,
            args,
        } => {
            let root = probe::expand(root)?;
            let names = directory_names(&root)?;
            for version in probe::newest_first(names, name_prefix) {
                let launcher = root.join(version).join(relative_launcher);
                if probe::is_file(&launcher) {
                    let icon = executable_icon(&launcher);
                    return Some(ResolvedLaunch {
                        launch: argv(launcher, args, Vec::new(), false),
                        fallback: None,
                        icon,
                    });
                }
            }
            None
        }
        Locator::AppPaths { exe, args } => {
            let target = pass.registry().app_paths.get(&exe.to_lowercase())?.clone();
            if !probe::is_file(&target) {
                return None;
            }
            let icon = executable_icon(&target);
            Some(ResolvedLaunch {
                launch: argv(target, args, Vec::new(), false),
                fallback: None,
                icon,
            })
        }
        Locator::InstallRecord {
            display_name_prefix,
            relative_launcher,
            args,
        } => {
            for record in &pass.registry().install_records {
                if !record.display_name.starts_with(display_name_prefix) {
                    continue;
                }
                if let Some(launcher) = probe::record_launcher(record, *relative_launcher) {
                    let icon = executable_icon(&launcher);
                    return Some(ResolvedLaunch {
                        launch: argv(launcher, args, Vec::new(), false),
                        fallback: None,
                        icon,
                    });
                }
            }
            None
        }
        Locator::GitHubDesktop { root } => {
            let root = probe::expand(root)?;
            let names = directory_names(&root)?;
            for version in probe::newest_first(names, "app-") {
                let directory = root.join(version);
                let executable = directory.join("GitHubDesktop.exe");
                let cli = directory.join("resources/app/cli.js");
                if probe::is_file(&executable) && probe::is_file(&cli) {
                    let icon = executable_icon(&executable);
                    return Some(ResolvedLaunch {
                        launch: argv(
                            executable,
                            &[cli.to_string_lossy().as_ref(), "open"],
                            vec![("ELECTRON_RUN_AS_NODE", "1")],
                            // The CLI process opens the real window itself, so its own console
                            // stays hidden.
                            true,
                        ),
                        fallback: None,
                        icon,
                    });
                }
            }
            None
        }
        Locator::Desktop { desktop_id, args } => {
            let entry = probe::find_desktop_entry(desktop_id)?;
            let launcher = probe::desktop_launcher(&entry)?;
            Some(ResolvedLaunch {
                launch: argv(launcher, args, Vec::new(), false),
                fallback: None,
                icon: None,
            })
        }
    }
}

/// The names directly under one directory, or `None` when it cannot be read.
fn directory_names(root: &Path) -> Option<Vec<String>> {
    let entries = std::fs::read_dir(root).ok()?;
    Some(
        entries
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect(),
    )
}

/// One argv launch from a resolved executable and the catalog's declared arguments.
fn argv(
    command: PathBuf,
    args: &[&str],
    env: Vec<(&'static str, &'static str)>,
    hide_window: bool,
) -> Launch {
    Launch::Argv {
        command,
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        env,
        hide_window,
    }
}

/// Icon source for a resolved executable: Windows extracts the artwork from the binary itself.
fn executable_icon(path: &Path) -> Option<IconSource> {
    (CURRENT == Platform::Win32).then(|| IconSource::Executable(path.to_path_buf()))
}

/// How one launch attempt ended; `missing` marks a stale resolution.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Launched,
    Missing,
    Failed,
}

/// Launch one resolved application on one target: the primary launcher, then the fallback when
/// the primary fails inside the watch window.
fn launch_resolved(plan: &LaunchPlan, target: &OpenTarget) -> Outcome {
    let primary = run_launch(&plan.launch, plan.handover, target);
    if primary == Outcome::Launched {
        return primary;
    }
    match plan.fallback.as_ref() {
        Some(fallback) => {
            let secondary = run_launch(fallback, plan.handover, target);
            if secondary == Outcome::Launched {
                Outcome::Launched
            } else if primary == Outcome::Missing || secondary == Outcome::Missing {
                // Either tried launcher having vanished is grounds to refresh the resolution.
                Outcome::Missing
            } else {
                Outcome::Failed
            }
        }
        None => primary,
    }
}

/// Run one launcher and classify how the attempt ended.
fn run_launch(launch: &Launch, handover: Handover, target: &OpenTarget) -> Outcome {
    match launch {
        Launch::ShellOpen => shell_open(target),
        Launch::Argv {
            command,
            args,
            env,
            hide_window,
        } => {
            let mut child = Command::new(command);
            child
                .args(launch_args(args, handover_path(target, handover)))
                .envs(env.iter().copied())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                use windows_sys::Win32::System::Threading::{
                    CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, DETACHED_PROCESS,
                };

                let flags = if *hide_window {
                    CREATE_NO_WINDOW
                } else {
                    DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
                };
                child.creation_flags(flags);
            }
            match child.spawn() {
                Ok(running) => watch(running),
                Err(error) => classify_spawn_error(&error),
            }
        }
    }
}

/// The path one launcher is handed: the target itself for an editor, and the directory that holds
/// it for a terminal or a Git client.
fn handover_path(target: &OpenTarget, handover: Handover) -> &Path {
    match (handover, target.kind) {
        (Handover::Directory, TargetKind::File) => match target.path.parent() {
            Some(parent) => parent,
            None => target.path.as_path(),
        },
        _ => target.path.as_path(),
    }
}

/// Substitute the directory token into one launch's arguments, appending the directory when no
/// argument carries one.
fn launch_args(args: &[String], workspace: &Path) -> Vec<String> {
    let path = workspace.to_string_lossy();
    if args.iter().any(|arg| arg.contains(PATH_TOKEN)) {
        return args
            .iter()
            .map(|arg| arg.replace(PATH_TOKEN, &path))
            .collect();
    }
    let mut arguments = args.to_vec();
    arguments.push(path.into_owned());
    arguments
}

/// Watch a fresh launcher for its early failure.
///
/// A launcher still running when the window closes is counted launched and left alone - the
/// JetBrains IDEs and terminals stay in the foreground for their whole window's life - so the
/// window catches the failures that are immediate: a spawn error, or a nonzero exit while it is
/// still open. The child is never killed.
fn watch(mut running: Child) -> Outcome {
    let deadline = Instant::now() + LAUNCH_WATCH;
    loop {
        match running.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Outcome::Launched
                } else {
                    Outcome::Failed
                };
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(LAUNCH_POLL),
            Ok(None) => return Outcome::Launched,
            Err(_) => return Outcome::Failed,
        }
    }
}

/// A spawn failure that names a missing executable marks the resolution stale.
fn classify_spawn_error(error: &std::io::Error) -> Outcome {
    if error.kind() == std::io::ErrorKind::NotFound {
        Outcome::Missing
    } else {
        Outcome::Failed
    }
}

/// Open one target through the OS shell's own verb.
///
/// Windows goes through `ShellExecuteW` rather than `explorer.exe`: the shell verb is what the
/// Start menu's own Open does (file associations included), it answers immediately instead of
/// leaving a helper process behind, and it does not report the failure exit code `explorer.exe`
/// returns after handing the window to a running instance. A file is not opened by its own
/// association here - the file manager reveals it, which is what "open in the file manager" means
/// for something that is already on screen.
#[cfg(target_os = "windows")]
fn shell_open(target: &OpenTarget) -> Outcome {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;

    /// One NUL-terminated UTF-16 argument.
    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    let operation = wide("open");
    let (file, parameters) = match target.kind {
        TargetKind::Directory => (wide(&target.path.to_string_lossy()), None),
        TargetKind::File => (
            wide("explorer.exe"),
            Some(wide(&format!(
                "/select,\"{}\"",
                target.path.to_string_lossy()
            ))),
        ),
    };
    // SW_SHOWNORMAL: the shell's own "open it normally" window state, passed as its literal so the
    // call does not pull in the windowing feature set this build has no other use for.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            match parameters.as_ref() {
                Some(parameters) => parameters.as_ptr(),
                None => std::ptr::null(),
            },
            std::ptr::null(),
            1,
        )
    };
    if result as isize > 32 {
        Outcome::Launched
    } else {
        Outcome::Failed
    }
}

/// Open one target through the platform's opener command, under the launch watch window.
///
/// macOS reveals a file with `open -R`; the Linux file managers have no such verb through
/// `xdg-open`, so a file opens the folder that holds it.
#[cfg(not(target_os = "windows"))]
fn shell_open(target: &OpenTarget) -> Outcome {
    let revealing = cfg!(target_os = "macos") && target.kind == TargetKind::File;
    let opened = match (target.kind, revealing) {
        (TargetKind::File, false) => handover_path(target, Handover::Directory).to_path_buf(),
        _ => target.path.clone(),
    };
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let mut child = Command::new(opener);
    if revealing {
        child.arg("-R");
    }
    child
        .arg(opened)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    match child.spawn() {
        Ok(running) => watch(running),
        Err(error) => classify_spawn_error(&error),
    }
}

/// Open one directory in this machine's own file manager.
///
/// The same shell verb the catalog's `ShellOpen` launcher uses (`Explorer`, `Finder`, `xdg-open`),
/// published for the one caller that has no application to name: a path that may itself be the
/// thing to open. Answers whether the shell took it.
pub(crate) fn open_directory(path: &Path) -> bool {
    let target = OpenTarget {
        path: path.to_path_buf(),
        kind: TargetKind::Directory,
    };
    shell_open(&target) == Outcome::Launched
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::catalog::{catalog, Handover};
    use super::{
        handover_path, launch_args, OpenInApp, OpenTarget, TargetKind, CURRENT, PATH_TOKEN,
    };

    /// An argument list carrying the token has it substituted in place; one that does not gets the
    /// directory appended, which is how `code` (no flag) and `git-bash --cd=...` both work.
    #[test]
    fn the_directory_reaches_both_kinds_of_launch_arguments() {
        assert_eq!(
            launch_args(&[format!("--cd={PATH_TOKEN}")], Path::new("C:/work")),
            vec!["--cd=C:/work".to_owned()]
        );
        assert_eq!(
            launch_args(
                &["-a".to_owned(), "Terminal".to_owned()],
                Path::new("C:/work")
            ),
            vec!["-a".to_owned(), "Terminal".to_owned(), "C:/work".to_owned()]
        );
    }

    /// A terminal and a Git client are handed the folder that holds the file; an editor is handed
    /// the file itself. That difference is the whole reason a target carries its kind.
    #[test]
    fn a_file_reaches_a_terminal_as_its_folder_and_an_editor_as_itself() {
        let target = OpenTarget {
            path: Path::new("C:/work/src/main.ts").to_path_buf(),
            kind: TargetKind::File,
        };
        assert_eq!(
            handover_path(&target, Handover::Directory),
            Path::new("C:/work/src")
        );
        assert_eq!(
            handover_path(&target, Handover::Path),
            Path::new("C:/work/src/main.ts")
        );
        let directory = OpenTarget {
            path: Path::new("C:/work/src").to_path_buf(),
            kind: TargetKind::Directory,
        };
        assert_eq!(
            handover_path(&directory, Handover::Directory),
            Path::new("C:/work/src")
        );
    }

    /// An id the catalog does not offer is refused as unknown, and draws no icon.
    #[test]
    fn an_unoffered_id_is_neither_launchable_nor_drawable() {
        let scratch = std::env::temp_dir().join("omp-open-in-app-test");
        let service = OpenInApp::new(scratch);
        let target = OpenTarget {
            path: Path::new(".").to_path_buf(),
            kind: TargetKind::Directory,
        };
        assert_eq!(
            service.launch("not-an-application", &target),
            Err(super::LaunchFailure::Unknown)
        );
        assert_eq!(service.icon("not-an-application"), None);
        // The platform enum decides which specs are walked; this build walks one of the three the
        // catalog declares, and the catalog always offers at least one entry for it here.
        assert!(matches!(
            CURRENT,
            super::Platform::Darwin | super::Platform::Win32 | super::Platform::Linux
        ));
        assert!(!catalog().is_empty());
    }

    /// Detection is real: on Windows the file manager ships with the operating system, so it is
    /// always offered - and the same read twice answers from the resolution cache.
    #[cfg(target_os = "windows")]
    #[test]
    fn windows_always_offers_the_shipped_file_manager() {
        let scratch = std::env::temp_dir().join("omp-open-in-app-test");
        let service = OpenInApp::new(scratch);
        let apps = service.installed_apps();
        assert!(
            apps.iter().any(|id| id == "explorer"),
            "Explorer ships with Windows: {apps:?}"
        );
        for id in &apps {
            assert!(
                catalog().iter().any(|app| app.id == id),
                "{id} is not in the catalog"
            );
        }
        assert_eq!(service.installed_apps(), apps);
    }

    /// The icon a menu row draws is extracted from the installed application: on Windows that is a
    /// real PNG pulled out of `explorer.exe` by the associated-icon extraction.
    #[cfg(target_os = "windows")]
    #[test]
    fn explorer_artwork_is_extracted_from_the_installed_binary() {
        let scratch = std::env::temp_dir().join("omp-open-in-app-test");
        let service = OpenInApp::new(scratch);
        let icon = service.icon("explorer").expect("Explorer ships an icon");
        let encoded = icon
            .strip_prefix("data:image/png;base64,")
            .expect("a PNG data URL");
        let bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            encoded.as_bytes(),
        )
        .expect("base64");
        assert!(
            bytes.starts_with(&[0x89, b'P', b'N', b'G']),
            "the extracted bytes are a PNG"
        );
        // The second read is the cache, not another extraction of a different icon.
        assert_eq!(service.icon("explorer").as_deref(), Some(icon.as_str()));
        // Extraction cleans up after itself.
        let leftovers: Vec<_> = std::fs::read_dir(&service.scratch)
            .map(|entries| entries.flatten().collect())
            .unwrap_or_default();
        assert!(leftovers.is_empty(), "scratch holds {leftovers:?}");
    }
}
