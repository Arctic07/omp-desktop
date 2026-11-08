//! The system clipboard's file list: what it holds, and what a copy puts there.
//!
//! Windows publishes a copied file list as `CF_HDROP`. Nothing in the web layer can see it: a
//! pasted `File` carries a leaf name and bytes, never a path (measured in Chromium, and the reason
//! Electron ships `webUtils.getPathForFile`). Reading the list here is what lets a pasted file be
//! referenced where it lives instead of being copied into the attachment store, so an edit lands on
//! the user's file. Writing it is the same fact the other way round: a copied message carries its
//! images and files as files, not only as the labels a renderer can paint.
//!
//! Matching is deliberately conservative. A clipboard entry becomes the pasted file only when the
//! leaf name and the byte length both agree, and only when exactly one entry agrees: two entries
//! that both look like the pasted file prove nothing about which one the user copied, and a
//! mismatch means the clipboard moved on since the copy. Either way the caller keeps its bytes.

use std::path::{Path, PathBuf};

/// One file the renderer pasted: the leaf name it saw and how many bytes it read.
pub(crate) struct PastedFile {
    pub(crate) name: String,
    pub(crate) size: u64,
}

/// The file paths the clipboard holds, in clipboard order.
///
/// Empty when the clipboard holds no file list - text, an image, or any platform whose clipboard
/// this module does not read.
#[cfg(windows)]
pub(crate) fn file_list() -> Vec<PathBuf> {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    };
    use windows_sys::Win32::UI::Shell::{DragQueryFileW, HDROP};

    /// `CF_HDROP`: the shell's file list. Spelled here rather than imported so the constant does
    /// not tie this module to one `windows-sys` module layout.
    const CF_HDROP_FORMAT: u32 = 15;

    /// `DragQueryFileW` with this index asks for the entry count instead of a path.
    const DRAG_QUERY_FILE_COUNT: u32 = u32::MAX;

    let mut paths: Vec<PathBuf> = Vec::new();
    // SAFETY: every call below is a documented clipboard call with the arguments it requires; the
    // handle `GetClipboardData` returns is an `HDROP` the clipboard owns - the receiver must not
    // free it - and it is only used by `DragQueryFileW` before the clipboard is closed again.
    unsafe {
        if IsClipboardFormatAvailable(CF_HDROP_FORMAT) == 0 {
            return paths;
        }
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return paths;
        }
        let handle = GetClipboardData(CF_HDROP_FORMAT);
        if !handle.is_null() {
            let hdrop = handle as HDROP;
            let count = DragQueryFileW(hdrop, DRAG_QUERY_FILE_COUNT, std::ptr::null_mut(), 0);
            for index in 0..count {
                let length = DragQueryFileW(hdrop, index, std::ptr::null_mut(), 0);
                if length == 0 {
                    continue;
                }
                let mut buffer = vec![0u16; length as usize + 1];
                let written =
                    DragQueryFileW(hdrop, index, buffer.as_mut_ptr(), buffer.len() as u32);
                if written == 0 {
                    continue;
                }
                paths.push(PathBuf::from(String::from_utf16_lossy(
                    &buffer[..written as usize],
                )));
            }
        }
        CloseClipboard();
    }
    paths
}

/// No file list to read on this platform, so a paste stays bytes.
#[cfg(not(windows))]
pub(crate) fn file_list() -> Vec<PathBuf> {
    Vec::new()
}

/// Resolve each pasted file to the clipboard path that names the same file, when there is exactly
/// one. `None` means the paste keeps its bytes.
pub(crate) fn resolve_pasted(candidates: &[PathBuf], pasted: &[PastedFile]) -> Vec<Option<String>> {
    pasted
        .iter()
        .map(|file| {
            matched_candidate(candidates, file).map(|path| path.to_string_lossy().into_owned())
        })
        .collect()
}

/// The one clipboard entry that is the pasted file: same leaf name, same byte length, no twin.
fn matched_candidate<'a>(candidates: &'a [PathBuf], pasted: &PastedFile) -> Option<&'a PathBuf> {
    let mut matched: Option<&PathBuf> = None;
    for candidate in candidates {
        if !same_leaf_name(candidate, &pasted.name) {
            continue;
        }
        let Ok(metadata) = std::fs::metadata(candidate) else {
            continue;
        };
        if !metadata.is_file() || metadata.len() != pasted.size {
            continue;
        }
        if matched.is_some() {
            return None;
        }
        matched = Some(candidate);
    }
    matched
}

/// Whether the path's leaf is the pasted name. Windows paths have no case to speak of, so neither
/// does this comparison.
fn same_leaf_name(path: &Path, name: &str) -> bool {
    let Some(leaf) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    leaf.eq_ignore_ascii_case(name)
}

/// How much text this build will read from or write to the clipboard, in UTF-16 code units.
///
/// A clipboard is user state and can hold anything: the cap is what keeps one plugin call from
/// turning a paste of a hundred megabytes into this process's memory.
pub(crate) const TEXT_UNITS_MAX: usize = 1_048_576;

/// Whether this build reads and writes the system clipboard's text at all.
///
/// `false` on every platform but Windows, and it is stated rather than inferred from an empty
/// answer: a clipboard that holds no text and a platform this build cannot read are two different
/// facts, and the bridge answers the second one with `unsupported` instead of handing a plugin an
/// empty string it would take for an empty clipboard.
pub(crate) const fn text_supported() -> bool {
    cfg!(windows)
}

/// What one read of the clipboard's text found.
///
/// The failures are kept apart because they mean different things to the caller: a clipboard with no
/// text on it is an empty answer, one this process could not open (another process holds it - a
/// common, transient state) is a failure, and one holding more than [`TEXT_UNITS_MAX`] is a refusal
/// about size. Collapsing them into one "nothing" would hand a plugin an empty string for a clipboard
/// it never got to look at.
pub(crate) enum ClipboardText {
    Empty,
    Text(String),
    TooLarge,
    Unreadable,
}

/// The text the clipboard holds.
#[cfg(windows)]
pub(crate) fn text() -> ClipboardText {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    /// `CF_UNICODETEXT`: the clipboard's own text format. Spelled here rather than imported so the
    /// constant does not tie this module to one `windows-sys` module layout.
    const CF_UNICODETEXT_FORMAT: u32 = 13;

    // SAFETY: every call below is a documented clipboard call with the arguments it requires. The
    // handle `GetClipboardData` returns belongs to the clipboard (the receiver must not free it),
    // the block is locked only for the copy that reads it, and the slice is bounded by the size the
    // allocator reports rather than by the text's own terminator.
    unsafe {
        if IsClipboardFormatAvailable(CF_UNICODETEXT_FORMAT) == 0 {
            return ClipboardText::Empty;
        }
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return ClipboardText::Unreadable;
        }
        let handle = GetClipboardData(CF_UNICODETEXT_FORMAT);
        if handle.is_null() {
            CloseClipboard();
            return ClipboardText::Unreadable;
        }
        let size = GlobalSize(handle);
        if size / 2 > TEXT_UNITS_MAX {
            CloseClipboard();
            return ClipboardText::TooLarge;
        }
        if size < 2 {
            CloseClipboard();
            return ClipboardText::Empty;
        }
        let pointer = GlobalLock(handle);
        if pointer.is_null() {
            CloseClipboard();
            return ClipboardText::Unreadable;
        }
        let units = std::slice::from_raw_parts(pointer as *const u16, size / 2);
        let end = units
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(units.len());
        let text = String::from_utf16_lossy(&units[..end]);
        GlobalUnlock(handle);
        CloseClipboard();
        ClipboardText::Text(text)
    }
}

/// The text the clipboard holds; never called where [`text_supported`] is false, because the bridge
/// refuses those platforms before it asks.
#[cfg(not(windows))]
pub(crate) fn text() -> ClipboardText {
    ClipboardText::Unreadable
}

// Frees one global memory block. `windows-sys` 0.59 links every other global-memory call but this
// one, and the failure paths of the writers below are the only callers: leaking a block there would
// be a leak per refused write.
#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GlobalFree(handle: *mut core::ffi::c_void) -> *mut core::ffi::c_void;
}

/// How many files one copy may publish.
///
/// The same ceiling a paste may ask about (`commands::attachments`): a copy is one user gesture, and
/// the list is bounded so the gesture cannot turn into an unbounded allocation.
pub(crate) const COPIED_FILES_MAX: usize = 256;

/// One text block, or null when it cannot be allocated (or is past the size the clipboard takes).
///
/// The block is filled before any clipboard call, so a failed allocation leaves the user's
/// clipboard as it was rather than emptied.
#[cfg(windows)]
unsafe fn unicode_block(text: &str) -> *mut core::ffi::c_void {
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
    };

    let units: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    if units.len() > TEXT_UNITS_MAX {
        return std::ptr::null_mut();
    }
    let bytes = units.len() * 2;
    let block = GlobalAlloc(GMEM_MOVEABLE, bytes);
    if block.is_null() {
        return std::ptr::null_mut();
    }
    let pointer = GlobalLock(block);
    if pointer.is_null() {
        GlobalFree(block);
        return std::ptr::null_mut();
    }
    std::ptr::copy_nonoverlapping(units.as_ptr() as *const u8, pointer as *mut u8, bytes);
    GlobalUnlock(block);
    block
}

/// One `CF_HDROP` file list, as the bytes the clipboard block holds.
///
/// The list is the shell's structure: a `DROPFILES` header whose `fWide` says the paths are UTF-16,
/// then the paths one after another, each NUL-terminated, and the whole list NUL-terminated once
/// more. `pFiles` is the offset the paths begin at, which is the header's own size.
#[cfg(windows)]
fn hdrop_bytes(files: &[PathBuf]) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::DROPFILES;

    let header = std::mem::size_of::<DROPFILES>();
    let mut bytes = vec![0u8; header];
    let value = DROPFILES {
        pFiles: header as u32,
        pt: windows_sys::Win32::Foundation::POINT { x: 0, y: 0 },
        fNC: 0,
        fWide: 1,
    };
    // SAFETY: `bytes` is exactly one `DROPFILES` long, and the struct is written unaligned because
    // the vector's buffer carries no alignment promise beyond a byte.
    unsafe { std::ptr::write_unaligned(bytes.as_mut_ptr() as *mut DROPFILES, value) };
    for file in files {
        for unit in file.as_os_str().encode_wide() {
            bytes.extend_from_slice(&unit.to_ne_bytes());
        }
        bytes.extend_from_slice(&0u16.to_ne_bytes());
    }
    bytes.extend_from_slice(&0u16.to_ne_bytes());
    bytes
}

/// One global block holding a file list, or null when it cannot be allocated.
#[cfg(windows)]
unsafe fn hdrop_block(files: &[PathBuf]) -> *mut core::ffi::c_void {
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
    };

    let bytes = hdrop_bytes(files);
    let block = GlobalAlloc(GMEM_MOVEABLE, bytes.len());
    if block.is_null() {
        return std::ptr::null_mut();
    }
    let pointer = GlobalLock(block);
    if pointer.is_null() {
        GlobalFree(block);
        return std::ptr::null_mut();
    }
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer as *mut u8, bytes.len());
    GlobalUnlock(block);
    block
}

/// Replaces the clipboard with `text` and the given files, reporting whether everything went in.
///
/// Both formats are set in one open, so the text and the files cannot end up in two different
/// clipboard states; a block the clipboard did not take is freed here, because ownership moves to
/// the clipboard the moment `SetClipboardData` returns it.
#[cfg(windows)]
fn write_clipboard(text: &str, files: &[PathBuf]) -> bool {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };

    /// `CF_UNICODETEXT` (see [`text`]).
    const CF_UNICODETEXT_FORMAT: u32 = 13;
    /// `CF_HDROP`: the shell's file list. Spelled here rather than imported so the constant does
    /// not tie this module to one `windows-sys` module layout.
    const CF_HDROP_FORMAT: u32 = 15;

    // SAFETY: every block is allocated before the clipboard is touched, is locked only while it is
    // filled, and is either handed to the clipboard (which then owns it) or freed on the one path
    // where `SetClipboardData` refused it.
    unsafe {
        let text_block = unicode_block(text);
        if text_block.is_null() {
            return false;
        }
        let files_block = if files.is_empty() {
            std::ptr::null_mut()
        } else {
            hdrop_block(files)
        };
        if !files.is_empty() && files_block.is_null() {
            GlobalFree(text_block);
            return false;
        }
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            GlobalFree(text_block);
            if !files_block.is_null() {
                GlobalFree(files_block);
            }
            return false;
        }
        if EmptyClipboard() == 0 {
            GlobalFree(text_block);
            if !files_block.is_null() {
                GlobalFree(files_block);
            }
            CloseClipboard();
            return false;
        }
        let mut written = true;
        if SetClipboardData(CF_UNICODETEXT_FORMAT, text_block).is_null() {
            GlobalFree(text_block);
            written = false;
        }
        if !files_block.is_null() && SetClipboardData(CF_HDROP_FORMAT, files_block).is_null() {
            GlobalFree(files_block);
            written = false;
        }
        CloseClipboard();
        written
    }
}

/// The files among `requested` this build will publish.
///
/// The paths came from a message's own attachments, which were validated when they were imported;
/// a file can be gone by the time the reader copies that message, and a copy of the words should
/// still work then — so a path that is no longer an absolute regular file is left out rather than
/// failing the whole copy. The text still names it.
#[cfg(windows)]
fn copyable_files(requested: &[String]) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = Vec::new();
    for raw in requested.iter().take(COPIED_FILES_MAX) {
        let path = Path::new(raw.trim());
        if !path.is_absolute() {
            continue;
        }
        if std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file()) {
            files.push(path.to_path_buf());
        }
    }
    files
}

/// Replaces the clipboard with a copy's text and its files.
///
/// `false` only when the write itself failed; a file that no longer exists is not a failure (its
/// mention line in `text` still names it).
#[cfg(windows)]
pub(crate) fn copy_text_and_files(text: &str, requested: &[String]) -> bool {
    write_clipboard(text, &copyable_files(requested))
}

/// No platform but Windows can publish a file list from this build, so the command declines and the
/// caller writes the words through the web API — the same path a copy with no files takes.
#[cfg(not(windows))]
pub(crate) fn copy_text_and_files(_text: &str, _requested: &[String]) -> bool {
    false
}

/// Replaces the clipboard's text, reporting whether it was written.
#[cfg(windows)]
pub(crate) fn set_text(text: &str) -> bool {
    write_clipboard(text, &[])
}

/// Replaces the clipboard's text; always `false` where [`text_supported`] is false.
#[cfg(not(windows))]
pub(crate) fn set_text(_text: &str) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::{file_list, resolve_pasted, PastedFile};

    fn scratch(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("omp-clipboard-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("clipboard scratch");
        root
    }

    /// The list a copy publishes is the shell's own: a `DROPFILES` header that says the paths are
    /// wide, then the paths NUL-terminated one after another, then the list's own terminator.
    #[cfg(windows)]
    #[test]
    fn the_written_file_list_is_the_shell_structure() {
        use windows_sys::Win32::UI::Shell::DROPFILES;

        let root = scratch("hdrop");
        let first = root.join("one.txt");
        let second = root.join("two words.txt");
        fs::write(&first, "1").expect("first file");
        fs::write(&second, "2").expect("second file");

        let bytes = super::hdrop_bytes(&[first.clone(), second.clone()]);
        // SAFETY: the buffer starts with exactly one DROPFILES header.
        let header = unsafe { std::ptr::read_unaligned(bytes.as_ptr() as *const DROPFILES) };
        // The struct is packed, so its fields are copied before they are compared: a reference to
        // one would be an unaligned reference.
        let files_offset = header.pFiles as usize;
        let wide = header.fWide;
        assert_eq!(files_offset, std::mem::size_of::<DROPFILES>());
        assert_eq!(wide, 1, "the paths are wide");

        let units: Vec<u16> = bytes[std::mem::size_of::<DROPFILES>()..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_ne_bytes(*pair))
            .collect();
        assert_eq!(
            units.iter().rev().take(2).copied().collect::<Vec<_>>(),
            vec![0, 0]
        );
        let list = String::from_utf16(&units[..units.len() - 2]).expect("wide paths");
        assert_eq!(
            list,
            format!("{}\u{0}{}", first.display(), second.display()),
            "both paths, each terminated"
        );
        let _ = fs::remove_dir_all(&root);
    }

    /// A copy publishes the files that are still there: a path that is relative or gone is left out,
    /// and the words are copied regardless.
    #[cfg(windows)]
    #[test]
    fn only_absolute_existing_files_are_published() {
        let root = scratch("copyable");
        let file = root.join("kept.txt");
        fs::write(&file, "kept").expect("kept file");
        let requested = vec![
            file.to_string_lossy().into_owned(),
            root.join("gone.txt").to_string_lossy().into_owned(),
            "relative.txt".to_owned(),
            root.to_string_lossy().into_owned(),
        ];

        assert_eq!(super::copyable_files(&requested), vec![file]);
        let _ = fs::remove_dir_all(&root);
    }

    /// The write half against the real clipboard: the words and the one file both come back.
    ///
    /// Ignored because it replaces what the user has copied: run it when that does not matter. It
    /// puts the text and the file list it found back afterwards, in one write.
    #[cfg(windows)]
    #[test]
    #[ignore = "writes the real clipboard: run it when what is copied does not matter"]
    fn a_copy_publishes_its_text_and_files() {
        use super::ClipboardText;

        let before_text = match super::text() {
            ClipboardText::Text(text) => text,
            _ => String::new(),
        };
        let before_files: Vec<String> = super::file_list()
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        let root = scratch("publish");
        let file = root.join("published.txt");
        fs::write(&file, "published").expect("published file");

        assert!(super::copy_text_and_files(
            "hello",
            &[file.to_string_lossy().into_owned()],
        ));
        assert!(matches!(super::text(), ClipboardText::Text(text) if text == "hello"));
        assert_eq!(super::file_list(), vec![file.clone()]);

        // What the user had, put back: the text and the paths are one clipboard state.
        super::copy_text_and_files(&before_text, &before_files);
        let _ = fs::remove_dir_all(&root);
    }

    /// The clipboard's own entry is used when it names the same file the renderer pasted.
    #[test]
    fn the_single_entry_that_names_the_pasted_file_is_used() {
        let root = scratch("single");
        let file = root.join("notes.md");
        fs::write(&file, "hello\n").expect("clipboard target");
        let pasted = [PastedFile {
            name: "notes.md".to_owned(),
            size: 6,
        }];

        let resolved = resolve_pasted(std::slice::from_ref(&file), &pasted);

        assert_eq!(resolved, vec![Some(file.to_string_lossy().into_owned())]);
        let _ = fs::remove_dir_all(&root);
    }

    /// Two entries that both look like the pasted file prove nothing about which one was copied, so
    /// neither is used; and an entry whose bytes differ from the paste is a different file.
    #[test]
    fn an_ambiguous_or_mismatched_entry_resolves_nothing() {
        let root = scratch("ambiguous");
        let first = root.join("a").join("notes.md");
        let second = root.join("b").join("notes.md");
        fs::create_dir_all(first.parent().expect("dir")).expect("a");
        fs::create_dir_all(second.parent().expect("dir")).expect("b");
        fs::write(&first, "hello\n").expect("first");
        fs::write(&second, "hello\n").expect("second");
        let other = root.join("other.md");
        fs::write(&other, "hello, longer\n").expect("other");

        let pasted = |name: &str, size: u64| {
            vec![PastedFile {
                name: name.to_owned(),
                size,
            }]
        };
        let candidates = vec![first, second.clone(), other.clone()];

        assert_eq!(
            resolve_pasted(&candidates, &pasted("notes.md", 6)),
            vec![None]
        );
        assert_eq!(
            resolve_pasted(&candidates, &pasted("other.md", 6)),
            vec![None]
        );
        assert_eq!(
            resolve_pasted(std::slice::from_ref(&other), &pasted("other.md", 14)),
            vec![Some(other.to_string_lossy().into_owned())]
        );
        let _ = fs::remove_dir_all(&root);
    }

    /// Reads the real clipboard, so it only runs when asked. Set one file on the clipboard first
    /// (`Set-Clipboard -Path <file>` on Windows); with no file list it reports success without
    /// asserting anything, because a clipboard the user controls is not evidence about this code.
    #[test]
    #[ignore = "reads the real clipboard: put one file on it first"]
    fn the_clipboard_file_list_round_trips_through_the_matcher() {
        let list = file_list();
        if list.is_empty() {
            return;
        }
        let first = list[0].clone();
        let metadata = fs::metadata(&first).expect("clipboard entry is readable");
        let pasted = [PastedFile {
            name: first
                .file_name()
                .expect("entry has a leaf name")
                .to_string_lossy()
                .into_owned(),
            size: metadata.len(),
        }];
        assert_eq!(
            resolve_pasted(&list, &pasted),
            vec![Some(first.to_string_lossy().into_owned())]
        );
    }
}
