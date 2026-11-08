//! The launch catalog: a table of launchable applications, one entry per product, each listing the
//! locators the platforms it ships on can prove an install with.
//!
//! Ported entry for entry, and in the same menu order, from the example project's open-in-app
//! catalog (`packages/host/open-in-app/src/catalog.ts`): the ids the frontend names, the locator
//! chain each id is proven by, and the arguments a launch hands the workspace directory through.
//! The table is data only - everything that touches this machine lives in the resolver beside it.
//!
//! The table is built once, on first use: a few of its entries take their locators from the product
//! they describe (the JetBrains family), which a compile-time `static` table cannot express.

use std::sync::LazyLock;

/// Token an adapter's arguments carry where the workspace directory goes (`--cd={path}`); an
/// argument list without it gets the directory appended instead.
pub(crate) const PATH_TOKEN: &str = "{path}";

/// How one application takes the thing it is asked to open.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Handover {
    /// The path as it is: an editor opens the file that is on screen.
    Path,
    /// A directory, always - the file's own folder when a file is on screen. Terminals open at that
    /// folder, and a Git client opens the repository that holds the file.
    Directory,
}

/// The platforms the catalog declares entries for. Any other target resolves nothing.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Platform {
    Darwin,
    Win32,
    Linux,
    Other,
}

/// The platform this build runs on.
pub(crate) const CURRENT: Platform = if cfg!(target_os = "windows") {
    Platform::Win32
} else if cfg!(target_os = "macos") {
    Platform::Darwin
} else if cfg!(target_os = "linux") {
    Platform::Linux
} else {
    Platform::Other
};

/// Shared empty argument list, so entries that take no arguments read as one word.
const NO_ARGS: &[&str] = &[];

/// How a locator that ships with its operating system launches the directory.
pub(crate) enum FixedLaunch {
    /// The OS shell's own open verb (Explorer, Finder, `xdg-open`).
    ShellOpen,
    /// A fixed argv, used by macOS `Terminal.app`.
    Argv {
        command: &'static str,
        args: &'static [&'static str],
    },
}

/// One way to prove an application is installed here, and the arguments that launch it.
pub(crate) enum Locator {
    /// Ships with the OS: the launcher is trusted rather than probed, and `icon` names the file
    /// (Windows) or bundle (macOS) its artwork comes from.
    Fixed {
        launch: FixedLaunch,
        icon: &'static str,
    },
    /// macOS: the first of `names` that exists in an application root.
    App { names: &'static [&'static str] },
    /// macOS: the command line tools' developer directory, always the running Xcode.
    Xcode,
    /// A PATH name, resolved in this process.
    Cli {
        name: &'static str,
        args: &'static [&'static str],
    },
    /// The first candidate path that exists.
    File {
        candidates: &'static [&'static str],
        args: &'static [&'static str],
    },
    /// One named file directly under one directory.
    FileIn {
        root: &'static str,
        name: &'static str,
        args: &'static [&'static str],
    },
    /// The newest version-named directory under `root` that holds `relative_launcher`.
    Scan {
        root: &'static str,
        name_prefix: &'static str,
        relative_launcher: &'static str,
        args: &'static [&'static str],
    },
    /// Windows `App Paths` registration for one executable name.
    AppPaths {
        exe: &'static str,
        args: &'static [&'static str],
    },
    /// A Windows Uninstall record whose display name starts with `display_name_prefix`, verified
    /// through the executable it points at.
    InstallRecord {
        display_name_prefix: &'static str,
        /// Launcher under the record's `InstallLocation`; absent means the record's `DisplayIcon`.
        relative_launcher: Option<&'static str>,
        args: &'static [&'static str],
    },
    /// GitHub Desktop's `app-<version>` directory under `root`.
    GitHubDesktop { root: &'static str },
    /// Linux: the executable a desktop entry proves.
    Desktop {
        desktop_id: &'static str,
        args: &'static [&'static str],
    },
}

/// One platform's launcher sources, and - on Linux - the desktop entry owning its icon.
pub(crate) struct PlatformSpec {
    /// Tried in order; the first locator that yields a verified launcher wins.
    pub(crate) locators: Vec<Locator>,
    /// XDG desktop-entry id whose `Icon=` key names this application's icon. macOS icons come from
    /// the resolved bundle and Windows icons from the resolved executable.
    pub(crate) desktop_id: Option<&'static str>,
}

/// One launchable application and the platforms that can offer it.
pub(crate) struct App {
    pub(crate) id: &'static str,
    pub(crate) handover: Handover,
    pub(crate) platforms: Platforms,
}

/// The catalog's per-platform specs.
pub(crate) struct Platforms {
    pub(crate) darwin: Option<PlatformSpec>,
    pub(crate) win32: Option<PlatformSpec>,
    pub(crate) linux: Option<PlatformSpec>,
}

/// The catalog in menu order.
pub(crate) fn catalog() -> &'static [App] {
    &CATALOG
}

/// The catalog entry behind one id.
pub(crate) fn app_by_id(id: &str) -> Option<&'static App> {
    catalog().iter().find(|app| app.id == id)
}

/// The spec for `platform`, or `None` where this application is not offered there.
pub(crate) fn spec_for(app: &App, platform: Platform) -> Option<&PlatformSpec> {
    match platform {
        Platform::Darwin => app.platforms.darwin.as_ref(),
        Platform::Win32 => app.platforms.win32.as_ref(),
        Platform::Linux => app.platforms.linux.as_ref(),
        Platform::Other => None,
    }
}

static CATALOG: LazyLock<Vec<App>> = LazyLock::new(build_catalog);

fn build_catalog() -> Vec<App> {
    vec![
        app(
            "finder",
            darwin_fixed(
                FixedLaunch::ShellOpen,
                "/System/Library/CoreServices/Finder.app",
            ),
            None,
            None,
        ),
        app(
            "explorer",
            None,
            win_fixed(FixedLaunch::ShellOpen, "${SystemRoot}/explorer.exe"),
            None,
        ),
        app(
            "filemanager",
            None,
            None,
            linux(None, vec![cli("xdg-open")]),
        ),
        app(
            "cursor",
            mac(&["Cursor.app"]),
            win(vec![
                app_paths("Cursor.exe"),
                install_record("Cursor", None),
                file(&["${LOCALAPPDATA}/Programs/cursor/Cursor.exe"]),
            ]),
            linux(None, vec![cli("cursor")]),
        ),
        app(
            "vscode",
            mac(&["Visual Studio Code.app"]),
            win(vec![
                app_paths("Code.exe"),
                install_record("Microsoft Visual Studio Code", Some("Code.exe")),
                file(&[
                    "${LOCALAPPDATA}/Programs/Microsoft VS Code/Code.exe",
                    "${ProgramFiles}/Microsoft VS Code/Code.exe",
                ]),
            ]),
            linux(Some("code"), vec![cli("code")]),
        ),
        app(
            "vscodeinsiders",
            mac(&["Visual Studio Code - Insiders.app"]),
            win(vec![
                app_paths("Code - Insiders.exe"),
                install_record(
                    "Microsoft Visual Studio Code Insiders",
                    Some("Code - Insiders.exe"),
                ),
                file(&["${LOCALAPPDATA}/Programs/Microsoft VS Code Insiders/Code - Insiders.exe"]),
            ]),
            linux(Some("code-insiders"), vec![cli("code-insiders")]),
        ),
        app(
            "windsurf",
            mac(&["Windsurf.app"]),
            win(vec![
                app_paths("Windsurf.exe"),
                install_record("Windsurf", None),
                file(&["${LOCALAPPDATA}/Programs/Windsurf/Windsurf.exe"]),
            ]),
            linux(None, vec![cli("windsurf")]),
        ),
        app(
            "zed",
            mac(&["Zed.app", "Zed Preview.app"]),
            None,
            linux(
                Some("dev.zed.Zed"),
                vec![cli("zed"), desktop("dev.zed.Zed", NO_ARGS)],
            ),
        ),
        app(
            "sublimetext",
            mac(&["Sublime Text.app"]),
            win(vec![
                app_paths("sublime_text.exe"),
                install_record("Sublime Text", None),
                file(&["${ProgramFiles}/Sublime Text/sublime_text.exe"]),
            ]),
            linux(Some("sublime_text"), vec![cli("subl")]),
        ),
        app("xcode", darwin(vec![Locator::Xcode]), None, None),
        app(
            "androidstudio",
            mac(&["Android Studio.app"]),
            win(vec![
                install_record("Android Studio", Some("bin/studio64.exe")),
                file(&["${ProgramFiles}/Android/Android Studio/bin/studio64.exe"]),
            ]),
            linux(
                None,
                vec![
                    cli("studio"),
                    file(&[
                        "~/.local/share/JetBrains/Toolbox/scripts/studio",
                        "/opt/android-studio/bin/studio.sh",
                    ]),
                ],
            ),
        ),
        jetbrains(
            "intellij",
            "IntelliJ IDEA",
            "idea",
            "bin/idea64.exe",
            &[
                "IntelliJ IDEA.app",
                "IntelliJ IDEA Ultimate.app",
                "IntelliJ IDEA CE.app",
            ],
        ),
        jetbrains(
            "pycharm",
            "PyCharm",
            "pycharm",
            "bin/pycharm64.exe",
            &[
                "PyCharm.app",
                "PyCharm Professional.app",
                "PyCharm CE.app",
                "PyCharm Community.app",
            ],
        ),
        jetbrains(
            "webstorm",
            "WebStorm",
            "webstorm",
            "bin/webstorm64.exe",
            &["WebStorm.app"],
        ),
        jetbrains(
            "phpstorm",
            "PhpStorm",
            "phpstorm",
            "bin/phpstorm64.exe",
            &["PhpStorm.app"],
        ),
        jetbrains(
            "goland",
            "GoLand",
            "goland",
            "bin/goland64.exe",
            &["GoLand.app"],
        ),
        jetbrains(
            "rider",
            "Rider",
            "rider",
            "bin/rider64.exe",
            &["Rider.app", "JetBrains Rider.app"],
        ),
        jetbrains(
            "rustrover",
            "RustRover",
            "rustrover",
            "bin/rustrover64.exe",
            &["RustRover.app"],
        ),
        app_directory(
            "fork",
            mac(&["Fork.app"]),
            win(vec![
                install_record("Fork", None),
                file(&["${LOCALAPPDATA}/Fork/Fork.exe"]),
            ]),
            None,
        ),
        app_directory("sourcetree", mac(&["Sourcetree.app"]), None, None),
        app_directory(
            "github",
            mac(&["GitHub Desktop.app"]),
            win(vec![Locator::GitHubDesktop {
                root: "${LOCALAPPDATA}/GitHubDesktop",
            }]),
            None,
        ),
        app_directory("tower", mac(&["Tower.app"]), None, None),
        app_directory("gitkraken", mac(&["GitKraken.app"]), None, None),
        app_directory("smartgit", mac(&["SmartGit.app"]), None, None),
        app(
            "sublimemerge",
            mac(&["Sublime Merge.app"]),
            win(vec![
                app_paths("sublime_merge.exe"),
                install_record("Sublime Merge", None),
                file(&["${ProgramFiles}/Sublime Merge/sublime_merge.exe"]),
            ]),
            linux(Some("sublime_merge"), vec![cli("smerge")]),
        ),
        app_directory(
            "ghostty",
            mac(&["Ghostty.app"]),
            None,
            linux(
                Some("com.mitchellh.ghostty"),
                vec![
                    cli_with("ghostty", &["--working-directory={path}"]),
                    desktop("com.mitchellh.ghostty", &["--working-directory={path}"]),
                ],
            ),
        ),
        app_directory("warp", mac(&["Warp.app"]), None, None),
        app_directory("iterm", mac(&["iTerm.app"]), None, None),
        app_directory(
            "kitty",
            mac(&["kitty.app"]),
            None,
            linux(
                Some("kitty"),
                vec![
                    cli_with("kitty", &["--directory"]),
                    desktop("kitty", &["--directory"]),
                ],
            ),
        ),
        app_directory(
            "terminal",
            Some(spec(
                vec![Locator::Fixed {
                    launch: FixedLaunch::Argv {
                        command: "open",
                        args: &["-a", "Terminal"],
                    },
                    icon: "/System/Applications/Utilities/Terminal.app",
                }],
                None,
            )),
            None,
            None,
        ),
        app_directory(
            "windowsterminal",
            None,
            win(vec![cli_with("wt", &["-d"])]),
            None,
        ),
        app_directory(
            "gitbash",
            None,
            win(vec![
                // Git for Windows registers as "Git version <x.y.z>"; the bare "Git" prefix would
                // also match "GitHub Desktop".
                install_record_with("Git version", Some("git-bash.exe"), &["--cd={path}"]),
                file_with(&["${ProgramFiles}/Git/git-bash.exe"], &["--cd={path}"]),
            ]),
            None,
        ),
        app_directory(
            "gnometerminal",
            None,
            None,
            linux(
                Some("org.gnome.Terminal"),
                vec![
                    cli_with("gnome-terminal", &["--working-directory={path}"]),
                    desktop("org.gnome.Terminal", &["--working-directory={path}"]),
                ],
            ),
        ),
        app_directory(
            "konsole",
            None,
            None,
            linux(
                Some("org.kde.konsole"),
                vec![
                    cli_with("konsole", &["--workdir"]),
                    desktop("org.kde.konsole", &["--workdir"]),
                ],
            ),
        ),
    ]
}

/// One catalog entry whose launcher takes the path itself (an editor opens the file).
fn app(
    id: &'static str,
    darwin: Option<PlatformSpec>,
    win32: Option<PlatformSpec>,
    linux: Option<PlatformSpec>,
) -> App {
    entry(id, Handover::Path, darwin, win32, linux)
}

/// One catalog entry whose launcher wants a directory even when a file is on screen: a terminal
/// opens at the file's folder, and a Git client opens the repository that holds it.
fn app_directory(
    id: &'static str,
    darwin: Option<PlatformSpec>,
    win32: Option<PlatformSpec>,
    linux: Option<PlatformSpec>,
) -> App {
    entry(id, Handover::Directory, darwin, win32, linux)
}

/// One catalog entry.
fn entry(
    id: &'static str,
    handover: Handover,
    darwin: Option<PlatformSpec>,
    win32: Option<PlatformSpec>,
    linux: Option<PlatformSpec>,
) -> App {
    App {
        id,
        handover,
        platforms: Platforms {
            darwin,
            win32,
            linux,
        },
    }
}

/// One platform's spec from its locator chain.
fn spec(locators: Vec<Locator>, desktop_id: Option<&'static str>) -> PlatformSpec {
    PlatformSpec {
        locators,
        desktop_id,
    }
}

/// macOS spec checking the known application directories for the named bundles.
fn mac(names: &'static [&'static str]) -> Option<PlatformSpec> {
    Some(spec(vec![Locator::App { names }], None))
}

/// macOS spec for a launcher that ships with the OS.
fn darwin(locators: Vec<Locator>) -> Option<PlatformSpec> {
    Some(spec(locators, None))
}

/// macOS spec for one fixed, OS-shipped launcher and the icon it is trusted to have.
fn darwin_fixed(launch: FixedLaunch, icon: &'static str) -> Option<PlatformSpec> {
    Some(spec(vec![Locator::Fixed { launch, icon }], None))
}

/// Windows spec from its locator chain.
fn win(locators: Vec<Locator>) -> Option<PlatformSpec> {
    Some(spec(locators, None))
}

/// Windows spec for the launcher that ships with the OS.
fn win_fixed(launch: FixedLaunch, icon: &'static str) -> Option<PlatformSpec> {
    Some(spec(vec![Locator::Fixed { launch, icon }], None))
}

/// Linux spec from its locator chain plus the desktop entry owning its icon.
fn linux(desktop_id: Option<&'static str>, locators: Vec<Locator>) -> Option<PlatformSpec> {
    Some(spec(locators, desktop_id))
}

/// In-process PATH-name locator.
fn cli(name: &'static str) -> Locator {
    Locator::Cli {
        name,
        args: NO_ARGS,
    }
}

/// In-process PATH-name locator with its own arguments.
fn cli_with(name: &'static str, args: &'static [&'static str]) -> Locator {
    Locator::Cli { name, args }
}

/// First-existing-file locator.
fn file(candidates: &'static [&'static str]) -> Locator {
    Locator::File {
        candidates,
        args: NO_ARGS,
    }
}

/// First-existing-file locator with its own arguments.
fn file_with(candidates: &'static [&'static str], args: &'static [&'static str]) -> Locator {
    Locator::File { candidates, args }
}

/// Windows `App Paths` locator for one registered executable name.
fn app_paths(exe: &'static str) -> Locator {
    Locator::AppPaths { exe, args: NO_ARGS }
}

/// Windows Uninstall-record locator.
fn install_record(
    display_name_prefix: &'static str,
    relative_launcher: Option<&'static str>,
) -> Locator {
    Locator::InstallRecord {
        display_name_prefix,
        relative_launcher,
        args: NO_ARGS,
    }
}

/// Windows Uninstall-record locator with its own arguments.
fn install_record_with(
    display_name_prefix: &'static str,
    relative_launcher: Option<&'static str>,
    args: &'static [&'static str],
) -> Locator {
    Locator::InstallRecord {
        display_name_prefix,
        relative_launcher,
        args,
    }
}

/// Linux desktop-entry locator with its own arguments.
fn desktop(desktop_id: &'static str, args: &'static [&'static str]) -> Locator {
    Locator::Desktop { desktop_id, args }
}

/// JetBrains product entry: known bundle names on macOS (direct download and Toolbox spellings),
/// the newest versioned `%ProgramFiles%\JetBrains` install or a verified Uninstall record on
/// Windows, and a PATH command or the Toolbox shell script on Linux.
fn jetbrains(
    id: &'static str,
    product: &'static str,
    cli_name: &'static str,
    win_launcher: &'static str,
    mac_names: &'static [&'static str],
) -> App {
    app(
        id,
        mac(mac_names),
        win(vec![
            Locator::Scan {
                root: "${ProgramFiles}/JetBrains",
                name_prefix: product,
                relative_launcher: win_launcher,
                args: NO_ARGS,
            },
            Locator::InstallRecord {
                display_name_prefix: product,
                relative_launcher: Some(win_launcher),
                args: NO_ARGS,
            },
        ]),
        linux(
            None,
            vec![
                cli(cli_name),
                Locator::FileIn {
                    root: "~/.local/share/JetBrains/Toolbox/scripts",
                    name: cli_name,
                    args: NO_ARGS,
                },
            ],
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::{catalog, Platform};

    /// The menu lists one row per id: a duplicate id would draw the same application twice and
    /// make the remembered choice ambiguous.
    #[test]
    fn every_catalog_id_is_unique() {
        let mut ids: Vec<&str> = catalog().iter().map(|app| app.id).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count, "catalog ids must be unique");
    }

    /// Every entry has to be launchable somewhere, or it can never be offered on any machine.
    #[test]
    fn every_entry_declares_a_platform() {
        for app in catalog() {
            let specs = [
                &app.platforms.darwin,
                &app.platforms.win32,
                &app.platforms.linux,
            ];
            let declared: Vec<_> = specs.into_iter().flatten().collect();
            assert!(!declared.is_empty(), "{} declares no platform", app.id);
            for spec in declared {
                assert!(
                    !spec.locators.is_empty(),
                    "{} declares an empty locator chain",
                    app.id
                );
            }
        }
    }

    /// The ids the frontend's dictionary names are the ones the catalog offers, and `Other` is the
    /// one platform value no entry claims.
    #[test]
    fn the_catalog_offers_the_documented_ids() {
        let ids: Vec<&str> = catalog().iter().map(|app| app.id).collect();
        for expected in [
            "explorer",
            "cursor",
            "vscode",
            "gitbash",
            "windowsterminal",
            "finder",
            "filemanager",
        ] {
            assert!(ids.contains(&expected), "{expected} left the catalog");
        }
        assert!(!format!("{:?}", Platform::Other).is_empty());
    }
}
