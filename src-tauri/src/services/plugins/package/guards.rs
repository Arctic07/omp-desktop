//! The guards a package file has to pass: the bounds on what it may contain, the path check every
//! entry runs before it is written, and the optional checksum list beside the manifest.
//!
//! These are the rules that make unpacking an attacker-supplied archive safe rather than merely
//! possible, so they live on their own and are tested on their own (`tests` below): an entry's path
//! is refused unless it is a plain relative path (no absolute path, no `..`, no separator the zip
//! format does not use, no Windows-reserved name), link entries are refused, the archive is bounded
//! before it is read, the unpacked bytes are bounded as they are written, and a `checksums.json`
//! that does not match the files it lists is a refusal rather than a warning.
//!
//! Nothing here knows what a plugin is; `package.rs` is what turns a guarded archive into something
//! the engine can install.

use std::fs::File;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// Ceiling on the archive file itself, before a byte of it is read.
pub(crate) const MAX_ARCHIVE_BYTES: u64 = 50 * 1024 * 1024;
/// Ceiling on everything the archive unpacks to (spec §2.3): the bound the copy loop enforces.
pub(crate) const MAX_UNPACKED_BYTES: u64 = 50 * 1024 * 1024;
/// Ceiling on the number of entries (spec §2.3).
pub(crate) const MAX_ENTRIES: usize = 2000;

/// Why a package file could not be turned into something installable. Every refusal is this
/// application's own judgement of the file, and every one of them reaches the frontend as
/// `PLUGIN_PACKAGE_INVALID`.
#[derive(Debug)]
pub(crate) struct PackageRefusal {
    pub(crate) message: String,
}

impl PackageRefusal {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

/// A refusal message as the caller reads it: one line, bounded.
///
/// The sentences below quote what the archive and the filesystem said - an entry name the archive
/// chose, an OS error naming a path - and both are attacker-controlled text reaching a user-facing
/// message. Quoting them is useful (an entry name is exactly what tells a user which file to fix),
/// so they are trimmed to one bounded line rather than dropped.
pub(crate) fn quoted(text: &str) -> String {
    let one_line: String = text
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect();
    let trimmed = one_line.trim();
    if trimmed.chars().count() <= QUOTE_MAX {
        return trimmed.to_owned();
    }
    let mut clipped: String = trimmed.chars().take(QUOTE_MAX).collect();
    clipped.push('…');
    clipped
}

/// How much of one quoted fragment a refusal keeps.
const QUOTE_MAX: usize = 120;

/// An IO failure as a refusal, with the sentence the user reads.
pub(crate) fn io_refusal(context: &'static str) -> impl Fn(io::Error) -> PackageRefusal {
    move |error| PackageRefusal::new(format!("{context}: {}", quoted(&error.to_string())))
}

/// One entry's path, refused unless it is a plain relative path inside the staging directory.
///
/// The checks are spelled out rather than delegated: a zip entry name is attacker-controlled text,
/// and both the separators and the reserved device names differ between the platforms this
/// application runs on. `.` and `..` are refused outright, backslashes are refused because the zip
/// format spells separators as `/`, `:` is refused because a Windows path can start a drive with
/// it, and the reserved names are refused because a file called `NUL` or `CON` cannot be created on
/// Windows at all.
pub(crate) fn safe_relative(raw: &str) -> Result<PathBuf, PackageRefusal> {
    if raw.is_empty() {
        return Err(PackageRefusal::new(
            "The package contains an entry with an empty name.",
        ));
    }
    if raw.contains('\\') {
        return Err(PackageRefusal::new(format!(
            "A package entry name uses a backslash separator and was refused: {}",
            quoted(raw)
        )));
    }
    // A leading separator is refused rather than trimmed: the entry names an absolute path, and
    // rewriting it into a relative one would silently install something the archive did not
    // describe.
    if raw.starts_with('/') {
        return Err(PackageRefusal::new(format!(
            "A package entry names an absolute path and was refused: {}",
            quoted(raw)
        )));
    }
    let mut path = PathBuf::new();
    for part in raw.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(PackageRefusal::new(format!(
                "A package entry escapes the extraction directory and was refused: {}",
                quoted(raw)
            )));
        }
        if part.contains(':') || part.chars().any(char::is_control) {
            return Err(PackageRefusal::new(format!(
                "A package entry name contains a character this platform refuses: {}",
                quoted(raw)
            )));
        }
        if is_reserved_name(part) {
            return Err(PackageRefusal::new(format!(
                "A package entry name is reserved by the system and was refused: {}",
                quoted(raw)
            )));
        }
        path.push(part);
    }
    if path.as_os_str().is_empty() {
        return Err(PackageRefusal::new(format!(
            "A package entry names no file: {}",
            quoted(raw)
        )));
    }
    // Belt and braces: whatever the loop built has to be plain, relative components.
    if !path
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(PackageRefusal::new(format!(
            "A package entry path is not a plain relative path and was refused: {}",
            quoted(raw)
        )));
    }
    Ok(path)
}

/// Whether one path component is a name Windows cannot create, with or without a suffix.
fn is_reserved_name(part: &str) -> bool {
    let stem = part.split('.').next().unwrap_or(part).to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem
            .strip_prefix("COM")
            .is_some_and(|rest| matches!(rest, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"))
        || stem
            .strip_prefix("LPT")
            .is_some_and(|rest| matches!(rest, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"))
}

/// Copies one entry with the unpacked-size budget as a hard limit, answering the new total.
///
/// The declared size in an entry's header is not trusted for this: the budget is enforced against
/// the bytes that are actually read, so an archive that lies about its sizes still cannot fill the
/// disk.
pub(crate) fn copy_bounded(
    entry: &mut impl Read,
    out: &mut impl Write,
    written: u64,
) -> Result<u64, PackageRefusal> {
    let mut total = written;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = entry.read(&mut buffer).map_err(|error| {
            PackageRefusal::new(format!("A package entry could not be extracted: {error}"))
        })?;
        if read == 0 {
            return Ok(total);
        }
        total += read as u64;
        if total > MAX_UNPACKED_BYTES {
            return Err(PackageRefusal::new(format!(
                "The extracted size is above the {} MB limit.",
                MAX_UNPACKED_BYTES / (1024 * 1024)
            )));
        }
        out.write_all(&buffer[..read])
            .map_err(io_refusal("Could not write an extracted file"))?;
    }
}

/// The sha256 of one file, as lowercase hex.
pub(crate) fn digest_of(path: &Path) -> Result<String, PackageRefusal> {
    let mut file = File::open(path).map_err(io_refusal("Could not open a file"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(io_refusal("Could not read a file"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// The checksum list beside a manifest, when the package ships one: path → expected digest.
///
/// `Ok(None)` means the package declares no checksums at all, which a local import is allowed to do.
/// A file that exists but cannot be read as that mapping is a refusal, because a list that cannot be
/// read is not the same thing as no list - and both callers below need to tell those apart.
fn checksum_mapping(package_dir: &Path) -> Result<Option<Map<String, Value>>, PackageRefusal> {
    let path = package_dir.join("checksums.json");
    if !path.is_file() {
        return Ok(None);
    }
    let text =
        std::fs::read_to_string(&path).map_err(io_refusal("Could not read checksums.json"))?;
    let value: Value = serde_json::from_str(&text).map_err(|error| {
        PackageRefusal::new(format!("checksums.json is not valid JSON: {error}"))
    })?;
    let mapping = match value.get("files") {
        Some(Value::Object(files)) => files.clone(),
        _ => match value {
            Value::Object(files) => files,
            _ => {
                return Err(PackageRefusal::new(
                    "checksums.json must be an object mapping paths to sha256 digests.",
                ))
            }
        },
    };
    if mapping.is_empty() {
        return Err(PackageRefusal::new("checksums.json lists no files."));
    }
    Ok(Some(mapping))
}

/// One digest as the list declares it: 64 hex digits, lowercased, or nothing.
fn declared_digest(expected: &Value) -> Option<String> {
    expected
        .as_str()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .filter(|digest| digest.len() == 64 && digest.chars().all(|c| c.is_ascii_hexdigit()))
}

/// Verifies the optional `checksums.json` beside the manifest: every listed file, by `sha256`.
///
/// The file is written by whoever built the package, so a mismatch means the package is not the one
/// its author published - which is the one thing a checksum list is for, and a reason to refuse
/// rather than to warn. Two shapes are accepted, because both are in use: `{ "files": { … } }`, and
/// a bare mapping of path to digest. Every path is resolved with the same guard the unpacking uses,
/// so a list cannot point outside the package.
pub(crate) fn verify_checksums(package_dir: &Path) -> Result<(), PackageRefusal> {
    let Some(mapping) = checksum_mapping(package_dir)? else {
        return Ok(());
    };
    for (raw_path, expected) in mapping {
        let expected = declared_digest(&expected).ok_or_else(|| {
            PackageRefusal::new(format!(
                "checksums.json declares an invalid sha256 for {}.",
                quoted(&raw_path)
            ))
        })?;
        let relative = safe_relative(&raw_path)?;
        let file = package_dir.join(&relative);
        if !file.is_file() {
            return Err(PackageRefusal::new(format!(
                "checksums.json lists a file that is not in the package: {}",
                quoted(&raw_path)
            )));
        }
        if digest_of(&file)? != expected {
            return Err(PackageRefusal::new(format!(
                "Checksum mismatch: the actual sha256 of {} differs from checksums.json.",
                quoted(&raw_path)
            )));
        }
    }
    Ok(())
}

/// The checksum list's own facts, as the preview reports them: whether every file it lists is present
/// and hashes to the digest it declares, and how many files it covers.
///
/// This never refuses. [`verify_checksums`] is what decides whether a package may be installed, while
/// this answers the question a user reads *before* installing - so a package that ships no list, or
/// one this build cannot read as a list at all, is reported as unverified with nothing listed, which
/// is the honest state of a local import rather than an error the card would have to explain.
pub(crate) fn checksum_facts(package_dir: &Path) -> ChecksumFacts {
    let Ok(Some(mapping)) = checksum_mapping(package_dir) else {
        return ChecksumFacts {
            verified: false,
            count: 0,
        };
    };
    let count = mapping.len();
    let verified = mapping.iter().all(|(raw_path, expected)| {
        let Some(expected) = declared_digest(expected) else {
            return false;
        };
        let Ok(relative) = safe_relative(raw_path) else {
            return false;
        };
        let file = package_dir.join(&relative);
        file.is_file()
            && digest_of(&file)
                .map(|digest| digest == expected)
                .unwrap_or(false)
    });
    ChecksumFacts {
        verified: count > 0 && verified,
        count,
    }
}

/// The checksum list's own facts (see [`checksum_facts`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ChecksumFacts {
    /// Every listed file is present and hashes to the digest it declares.
    pub(crate) verified: bool,
    /// How many files the list covers; `0` when the package ships no usable list.
    pub(crate) count: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A path that climbs out of the staging directory, or spells its separators the way the zip
    /// format does not, is refused before any file is created.
    #[test]
    fn an_entry_path_is_refused_unless_it_is_a_plain_relative_path() {
        assert_eq!(
            safe_relative("skills/one.md").expect("plain"),
            PathBuf::from("skills").join("one.md")
        );
        assert_eq!(
            safe_relative("./index.js").expect("dot is skipped"),
            PathBuf::from("index.js")
        );

        for refused in [
            "../escaped.txt",
            "skills/../../escaped.txt",
            "/absolute.txt",
            "C:/windows.txt",
            "..\\escaped.txt",
            "nested\\windows.txt",
            "CON",
            "lpt1.txt",
            "",
        ] {
            assert!(
                safe_relative(refused).is_err(),
                "expected a refusal for {refused:?}"
            );
        }
    }

    /// The unpacked-size budget counts the bytes that were read, so an archive whose header claims a
    /// small size cannot get past it.
    #[test]
    fn the_unpacked_size_budget_is_enforced_while_copying() {
        let mut source = std::io::Cursor::new(vec![b'x'; (MAX_UNPACKED_BYTES + 1) as usize]);
        let mut sink: Vec<u8> = Vec::new();
        let refusal = copy_bounded(&mut source, &mut sink, 0).expect_err("refused");
        assert!(refusal.message.contains("above the"), "{}", refusal.message);

        let mut small = std::io::Cursor::new(b"hello".to_vec());
        let mut sink: Vec<u8> = Vec::new();
        assert_eq!(copy_bounded(&mut small, &mut sink, 0).expect("copied"), 5);
    }

    /// A checksum list is verified file by file: a mismatch, a digest that is not one, and a path
    /// the package does not hold are all refusals.
    #[test]
    fn a_checksum_list_is_verified_file_by_file() {
        let root = std::env::temp_dir().join(format!("omp-package-guards-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("root");
        std::fs::write(root.join("index.js"), "export default function () {}\n").expect("module");
        let digest = digest_of(&root.join("index.js")).expect("digest");

        assert!(verify_checksums(&root).is_ok(), "no list is not a refusal");

        std::fs::write(
            root.join("checksums.json"),
            format!("{{ \"files\": {{ \"index.js\": \"{digest}\" }} }}\n"),
        )
        .expect("list");
        assert!(verify_checksums(&root).is_ok());

        std::fs::write(
            root.join("checksums.json"),
            format!(
                "{{ \"files\": {{ \"index.js\": \"{}\" }} }}\n",
                "0".repeat(64)
            ),
        )
        .expect("list");
        let refusal = verify_checksums(&root).expect_err("refused");
        assert!(
            refusal.message.contains("Checksum mismatch"),
            "{}",
            refusal.message
        );

        std::fs::write(
            root.join("checksums.json"),
            format!("{{ \"index.js\": \"{digest}\", \"gone.js\": \"{digest}\" }}\n"),
        )
        .expect("list");
        let refusal = verify_checksums(&root).expect_err("refused");
        assert!(
            refusal.message.contains("not in the package"),
            "{}",
            refusal.message
        );

        std::fs::write(
            root.join("checksums.json"),
            "{ \"index.js\": \"not-a-digest\" }\n",
        )
        .expect("list");
        let refusal = verify_checksums(&root).expect_err("refused");
        assert!(
            refusal.message.contains("invalid sha256"),
            "{}",
            refusal.message
        );

        // A list that points outside the package is refused by the same guard the unpacker uses.
        std::fs::write(
            root.join("checksums.json"),
            format!("{{ \"../outside.js\": \"{digest}\" }}\n"),
        )
        .expect("list");
        assert!(verify_checksums(&root).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
