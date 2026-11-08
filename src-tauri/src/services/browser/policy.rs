//! What the built-in browser may open: one set of address and local-file rules.
//!
//! One policy for every entry point - the address bar, a link, the agent's `Browser` tool and
//! `BrowserPreview` - so an address that is refused by one surface is refused by all. The browser
//! loads pages this application does not own, so the rules are deliberately small:
//!
//! - `http`/`https` are the web this browser exists for; anything typed without a scheme is read as
//!   `http://` unless it is a dotted host (or `localhost`) followed by a numeric port, which is a
//!   web address rather than a custom scheme.
//! - A local file is previewable when it exists. `BrowserPreview` and relative address-bar entries
//!   stay inside the conversation's workspace (and its scratch directory); an explicit `file:` URL
//!   or an absolute path may name any existing local file, which is what a local document's own
//!   links do.
//! - A navigation that leaves the web is refused by the webview's own handler unless it is one of
//!   those local files.
//!
//! The four entry points (`normalize_url`, `resolve_local_file`, `resolve_browser_local_file`,
//! `is_allowed_file_url`) are this application's own implementation of the rules above.

use std::path::{Path, PathBuf};

use tauri::Url;

use crate::services::paths::is_within;

/// The page a webview starts on before it is told where to go.
pub(crate) const START_URL: &str = "about:blank";

/// Ceiling on one address, in characters. An address is a bounded token; the bound keeps a hostile
/// caller from handing the webview's parser a megabyte.
const MAX_URL_CHARS: usize = 8_192;

/// What one navigation input names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Target {
    /// A web address, already serialized by [`Url`].
    Web(String),
    /// An existing local file.
    File(PathBuf),
}

/// Why an address was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TargetError {
    /// The input named a local file that does not exist, or that lies outside the allowed roots.
    LocalFileNotAllowed,
    /// The input is not an address this browser opens.
    InvalidUrl,
}

impl TargetError {
    /// The state string the chrome and the agent see for this refusal.
    pub(crate) fn load_error(self) -> &'static str {
        match self {
            Self::LocalFileNotAllowed => "LOCAL_FILE_NOT_ALLOWED",
            Self::InvalidUrl => "INVALID_URL",
        }
    }
}

/// Whether `raw` is a scheme marker at the start (`http:`, `file:`, `mailto:`).
fn has_scheme(raw: &str) -> bool {
    let mut characters = raw.chars();
    match characters.next() {
        Some(first) if first.is_ascii_alphabetic() => {}
        _ => return false,
    }
    for character in characters {
        if character == ':' {
            return true;
        }
        if !(character.is_ascii_alphanumeric() || matches!(character, '+' | '.' | '-')) {
            return false;
        }
    }
    false
}

/// Whether `raw` is `localhost:5173` or `example.com:8080` (an address, not a scheme).
fn has_host_port(raw: &str) -> bool {
    let Some((host, rest)) = raw.split_once(':') else {
        return false;
    };
    if host.is_empty() {
        return false;
    }
    let localhost = host.eq_ignore_ascii_case("localhost");
    let dotted = host.contains('.')
        && host.split('.').all(|label| {
            !label.is_empty() && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        });
    if !(localhost || dotted) {
        return false;
    }
    let port_len = rest
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .count();
    if port_len == 0 {
        return false;
    }
    let after = &rest[port_len..];
    after.is_empty() || after.starts_with(['/', '?', '#'])
}

/// Normalize an address: an `http(s)` address, with a missing scheme read as
/// `http://`. A custom scheme stays subject to the allowlist rather than being prefixed.
pub(crate) fn normalize_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_URL_CHARS {
        return None;
    }
    let with_scheme = if has_scheme(trimmed) && !has_host_port(trimmed) {
        trimmed.to_owned()
    } else {
        format!("http://{trimmed}")
    };
    let url = Url::parse(&with_scheme).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    Some(url.to_string())
}

/// Whether `raw` is unambiguously a local-file input rather than a web address.
///
/// A bare relative path with an extension (`index.html`) is not in this set: it is tried as a local
/// file first and falls back to a web address when no such file exists, which is the reference
/// desktop's `resolveBrowserLocalFile` then `normalizeUrl` order.
fn looks_local(raw: &str) -> bool {
    raw.starts_with("file:")
        || Path::new(raw).is_absolute()
        || raw.starts_with("./")
        || raw.starts_with("../")
        || raw.starts_with(".\\")
        || raw.starts_with("..\\")
}

/// One existing file, canonicalized, or `None`.
fn existing_file(candidate: &Path) -> Option<PathBuf> {
    let real = std::fs::canonicalize(candidate).ok()?;
    real.is_file().then_some(real)
}

/// A `file:` URL's path, or `None` for any other scheme (and for a non-local host).
fn file_url_path(raw: &str) -> Option<PathBuf> {
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "file" {
        return None;
    }
    if let Some(host) = url.host_str() {
        if !host.is_empty() && !host.eq_ignore_ascii_case("localhost") {
            return None;
        }
    }
    url.to_file_path().ok()
}

/// Resolve a local file: a file URL, an absolute path, or a workspace-relative
/// path, required to exist inside one of `roots`.
pub(crate) fn resolve_local_file(raw: &str, roots: &[PathBuf]) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let relative = trimmed.starts_with("./")
        || trimmed.starts_with("../")
        || trimmed.starts_with(".\\")
        || trimmed.starts_with("..\\")
        || Path::new(trimmed).extension().is_some();
    let candidates: Vec<PathBuf> = if trimmed.to_ascii_lowercase().starts_with("file:") {
        vec![file_url_path(trimmed)?]
    } else if Path::new(trimmed).is_absolute() {
        vec![PathBuf::from(trimmed)]
    } else if relative {
        roots.iter().map(|root| root.join(trimmed)).collect()
    } else {
        return None;
    };
    for candidate in candidates {
        let Some(real) = existing_file(&candidate) else {
            continue;
        };
        if roots.iter().any(|root| is_within(root, &real)) {
            return Some(real);
        }
    }
    None
}

/// Resolve a browser local file: explicit file URLs and absolute paths may
/// target any existing local file; relative inputs stay rooted in the workspace.
pub(crate) fn resolve_browser_local_file(raw: &str, roots: &[PathBuf]) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.to_ascii_lowercase().starts_with("file:") {
        return existing_file(&file_url_path(trimmed)?);
    }
    if Path::new(trimmed).is_absolute() {
        return existing_file(Path::new(trimmed));
    }
    resolve_local_file(trimmed, roots)
}

/// Whether a `file:` URL may be loaded: an existing file inside one of the roots, or any existing
/// local file when the current document is itself local (a local page may follow its own links).
pub(crate) fn allowed_file_url(raw: &str, roots: &[PathBuf], current_is_file: bool) -> bool {
    let Some(path) = file_url_path(raw) else {
        return false;
    };
    let Some(real) = existing_file(&path) else {
        return false;
    };
    if roots.iter().any(|root| is_within(root, &real)) {
        return true;
    }
    current_is_file
}

/// Resolve one navigation input into what the webview should load.
///
/// `roots` are the conversation's workspace roots (and its scratch directory). `preview` is the
/// `BrowserPreview` rule: a local path must resolve inside those roots, never anywhere else.
pub(crate) fn target_for(
    raw: &str,
    roots: &[PathBuf],
    preview: bool,
) -> Result<Target, TargetError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_URL_CHARS {
        return Err(TargetError::InvalidUrl);
    }
    if looks_local(trimmed) {
        let local = if preview {
            resolve_local_file(trimmed, roots)
        } else {
            resolve_browser_local_file(trimmed, roots)
        };
        return local
            .map(Target::File)
            .ok_or(TargetError::LocalFileNotAllowed);
    }
    // A bare relative path that names an existing file is a preview; one that names nothing is
    // read as an address (`index.html` → `http://index.html/`).
    if let Some(local) = if preview {
        resolve_local_file(trimmed, roots)
    } else {
        resolve_browser_local_file(trimmed, roots)
    } {
        return Ok(Target::File(local));
    }
    normalize_url(trimmed)
        .map(Target::Web)
        .ok_or(TargetError::InvalidUrl)
}

/// The URL a [`Target`] loads.
pub(crate) fn target_url(target: &Target) -> Option<Url> {
    match target {
        Target::Web(url) => Url::parse(url).ok(),
        Target::File(path) => Url::from_file_path(path).ok(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_addresses_are_normalized_like_the_reference() {
        assert_eq!(
            normalize_url("example.com/a").as_deref(),
            Some("http://example.com/a")
        );
        assert_eq!(
            normalize_url("localhost:5173").as_deref(),
            Some("http://localhost:5173/")
        );
        assert_eq!(
            normalize_url(" https://example.com/a?b=c#d ").as_deref(),
            Some("https://example.com/a?b=c#d")
        );
        assert_eq!(normalize_url("mailto:dev@example.com"), None);
        assert_eq!(normalize_url("file:///C:/x"), None);
        assert_eq!(normalize_url("data:text/html,hi"), None);
        assert_eq!(normalize_url(""), None);
    }

    #[test]
    fn a_relative_path_stays_inside_the_workspace() {
        let root = std::env::temp_dir().join(format!("omp-browser-policy-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("index.html");
        std::fs::write(&file, "<html></html>").unwrap();
        let roots = vec![root.clone()];
        assert_eq!(
            resolve_local_file("index.html", &roots),
            Some(std::fs::canonicalize(&file).unwrap())
        );
        assert_eq!(
            resolve_local_file("./index.html", &roots),
            Some(std::fs::canonicalize(&file).unwrap())
        );
        assert_eq!(resolve_local_file("../index.html", &roots), None);
        assert_eq!(
            target_for("index.html", &roots, false),
            Ok(Target::File(std::fs::canonicalize(&file).unwrap()))
        );
        assert_eq!(
            target_for("https://example.com", &roots, false),
            Ok(Target::Web("https://example.com/".to_owned()))
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_explicit_file_url_may_leave_the_workspace_but_a_preview_may_not() {
        let root =
            std::env::temp_dir().join(format!("omp-browser-policy-a-{}", std::process::id()));
        let outside =
            std::env::temp_dir().join(format!("omp-browser-policy-b-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let file = outside.join("page.html");
        std::fs::write(&file, "<html></html>").unwrap();
        let url = Url::from_file_path(&file).unwrap().to_string();
        let roots = vec![root.clone()];
        assert!(resolve_browser_local_file(&url, &roots).is_some());
        assert!(resolve_local_file(&url, &roots).is_none());
        assert_eq!(
            target_for(&url, &roots, true),
            Err(TargetError::LocalFileNotAllowed)
        );
        assert!(allowed_file_url(&url, &roots, false) == false);
        assert!(allowed_file_url(&url, &roots, true));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }
}
