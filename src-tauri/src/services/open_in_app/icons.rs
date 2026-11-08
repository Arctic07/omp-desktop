//! Icon extraction for resolved applications: one strategy per platform, ported from the example
//! project's open-in-app host (`packages/host/open-in-app/src/icons.ts`).
//!
//! macOS converts the resolved bundle's `.icns` to a 128px PNG (`plutil` + `sips`); Windows
//! extracts the resolved executable's associated icon as a 32px PNG through a generated PowerShell
//! script (the largest size `ExtractAssociatedIcon` yields without a native addon); Linux follows
//! the spec's desktop entry `Icon=` key into the hicolor theme and pixmaps directories. Every
//! failure resolves `None`, and the frontend draws its generic glyph instead.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use super::probe::{self, IconData};
use super::IconSource;

/// Deadline for one icon-extraction command: the same conservative bound the resolution commands
/// get, because both are failure bounds rather than latency budgets.
const ICON_TIMEOUT: Duration = Duration::from_secs(10);

/// Ceiling on one extracted icon file. The sizes below are 32px (Windows) and 128px (macOS), so
/// anything past this is not artwork this resolver produced.
const ICON_FILE_LIMIT: usize = 2 * 1024 * 1024;

/// Distinguishes the scratch directories of concurrent extractions.
static ICON_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// The associated-icon extraction script. `-File` with named arguments keeps source and target
/// paths out of the command line's parsing, so there is no quoting surface at all, and
/// `ExtractAssociatedIcon` yields 32px - the most the stock .NET surface gives without a native
/// addon.
///
/// `-ResolveAlias 1` is for a launcher that is an app execution alias: the empty reparse point the
/// shell keeps under `WindowsApps` answers with the generic application icon, while the packaged
/// application that declares the alias ships the real executable - under the same file name - and
/// that executable carries the application's own artwork.
const EXTRACT_ICON_PS1: &str = concat!(
    "param([string]$Source, [string]$Target, [string]$ResolveAlias)\n",
    "$ErrorActionPreference = \"Stop\"\n",
    "Add-Type -AssemblyName System.Drawing\n",
    "$resolved = $Source\n",
    "if ($ResolveAlias -eq \"1\") {\n",
    "  $name = [System.IO.Path]::GetFileName($Source)\n",
    "  foreach ($package in Get-AppxPackage) {\n",
    "    if ([string]::IsNullOrEmpty($package.InstallLocation)) { continue }\n",
    "    $candidate = Join-Path $package.InstallLocation $name\n",
    "    if (Test-Path -LiteralPath $candidate) { $resolved = $candidate; break }\n",
    "  }\n",
    "}\n",
    "$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($resolved)\n",
    "if ($null -eq $icon) { exit 1 }\n",
    "$bitmap = $icon.ToBitmap()\n",
    "$bitmap.Save($Target, [System.Drawing.Imaging.ImageFormat]::Png)\n",
);

/// Extract one resolved application's icon on this machine.
pub(super) fn extract(
    desktop_id: Option<&str>,
    icon: Option<&IconSource>,
    scratch: &Path,
) -> Option<IconData> {
    if let Some(desktop_id) = desktop_id {
        return linux_icon(desktop_id);
    }
    match icon? {
        IconSource::AppBundle(bundle) => bundle_icon(bundle, scratch),
        IconSource::Executable(executable) => executable_icon(executable, scratch),
    }
}

/// One scratch directory per extraction, removed whatever the extraction does.
struct WorkDir(PathBuf);

impl WorkDir {
    /// Create `<scratch>/open-in-app-<pid>-<sequence>`.
    fn create(scratch: &Path) -> Option<Self> {
        let sequence = ICON_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let directory = scratch.join(format!("open-in-app-{}-{sequence}", std::process::id()));
        fs::create_dir_all(&directory).ok()?;
        Some(Self(directory))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for WorkDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Extract one Windows executable's associated icon as a 32px PNG.
fn executable_icon(executable: &Path, scratch: &Path) -> Option<IconData> {
    if !cfg!(windows) {
        return None;
    }
    let source = executable.to_str()?;
    let resolve_alias = match alias_root() {
        Some(root) if is_app_execution_alias(executable, &root) => "1",
        _ => "0",
    };
    let work = WorkDir::create(scratch)?;
    let script = work.path().join("extract-icon.ps1");
    let target = work.path().join("icon.png");
    fs::write(&script, EXTRACT_ICON_PS1).ok()?;
    let script_path = script.to_str()?;
    let target_path = target.to_str()?;
    probe::run_bounded(
        "powershell.exe",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            script_path,
            "-Source",
            source,
            "-Target",
            target_path,
            "-ResolveAlias",
            resolve_alias,
        ],
        ICON_TIMEOUT,
        ICON_FILE_LIMIT,
    )?;
    read_icon(&target, "image/png")
}

/// The Windows directory holding app execution aliases.
fn alias_root() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .map(|value| PathBuf::from(value).join("Microsoft").join("WindowsApps"))
}

/// Whether one launcher is an app execution alias: an empty file under the alias directory.
fn is_app_execution_alias(executable: &Path, root: &Path) -> bool {
    if !executable.starts_with(root) {
        return false;
    }
    fs::metadata(executable)
        .map(|metadata| metadata.is_file() && metadata.len() == 0)
        .unwrap_or(false)
}

/// Theme sizes searched largest-first; the button renders at 15-18 CSS pixels.
const HICOLOR_SIZES: &[&str] = &["512x512", "256x256", "128x128", "64x64", "48x48", "32x32"];

/// One Linux application's icon from its desktop entry's `Icon=` key.
fn linux_icon(desktop_id: &str) -> Option<IconData> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let entry = probe::find_desktop_entry(desktop_id)?;
    let icon = entry.icon?;
    if icon.is_empty() {
        return None;
    }
    if Path::new(&icon).is_absolute() {
        return read_any_icon_file(Path::new(&icon));
    }
    find_theme_icon(&icon)
}

/// Resolve one icon name through the hicolor theme and the pixmaps directories, largest first.
///
/// The user's active icon theme is not consulted: hicolor is the fallback every theme inherits
/// from, so the stock icon is found wherever the application installed one.
fn find_theme_icon(name: &str) -> Option<IconData> {
    for directory in probe::xdg_data_dirs() {
        for size in HICOLOR_SIZES {
            for extension in ["png", "svg"] {
                let candidate = directory
                    .join("icons/hicolor")
                    .join(size)
                    .join("apps")
                    .join(format!("{name}.{extension}"));
                if let Some(icon) = read_any_icon_file(&candidate) {
                    return Some(icon);
                }
            }
        }
        let scalable = directory
            .join("icons/hicolor/scalable/apps")
            .join(format!("{name}.svg"));
        if let Some(icon) = read_any_icon_file(&scalable) {
            return Some(icon);
        }
        for extension in ["png", "svg"] {
            let pixmap = directory
                .join("pixmaps")
                .join(format!("{name}.{extension}"));
            if let Some(icon) = read_any_icon_file(&pixmap) {
                return Some(icon);
            }
        }
    }
    None
}

/// Read one icon file whose extension names a media type the frontend can draw.
fn read_any_icon_file(path: &Path) -> Option<IconData> {
    let mime = match path.extension().and_then(|extension| extension.to_str()) {
        Some("png") => "image/png",
        Some("svg") => "image/svg+xml",
        _ => return None,
    };
    read_icon(path, mime)
}

/// Read one icon file under the size ceiling.
fn read_icon(path: &Path, mime: &'static str) -> Option<IconData> {
    // The metadata check keeps a file that is far too large from being read at all; the length is
    // checked again afterwards, because the file could have grown while it was being read.
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > ICON_FILE_LIMIT as u64 {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if bytes.is_empty() || bytes.len() > ICON_FILE_LIMIT {
        return None;
    }
    Some(IconData { bytes, mime })
}

/// Whether the path names an existing regular file.
fn is_file(path: &Path) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

/// Convert one macOS bundle's declared icon to a 128px PNG.
fn bundle_icon(bundle: &Path, scratch: &Path) -> Option<IconData> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let resources = bundle.join("Contents/Resources");
    let icns = declared_icns(bundle).or_else(|| first_icns(&resources))?;
    let work = WorkDir::create(scratch)?;
    let target = work.path().join("icon.png");
    probe::run_bounded(
        "sips",
        &[
            "-s",
            "format",
            "png",
            "-Z",
            "128",
            icns.to_str()?,
            "--out",
            target.to_str()?,
        ],
        ICON_TIMEOUT,
        ICON_FILE_LIMIT,
    )?;
    // A `sips` run that exits 0 without writing its output leaves nothing to read.
    read_icon(&target, "image/png")
}

/// The `.icns` file `Info.plist` declares, when it declares one that exists on disk: `None` sends
/// the caller to the resources scan instead.
fn declared_icns(bundle: &Path) -> Option<PathBuf> {
    let plist = bundle.join("Contents/Info.plist");
    let json = probe::probe_output("plutil", &["-convert", "json", "-o", "-", plist.to_str()?])?;
    let value: serde_json::Value = serde_json::from_str(&json).ok()?;
    let declared = value.get("CFBundleIconFile")?.as_str()?.to_owned();
    if declared.is_empty() {
        return None;
    }
    let file = if declared.ends_with(".icns") {
        declared
    } else {
        format!("{declared}.icns")
    };
    let path = bundle.join("Contents/Resources").join(file);
    is_file(&path).then_some(path)
}

/// The first `.icns` in a bundle's resources directory.
fn first_icns(resources: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(resources).ok()?;
    let mut names: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|extension| extension.to_str()) == Some("icns"))
        .collect();
    names.sort();
    names.into_iter().next()
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use super::is_app_execution_alias;

    /// An app execution alias is recognised by where it lives and by being empty: the shell's
    /// alias is a zero-byte reparse point, while the executable it stands for has bytes - wherever
    /// that executable sits.
    #[test]
    fn only_an_empty_launcher_under_the_alias_root_is_an_alias() {
        let root = std::env::temp_dir().join(format!("omp-alias-{}", std::process::id()));
        let alias_directory = root.join("Microsoft").join("WindowsApps");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&alias_directory).expect("alias scratch");

        let alias = alias_directory.join("wt.exe");
        fs::write(&alias, b"").expect("alias file");
        assert!(is_app_execution_alias(&alias, &alias_directory));

        let real = alias_directory.join("code.exe");
        fs::write(&real, b"MZ").expect("real launcher");
        assert!(!is_app_execution_alias(&real, &alias_directory));

        let elsewhere = root.join("wt.exe");
        fs::write(&elsewhere, b"").expect("empty launcher outside the alias root");
        assert!(!is_app_execution_alias(&elsewhere, &alias_directory));

        let missing = alias_directory.join("gone.exe");
        assert!(!is_app_execution_alias(&missing, &alias_directory));

        let _ = fs::remove_dir_all(&root);
        assert!(!is_app_execution_alias(
            Path::new("wt.exe"),
            &alias_directory
        ));
    }
}
