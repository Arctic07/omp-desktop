//! A plugin theme's stylesheet: what it may contain, what is dropped, and what is rewritten.
//!
//! A theme is the first thing a plugin contributes that reaches the *application's* document rather
//! than the plugin's own page, so this module is the whole boundary between a file an author wrote
//! and text a `<style>` element receives. Three rules shape it.
//!
//! **The stylesheet is text, not a document.** It is read as UTF-8, bounded in bytes and sanitised
//! here; nothing ever links it, so there is no `@import` (a stylesheet importing from a network this
//! build does not serve), no markup escape (`<style`, `</style`, `<!--`, `-->`: this text is never
//! parsed as HTML, and a sample that tries is a sample written for the wrong reader), and no script
//! door (`expression(`, `javascript:`, `behavior:`, `-moz-binding`) - none of which has a legitimate
//! use in a theme, which is why the table is a plain substring scan rather than a parse.
//!
//! **An asset is only what the theme declared.** A `url(...)` may name a `data:` URI or one of the
//! theme's own declared assets - spelled package-relative, relative to the stylesheet, or already in
//! the served form - and nothing else. Each allowed target is rewritten to the absolute URL the
//! asset is served from (`services::plugins::pages`), which is the same URL form a page is loaded
//! from: one form in this codebase, so a fetched file has one address and one origin per
//! installation.
//!
//! **A refusal is per theme, and it is said out loud.** The caller
//! (`models::plugins::recheck_desktop`) keeps the theme's tokens and reports the refusal on the row
//! (`cssError`), because a stylesheet this layer cannot vouch for is not a reason to take a plugin's
//! pages down - and a theme silently losing its stylesheet would be a bug its author could not see.
//!
//! `@charset`: accepted **once, as the very first token** (after a byte-order mark and leading
//! whitespace) and removed from the text this layer publishes, because an injected `<style>` node has
//! no encoding of its own to declare. Any other `@charset` refuses the stylesheet.
//!
//! **The application document's policy is not touched.** `src-tauri/tauri.conf.json` keeps its
//! `style-src 'self' 'unsafe-inline'` - and it declares no `img-src`/`font-src` and no `default-src`,
//! so an image or a font a rewritten `url()` names is not restricted by that policy at all. The real
//! machine has since answered the rest (2026-10-27): an image paints from the plugin's origin, and a
//! declared `@font-face` `woff2` was **refused** - browsers fetch a font in CORS mode and this
//! protocol answered without `Access-Control-Allow-Origin`. The fix is `protocol.rs`'s
//! `Answer::theme_asset`: a **declared** theme asset carries that header (and
//! `Cross-Origin-Resource-Policy: cross-origin`), a page's own asset still does not. Nothing here
//! loosens the policy.

use std::path::{Path, PathBuf};

use crate::services::plugins::gates;
use crate::services::plugins::pages;

/// Longest stylesheet this build carries into the document (plan §5.1).
pub(crate) const CSS_MAX_BYTES: u64 = 256 * 1024;

/// Most assets one theme may declare. The host caps the count too (`PLUGIN_THEME_ASSETS_MAX`); this
/// is the side that reads the bytes, so it re-checks rather than trusting the count it was handed.
pub(crate) const ASSETS_MAX: usize = 16;

/// Ceiling on the real bytes of the files one theme declares (plan §5.1). Real sizes, from the
/// filesystem: a manifest that under-declares is a manifest, not evidence.
pub(crate) const ASSETS_TOTAL_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// The reason token a theme's row carries when the content it declared did not apply.
pub(crate) const REFUSAL_REASON: &str = "theme_css_invalid";

/// The asset extensions this build serves, as `services::plugins::pages` answers them. Closed, and
/// the same list the host validates (`PLUGIN_THEME_ASSET_EXTENSIONS`): a file this build cannot name
/// a type for is not an asset a theme may paint with.
const ASSET_EXTENSIONS: &[&str] = &["svg", "png", "jpg", "jpeg", "webp", "avif", "woff2"];

/// What a stylesheet may never contain, matched case-insensitively on the whole text.
const FORBIDDEN: &[(&str, CssRefusal)] = &[
    ("@import", CssRefusal::Import),
    // Checked after a single leading declaration is stripped, so this is "a second `@charset`".
    ("@charset", CssRefusal::Charset),
    ("expression(", CssRefusal::Expression),
    ("expression (", CssRefusal::Expression),
    ("javascript:", CssRefusal::Script),
    ("<style", CssRefusal::Markup),
    ("</style", CssRefusal::Markup),
    ("<!--", CssRefusal::Markup),
    ("-->", CssRefusal::Markup),
    ("behavior:", CssRefusal::Behavior),
    ("-moz-binding", CssRefusal::Binding),
];

/// Why one theme's declared content was refused.
///
/// A closed set of causes rather than a sentence: the row carries one reason code
/// ([`REFUSAL_REASON`], the contract's), and the log line carries this one, so a plugin author
/// reading the log learns *which* rule refused the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CssRefusal {
    /// The declared file is not there, or is not a file.
    MissingFile,
    /// The stylesheet is over [`CSS_MAX_BYTES`].
    TooLarge,
    /// More assets than [`ASSETS_MAX`].
    TooManyAssets,
    /// The declared assets are, together, over [`ASSETS_TOTAL_MAX_BYTES`].
    AssetsTooLarge,
    /// A declared path is not one this layer resolves (shape, `node_modules`, the reject table, a
    /// symlink leaving the plugin root), or a served URL could not be built from it.
    UnsafePath,
    /// The stylesheet is not UTF-8, so there is no text to inject.
    NotUtf8,
    Import,
    Expression,
    Script,
    Markup,
    ControlCharacter,
    Behavior,
    Binding,
    Charset,
    /// A backslash outside a string: the one way to spell a forbidden keyword the substring scan
    /// would not see (`@im\port`), so it is refused where it appears.
    Escape,
    /// An unbalanced comment, quote or brace - or a brace that closes more than it opens.
    Unbalanced,
    /// A `url(...)` naming something that is neither a `data:` URI nor one of the theme's assets.
    UndeclaredAsset,
}

impl CssRefusal {
    /// The token this refusal is logged as.
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::MissingFile => "missing_file",
            Self::TooLarge => "too_large",
            Self::TooManyAssets => "too_many_assets",
            Self::AssetsTooLarge => "assets_too_large",
            Self::UnsafePath => "unsafe_path",
            Self::NotUtf8 => "not_utf8",
            Self::Import => "import",
            Self::Expression => "expression",
            Self::Script => "script",
            Self::Markup => "markup",
            Self::ControlCharacter => "control_character",
            Self::Behavior => "behavior",
            Self::Binding => "binding",
            Self::Charset => "charset",
            Self::Escape => "escape",
            Self::Unbalanced => "unbalanced",
            Self::UndeclaredAsset => "undeclared_asset",
        }
    }
}

/// One theme's content as the row carries it: the text to inject, and the URLs its assets are served
/// from.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Prepared {
    pub(crate) css: Option<String>,
    pub(crate) assets: Vec<String>,
}

/// Reads and sanitises one theme's declared content, against the package `root` and the origin its
/// installation is served from.
///
/// The order is the one the answer needs: the assets first (they are what the stylesheet is allowed
/// to name, so an asset that fails has to refuse the theme before the text is rewritten), then the
/// stylesheet. Every path is resolved the way `services::plugins::pages` resolves a request - shape,
/// the reject table, `realpath` inside the root - because these are the same files served from the
/// same origin afterwards, and a rule only one side applies is not a rule.
pub(crate) fn prepare(
    root: &Path,
    origin: &str,
    css: Option<&str>,
    assets: &[String],
) -> Result<Prepared, CssRefusal> {
    if assets.len() > ASSETS_MAX {
        return Err(CssRefusal::TooManyAssets);
    }
    let root = std::fs::canonicalize(root).map_err(|_| CssRefusal::MissingFile)?;
    let mut urls: Vec<String> = Vec::with_capacity(assets.len());
    let mut declared: Vec<(String, String)> = Vec::with_capacity(assets.len());
    let mut total = 0u64;
    for asset in assets {
        let file = resolve_file(&root, asset, true)?;
        let size = std::fs::metadata(&file)
            .map_err(|_| CssRefusal::MissingFile)?
            .len();
        total = total.saturating_add(size);
        if total > ASSETS_TOTAL_MAX_BYTES {
            return Err(CssRefusal::AssetsTooLarge);
        }
        let url = pages::page_url(origin, asset).ok_or(CssRefusal::UnsafePath)?;
        urls.push(url.clone());
        declared.push((asset.clone(), url));
    }
    let Some(css) = css else {
        return Ok(Prepared {
            css: None,
            assets: urls,
        });
    };
    let file = resolve_file(&root, css, false)?;
    let size = std::fs::metadata(&file)
        .map_err(|_| CssRefusal::MissingFile)?
        .len();
    if size > CSS_MAX_BYTES {
        return Err(CssRefusal::TooLarge);
    }
    let bytes = std::fs::read(&file).map_err(|_| CssRefusal::MissingFile)?;
    // Bounded again on what was actually read: a file that grew between the two calls is refused
    // rather than carried into the renderer on the strength of an earlier size.
    if bytes.len() as u64 > CSS_MAX_BYTES {
        return Err(CssRefusal::TooLarge);
    }
    let text = String::from_utf8(bytes).map_err(|_| CssRefusal::NotUtf8)?;
    let rewritten = sanitize(&text, css, &declared)?;
    Ok(Prepared {
        css: Some(rewritten),
        assets: urls,
    })
}

/// The sanitised text of one stylesheet, its allowed `url(...)` targets rewritten.
///
/// `stylesheet` is the declared path the text came from (a relative `url()` is resolved against its
/// directory), and `declared` is the theme's own asset list as `(declared path, served URL)` pairs,
/// in declared order. Pure: no filesystem, no origin - which is what makes it the part worth
/// testing rule by rule.
pub(crate) fn sanitize(
    text: &str,
    stylesheet: &str,
    declared: &[(String, String)],
) -> Result<String, CssRefusal> {
    if text
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\t' | '\n' | '\r'))
    {
        return Err(CssRefusal::ControlCharacter);
    }
    let body = strip_leading_charset(text)?;
    let lowered = body.to_lowercase();
    for (token, refusal) in FORBIDDEN {
        if lowered.contains(token) {
            return Err(*refusal);
        }
    }
    rewrite_urls(body, stylesheet, declared)
}

/// Whether one path carries an extension this build serves as a theme asset.
///
/// The resolver asks this to tell "a theme asset I did not declare" (a policy refusal) from "a file
/// that is not there" - and it is the same closed list [`prepare`] accepts, so the two answers
/// cannot disagree about what an asset is.
pub(crate) fn is_theme_asset_path(path: &str) -> bool {
    ASSET_EXTENSIONS.contains(&extension_of(path).as_str())
}

/// The extension of one path, lowercased, or the empty string when it has none.
fn extension_of(path: &str) -> String {
    path.rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default()
}

/// Whether one declared path is the shape this layer will turn into a filesystem lookup and a URL.
///
/// `asset` selects the extension rule: an asset is one of [`ASSET_EXTENSIONS`], a stylesheet is
/// `.css`. `node_modules` is refused on both: it is a dependency tree the package manager owns, never
/// a place a plugin declares a file of its own from (the same rule the host applies to `main`).
fn shape_is_valid(declared: &str, asset: bool) -> bool {
    if !pages::is_safe_relative(declared) || gates::is_rejected_path(declared) {
        return false;
    }
    if declared
        .split('/')
        .any(|segment| segment.eq_ignore_ascii_case("node_modules"))
    {
        return false;
    }
    let extension = extension_of(declared);
    if asset {
        ASSET_EXTENSIONS.contains(&extension.as_str())
    } else {
        extension == "css"
    }
}

/// One declared path as a real file inside `root`, or the refusal.
fn resolve_file(root: &Path, declared: &str, asset: bool) -> Result<PathBuf, CssRefusal> {
    if !shape_is_valid(declared, asset) {
        return Err(CssRefusal::UnsafePath);
    }
    let candidate = root.join(declared.replace('/', std::path::MAIN_SEPARATOR_STR));
    let resolved = std::fs::canonicalize(&candidate).map_err(|_| CssRefusal::MissingFile)?;
    if !crate::services::paths::is_within(root, &resolved) {
        return Err(CssRefusal::UnsafePath);
    }
    if !resolved.is_file() {
        return Err(CssRefusal::MissingFile);
    }
    Ok(resolved)
}

/// The stylesheet without its single leading `@charset`, or the text unchanged when it has none.
///
/// One leading declaration is accepted and dropped (see the module's note); anything else that spells
/// `@charset` is a refusal, which the caller's forbidden table then catches because this function has
/// already removed the accepted one.
fn strip_leading_charset(text: &str) -> Result<&str, CssRefusal> {
    let trimmed = text.trim_start_matches(['\u{feff}', ' ', '\t', '\r', '\n']);
    let Some(head) = trimmed.get(..8) else {
        return Ok(text);
    };
    if !head.eq_ignore_ascii_case("@charset") {
        return Ok(text);
    }
    let after = &trimmed[8..];
    if after.len() == after.trim_start().len() {
        return Err(CssRefusal::Charset);
    }
    let after = after.trim_start();
    let Some(quote) = after.chars().next().filter(|c| matches!(c, '"' | '\'')) else {
        return Err(CssRefusal::Charset);
    };
    let rest = &after[quote.len_utf8()..];
    let end = rest.find(quote).ok_or(CssRefusal::Charset)?;
    let tail = rest[end + 1..].trim_start();
    let Some(tail) = tail.strip_prefix(';') else {
        return Err(CssRefusal::Charset);
    };
    Ok(tail.trim_start_matches(['\u{feff}', ' ', '\t', '\r', '\n']))
}

/// The text with every `url(...)` rewritten to the absolute URL of the asset it names, and the
/// structure checks (comments, strings, braces, escapes) applied on the way through.
///
/// One pass, because the two questions are about the same bytes: a `url(` inside a string or a
/// comment is not a function, and a brace inside one is not a block.
fn rewrite_urls(
    text: &str,
    stylesheet: &str,
    declared: &[(String, String)],
) -> Result<String, CssRefusal> {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0usize;
    let mut index = 0usize;
    let mut depth = 0i32;
    while index < bytes.len() {
        match bytes[index] {
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                index = skip_comment(text, index)?;
                continue;
            }
            quote @ (b'"' | b'\'') => {
                index = skip_string(text, index, quote)?;
                continue;
            }
            b'\\' => return Err(CssRefusal::Escape),
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth < 0 {
                    return Err(CssRefusal::Unbalanced);
                }
            }
            _ if starts_url_function(text, index) => {
                let (target, after) = read_url(text, index)?;
                let rewritten = resolve_target(&target, stylesheet, declared)?;
                out.push_str(&text[copied..index]);
                out.push_str("url(\"");
                out.push_str(&rewritten);
                out.push_str("\")");
                index = after;
                copied = after;
                continue;
            }
            _ => {}
        }
        index += char_len_at(text, index);
    }
    if depth != 0 {
        return Err(CssRefusal::Unbalanced);
    }
    out.push_str(&text[copied..]);
    Ok(out)
}

/// Whether the text at `index` spells the `url(` function token.
///
/// The character before it has to be a non-identifier one: `myurl(` is an identifier, not a
/// function, and reading it as one would rewrite text the stylesheet never meant as a URL.
fn starts_url_function(text: &str, index: usize) -> bool {
    if let Some(previous) = text[..index].chars().next_back() {
        if previous.is_ascii_alphanumeric() || matches!(previous, '-' | '_' | '\\') {
            return false;
        }
    }
    text.get(index..index + 4)
        .is_some_and(|word| word.eq_ignore_ascii_case("url("))
}

/// One `url(...)` function's target, and the index just past its closing parenthesis.
fn read_url(text: &str, index: usize) -> Result<(String, usize), CssRefusal> {
    let bytes = text.as_bytes();
    let mut cursor = index + 4;
    while matches!(bytes.get(cursor), Some(b' ' | b'\t' | b'\n' | b'\r')) {
        cursor += 1;
    }
    let quote = match bytes.get(cursor) {
        Some(byte @ (b'"' | b'\'')) => {
            cursor += 1;
            Some(*byte)
        }
        _ => None,
    };
    let start = cursor;
    loop {
        let Some(byte) = bytes.get(cursor).copied() else {
            return Err(CssRefusal::Unbalanced);
        };
        match quote {
            Some(quote) => {
                if byte == b'\\' {
                    cursor += 1;
                    cursor += char_len_at(text, cursor);
                    continue;
                }
                if byte == quote {
                    break;
                }
            }
            None => {
                if byte == b')' {
                    break;
                }
                if byte == b'\\' {
                    return Err(CssRefusal::Escape);
                }
            }
        }
        cursor += char_len_at(text, cursor);
    }
    let Some(target) = text.get(start..cursor).map(str::to_owned) else {
        return Err(CssRefusal::Unbalanced);
    };
    if quote.is_some() {
        cursor += 1;
        while matches!(bytes.get(cursor), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            cursor += 1;
        }
        if bytes.get(cursor) != Some(&b')') {
            return Err(CssRefusal::Unbalanced);
        }
    }
    Ok((target, cursor + 1))
}

/// The one URL an allowed `url(...)` target is rewritten to.
///
/// Three spellings name a declared asset - the package-relative path, a path relative to the
/// stylesheet's own directory, and the served form itself - and each has to resolve to an entry of
/// the theme's declared list. Anything else is refused: another origin, a protocol-relative address,
/// an absolute filesystem path, a query or fragment, and a path that climbs out of the package.
fn resolve_target(
    raw: &str,
    stylesheet: &str,
    declared: &[(String, String)],
) -> Result<String, CssRefusal> {
    let target = raw.trim();
    if target.is_empty() || target.contains(['?', '#']) {
        return Err(CssRefusal::UndeclaredAsset);
    }
    if target.to_ascii_lowercase().starts_with("data:") {
        // A `data:` URI is its own content, not a second file to address; it is carried as written.
        // A quote or a backslash in it would end the string this layer puts it in, so both are
        // refused rather than escaped: no theme needs either.
        if target.contains(['"', '\'', '\\']) {
            return Err(CssRefusal::UndeclaredAsset);
        }
        return Ok(target.to_owned());
    }
    if let Some((_, url)) = declared.iter().find(|(_, url)| url == target) {
        return Ok(url.clone());
    }
    if target.starts_with('/') || target.starts_with("//") || has_scheme(target) {
        return Err(CssRefusal::UndeclaredAsset);
    }
    let decoded = pages::percent_decode(target).ok_or(CssRefusal::UndeclaredAsset)?;
    if decoded.contains('\\') {
        return Err(CssRefusal::UndeclaredAsset);
    }
    // Two readings of one relative target, in the order a stylesheet's author expects: the path CSS
    // itself would resolve (against the stylesheet's own directory), then the package-relative
    // spelling of the same file - a manifest names its assets one way, and a stylesheet written
    // beside them usually names them the other. Both end at the declared list, or not at all.
    if let Some(joined) = join_relative(stylesheet, &decoded) {
        if let Some((_, url)) = declared.iter().find(|(path, _)| *path == joined) {
            return Ok(url.clone());
        }
    }
    let direct = decoded.trim_start_matches("./");
    declared
        .iter()
        .find(|(path, _)| path == direct)
        .map(|(_, url)| url.clone())
        .ok_or(CssRefusal::UndeclaredAsset)
}

/// Whether a target names a scheme (`http:`, `file:`, `javascript:` ...), which no theme asset does.
fn has_scheme(target: &str) -> bool {
    match target.split_once(':') {
        Some((scheme, _)) => !scheme.contains('/'),
        None => false,
    }
}

/// `target` resolved against the directory `stylesheet` sits in, as a package-relative path.
///
/// `None` when it climbs above the package root or names nothing: the two answers are one refusal
/// because both would be a path this layer cannot tie to a declared asset.
fn join_relative(stylesheet: &str, target: &str) -> Option<String> {
    let mut segments: Vec<&str> = match stylesheet.rsplit_once('/') {
        Some((directory, _)) => directory.split('/').collect(),
        None => Vec::new(),
    };
    for segment in target.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop()?;
            }
            other => segments.push(other),
        }
    }
    if segments.is_empty() {
        return None;
    }
    Some(segments.join("/"))
}

/// The index just past the `*/` that closes the comment starting at `index`.
fn skip_comment(text: &str, index: usize) -> Result<usize, CssRefusal> {
    match text[index + 2..].find("*/") {
        Some(end) => Ok(index + 2 + end + 2),
        None => Err(CssRefusal::Unbalanced),
    }
}

/// The index just past the quote that closes the string starting at `index`.
fn skip_string(text: &str, index: usize, quote: u8) -> Result<usize, CssRefusal> {
    let bytes = text.as_bytes();
    let mut cursor = index + 1;
    while cursor < bytes.len() {
        match bytes[cursor] {
            b'\\' => {
                cursor += 1;
                cursor += char_len_at(text, cursor);
            }
            byte if byte == quote => return Ok(cursor + 1),
            _ => cursor += char_len_at(text, cursor),
        }
    }
    Err(CssRefusal::Unbalanced)
}

/// The length in bytes of the character starting at `index` (1 past the end, so a caller's loop
/// always terminates).
fn char_len_at(text: &str, index: usize) -> usize {
    text.get(index..)
        .and_then(|rest| rest.chars().next())
        .map_or(1, char::len_utf8)
}

#[cfg(test)]
mod tests;
