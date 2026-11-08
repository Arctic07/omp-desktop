//! The bounded directory walk behind `fs.glob` (`rules.md#plugin-system`).
//!
//! `fs.list` answers one directory; this is the other half of "reach a whole disk and be able to use
//! it": a pattern that names many files at once. Three properties are what make it the same gate as
//! the reads beside it rather than a second one:
//!
//! - **The pattern language is the manifest's.** A pattern is split into the literal prefix that
//!   names where to start and the remainder that each candidate is matched against, and the remainder
//!   is checked with [`gates::validate_scope_pattern`] and matched with [`gates::scope_matches`] - the
//!   same two functions a declared `fs.read.scope` goes through. `**` stands for one or more whole
//!   segments, exactly as it does there; `?`, `[]`, `{}` and the rest of the forbidden set are a
//!   refusal, not a wildcard this side would have to invent a second matcher for.
//! - **Nothing here can leave the base.** The base directory arrives already resolved through the
//!   read gates (containment plus the reject table), symbolic links are never followed - neither a
//!   linked directory nor a linked file is entered or reported - and every candidate's path below the
//!   base is passed through [`gates::is_rejected_path`] before it can be a hit, in the one case the
//!   read gate applies that table at all: an installation that holds `fs.anyPath` drops it here
//!   exactly as it drops it in front of a read. So a package that ships `notes.md` as a link to a
//!   credential file cannot have that file walked to.
//! - **Every walk is bounded.** Entries, directories and depth each have a ceiling; the first one hit
//!   stops the walk and marks the answer `truncated` rather than refusing it, because a partial
//!   listing of what a pattern names is still a usable answer, unlike half a file.

use std::path::{Path, PathBuf};

use super::gates;

/// Most entries one `fs.glob` answers with.
pub(crate) const MAX_GLOB_ENTRIES: usize = 512;

/// How many directories one walk may hold and visit together.
///
/// A ceiling on the walk as a whole rather than on one side of it: what has been read plus what is
/// waiting to be read never exceeds it, so a single directory with a million children cannot grow the
/// queue past a number this module chose.
pub(crate) const MAX_GLOB_DIRS: usize = 256;

/// How deep the walk descends below the pattern's literal prefix.
///
/// The same ceiling [`gates::validate_scope_pattern`] already puts on a pattern's own segments
/// (`SCOPE_SEGMENTS_MAX`): a match can never need more levels than the pattern it is matched against
/// has, and the one pattern that could (`**`) is bounded here instead.
pub(crate) const MAX_GLOB_DEPTH: usize = 16;

/// A glob pattern split into the part that names a location and the part that matches under it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GlobPlan {
    /// The absolute prefix the pattern wrote, when the installation holds `fs.anyPath` and the
    /// pattern was absolute (`/`, or a drive root). Empty of meaning otherwise.
    pub(crate) prefix: Option<String>,
    /// The literal leading segments, as the caller wrote them; empty when the first segment already
    /// carries a wildcard, which means "start at the root".
    pub(crate) base: String,
    /// What each candidate below `base` is matched against, in the scope pattern language.
    pub(crate) pattern: String,
}

/// Splits one glob pattern, or answers `None` when it is not one this build reads.
///
/// `allow_absolute` is the caller's reading of `fs.anyPath`: a scoped installation resolves a
/// relative pattern against its roots, so an absolute one is a name it has no reading for, while an
/// unrestricted installation names any location it likes.
pub(crate) fn plan(pattern: &str, allow_absolute: bool) -> Option<GlobPlan> {
    let trimmed = pattern.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut prefix: Option<String> = None;
    let mut rest = trimmed;
    if allow_absolute {
        if let Some(tail) = trimmed.strip_prefix('/') {
            prefix = Some("/".to_owned());
            rest = tail;
        } else if let Some((drive, tail)) = split_drive(trimmed) {
            prefix = Some(format!("{drive}/"));
            rest = tail;
        }
    }
    if rest.is_empty() || !gates::validate_scope_pattern(rest) {
        return None;
    }
    let segments: Vec<&str> = rest.split('/').collect();
    // The literal prefix is what names the directory to walk; the *last* segment always stays in the
    // pattern even when it too is literal, so a pattern that names one file (`src/readme.md`) is a
    // match against that name rather than a walk of a directory it has to equal.
    let literal = segments
        .iter()
        .take_while(|segment| !segment.contains('*'))
        .count()
        .min(segments.len() - 1);
    Some(GlobPlan {
        prefix,
        base: segments[..literal].join("/"),
        pattern: segments[literal..].join("/"),
    })
}

/// `C:/…` split into its drive (`C:`) and the rest, when the text is a drive-qualified path.
///
/// The shape is checked rather than assumed: `split_once(':')` on any text would turn a relative
/// pattern into a drive, and the colon is exactly the character the scope language refuses.
fn split_drive(text: &str) -> Option<(String, &str)> {
    let (head, tail) = text.split_once('/')?;
    if head.len() == 2 {
        let mut characters = head.chars();
        if characters.next().is_some_and(|c| c.is_ascii_alphabetic())
            && characters.next() == Some(':')
        {
            return Some((head.to_owned(), tail));
        }
    }
    None
}

/// One entry a walk found: its path below the base, with `/` separators, and what is there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GlobHit {
    pub(crate) relative: String,
    pub(crate) directory: bool,
    pub(crate) size: u64,
    /// When the entry was last written, as the filesystem said it. The answer's spelling of that
    /// stamp - milliseconds since the epoch - belongs to the caller, so the walker hands over the
    /// platform's own value and the two answers that carry one cannot drift apart.
    pub(crate) modified: Option<std::time::SystemTime>,
}

/// Every entry below `base` that `pattern` names, and whether the walk stopped at a ceiling.
///
/// The walk is a depth-first descent bounded by the three ceilings above; the answer is *not* sorted
/// here (the caller sorts, and one order per answer is what the protocol promises), and a directory
/// the walk could not descend into is silently skipped - a directory this process may not read is not
/// an error a plugin can act on. `apply_reject_table` is the caller's reading of `fs.anyPath`, the
/// same fact the resolver in front of this walk was read with: an unrestricted installation is not
/// walked past the names the table covers either.
pub(crate) fn walk(
    base: &Path,
    pattern: &str,
    apply_reject_table: bool,
    out: &mut Vec<GlobHit>,
) -> bool {
    let mut dirs = 0usize;
    let mut truncated = false;
    let mut stack: Vec<(PathBuf, String, usize)> = vec![(base.to_path_buf(), String::new(), 0)];
    'walk: while let Some((directory, relative, depth)) = stack.pop() {
        dirs += 1;
        let Ok(listing) = std::fs::read_dir(&directory) else {
            continue;
        };
        // The listing is iterated rather than collected: a directory may hold any number of entries,
        // and holding them all to sort them would make the walk's memory the *filesystem's* size
        // rather than this module's ceilings. The answer is sorted once, at the end, which is what
        // the determinism promise needs; a directory's own order never reaches a caller.
        for child in listing.flatten() {
            let Ok(kind) = child.file_type() else {
                continue;
            };
            // A link is never followed and never reported: the containment gate above resolved the
            // base, and a link is the one entry that could put a target outside it.
            if kind.is_symlink() {
                continue;
            }
            let name = child.file_name().to_string_lossy().into_owned();
            let relative = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            if apply_reject_table && gates::is_rejected_path(&relative) {
                continue;
            }
            let is_directory = kind.is_dir();
            if gates::scope_matches(pattern, &relative) {
                if out.len() >= MAX_GLOB_ENTRIES {
                    truncated = true;
                    break 'walk;
                }
                let metadata = child.metadata().ok();
                out.push(GlobHit {
                    relative: relative.clone(),
                    directory: is_directory,
                    size: metadata.as_ref().map(std::fs::Metadata::len).unwrap_or(0),
                    modified: metadata
                        .as_ref()
                        .and_then(|metadata| metadata.modified().ok()),
                });
            }
            if is_directory {
                // The ceiling covers the walk as a whole - what it has visited plus what is
                // waiting - not just the visits, so a single directory with a million children
                // cannot grow the queue past it.
                if depth + 1 >= MAX_GLOB_DEPTH || dirs + stack.len() >= MAX_GLOB_DIRS {
                    truncated = true;
                } else {
                    stack.push((child.path(), relative, depth + 1));
                }
            }
        }
    }
    truncated
}

/// The path one hit is answered with: the caller's own prefix and base, then the hit's own path.
///
/// It reproduces the spelling the pattern used rather than the resolved one, so every answer can be
/// passed straight back to `fs.read` or `fs.stat` and resolve the same way.
pub(crate) fn join(plan: &GlobPlan, relative: &str) -> String {
    if let Some(prefix) = plan.prefix.as_deref() {
        // The prefix keeps its own trailing separator (`/`, `C:/`), so the relative part follows it
        // directly; the base, when there is one, is a path segment and needs the separator.
        return if plan.base.is_empty() {
            format!("{prefix}{relative}")
        } else {
            format!("{prefix}{}/{relative}", plan.base)
        };
    }
    if plan.base.is_empty() {
        relative.to_owned()
    } else {
        format!("{}/{relative}", plan.base)
    }
}

#[cfg(test)]
mod tests;
