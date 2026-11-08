//! The window's own file drop, from the OS to the composer.
//!
//! A drag that starts in another application is an OLE drag on Windows, and the sources answer it
//! in two different ways:
//!
//! - Explorer and most native applications publish a *file list* (`CF_HDROP`), the format that
//!   carries absolute paths.
//! - Visual Studio Code, Cursor and the other Chromium-based editors never publish that list
//!   (microsoft/vscode#91132 is still open, and dragging a file out of their explorer is a feature
//!   request in #329709). Such a drag carries the paths as `text/plain`, next to private formats
//!   only another Chromium can read.
//!
//! Tauri's own handler (`wry`) reads `CF_HDROP` and nothing else, so a VS Code drag is answered
//! without a drop effect at all: the cursor shows a stop sign and nothing happens. `dragDropEnabled`
//! also makes Tauri switch WebView2's own drop handler off (`SetAllowExternalDrop(false)`), so the
//! page never sees an HTML5 `drop` as a second channel - the two are mutually exclusive on Windows.
//! Electron applications accept those drags because their Chromium reads the text
//! formats itself; this module does the same on the native side instead.
//!
//! What it does: it replaces wry's `IDropTarget` on the main webview's window handles with one that
//! reads the file list first and, when there is none, the `text/plain` paths a Chromium editor puts
//! there. The events it emits are the four Tauri events (`tauri://drag-enter` …) with the same
//! payload, so `src/state/desktop-drop.ts` needs no second contract.
//!
//! Ownership and bounds: one `IDropTarget` per window handle, created once when the window exists
//! and owned by the OLE registration for the life of the process (see `install`) - nothing here
//! grows per drag. Both readers are bounded: the file list is the shell's own, and the text read is
//! capped at [`platform::MAX_DRAG_TEXT_BYTES`].

/// Replaces the window's drop target on Windows.
///
/// Everywhere else Tauri's own handler already receives absolute paths from the platform, so there
/// is nothing to correct and this is a no-op.
#[cfg(not(windows))]
pub(crate) fn install(_app: &tauri::AppHandle) {}

#[cfg(windows)]
pub(crate) fn install(app: &tauri::AppHandle) {
    platform::install(app);
}

#[cfg(windows)]
mod platform {
    use std::{
        cell::UnsafeCell,
        ffi::c_void,
        path::{Path, PathBuf},
        ptr,
    };

    use serde::Serialize;
    use tauri::{AppHandle, Emitter, EventTarget, Manager};
    use windows::{
        core::{implement, Ref, BOOL},
        Win32::{
            Foundation::{HWND, LPARAM, POINT, POINTL},
            Graphics::Gdi::ScreenToClient,
            System::{
                Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL},
                Memory::{GlobalLock, GlobalSize, GlobalUnlock},
                Ole::{
                    IDropTarget, IDropTarget_Impl, RegisterDragDrop, ReleaseStgMedium,
                    RevokeDragDrop, CF_HDROP, CF_UNICODETEXT, DROPEFFECT, DROPEFFECT_COPY,
                    DROPEFFECT_NONE,
                },
                SystemServices::MODIFIERKEYS_FLAGS,
            },
            UI::{
                Shell::{DragQueryFileW, HDROP},
                WindowsAndMessaging::EnumChildWindows,
            },
        },
    };

    use crate::services::{log, presence};

    /// The four events Tauri emits for its own drag-and-drop channel. Reused verbatim so the front
    /// end's `onDragDropEvent` subscription stays the one contract for a dropped file.
    const DRAG_ENTER: &str = "tauri://drag-enter";
    const DRAG_OVER: &str = "tauri://drag-over";
    const DRAG_DROP: &str = "tauri://drag-drop";
    const DRAG_LEAVE: &str = "tauri://drag-leave";

    /// Ceiling on the `text/plain` payload a drag may hand us. A file mention is a handful of paths;
    /// anything past this is not one, and is refused rather than copied into the process.
    pub(super) const MAX_DRAG_TEXT_BYTES: usize = 1 << 20;

    /// `DragQueryFileW` asks for the entry count with this index and for one path's length otherwise.
    const DRAG_QUERY_FILE_COUNT: u32 = u32::MAX;

    /// How many lines of a drag's text may be looked at. A file drop is a handful of paths; a code
    /// selection of a megabyte is not one, and its lines are not worth a file-system call each.
    const MAX_DRAG_LINES: usize = 64;

    #[derive(Clone, Serialize)]
    struct DragPoint {
        x: f64,
        y: f64,
    }

    /// The payload Tauri's own drag events carry: `paths` is present on enter and drop only, and
    /// `position` is in physical pixels of the window the drop arrived on.
    #[derive(Clone, Serialize)]
    struct DragPayload<'a> {
        #[serde(skip_serializing_if = "Option::is_none")]
        paths: Option<&'a [PathBuf]>,
        position: DragPoint,
    }

    /// The drop target of one window handle.
    ///
    /// The two cells are written from `&self` because OLE hands a target only a shared reference;
    /// every method here runs on the window's own thread inside the drag loop, so no two calls can
    /// overlap and the cells need no further synchronization.
    #[implement(IDropTarget)]
    struct WindowDropTarget {
        hwnd: HWND,
        app: AppHandle,
        label: String,
        /// What the drag currently over this window offers; empty when it offers no file.
        offered: UnsafeCell<Vec<PathBuf>>,
        /// What the cursor shows: copy while a usable drag is over the window, none otherwise.
        effect: UnsafeCell<DROPEFFECT>,
    }

    impl WindowDropTarget {
        fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) {
            if let Err(error) =
                self.app
                    .emit_to(EventTarget::labeled(self.label.as_str()), event, payload)
            {
                log::warn(&format!("a drag event could not reach the window: {error}"));
            }
        }

        /// Emit a drag event for the drag this handle is currently offering, if any.
        fn emit_offered(&self, event: &str, point: DragPoint) {
            let offered = unsafe { &*self.offered.get() };
            if offered.is_empty() {
                return;
            }
            self.emit(
                event,
                DragPayload {
                    paths: Some(offered),
                    position: point,
                },
            );
        }
    }

    #[allow(non_snake_case)]
    impl IDropTarget_Impl for WindowDropTarget_Impl {
        fn DragEnter(
            &self,
            pDataObj: Ref<'_, IDataObject>,
            _grfKeyState: MODIFIERKEYS_FLAGS,
            pt: &POINTL,
            pdwEffect: *mut DROPEFFECT,
        ) -> windows::core::Result<()> {
            let point = client_point(self.hwnd, pt);
            let paths = pDataObj
                .as_ref()
                .map(offered_paths)
                .filter(|paths| !paths.is_empty());
            let effect = if paths.is_some() {
                DROPEFFECT_COPY
            } else {
                DROPEFFECT_NONE
            };
            unsafe {
                *self.offered.get() = paths.unwrap_or_default();
                *self.effect.get() = effect;
                *pdwEffect = effect;
            }
            self.emit_offered(DRAG_ENTER, point);
            Ok(())
        }

        fn DragOver(
            &self,
            _grfKeyState: MODIFIERKEYS_FLAGS,
            pt: &POINTL,
            pdwEffect: *mut DROPEFFECT,
        ) -> windows::core::Result<()> {
            let point = client_point(self.hwnd, pt);
            self.emit_offered(DRAG_OVER, point);
            unsafe { *pdwEffect = *self.effect.get() };
            Ok(())
        }

        fn DragLeave(&self) -> windows::core::Result<()> {
            let dragging = !unsafe { &*self.offered.get() }.is_empty();
            unsafe { std::mem::take(&mut *self.offered.get()) };
            if dragging {
                self.emit(DRAG_LEAVE, ());
            }
            Ok(())
        }

        fn Drop(
            &self,
            _pDataObj: Ref<'_, IDataObject>,
            _grfKeyState: MODIFIERKEYS_FLAGS,
            pt: &POINTL,
            pdwEffect: *mut DROPEFFECT,
        ) -> windows::core::Result<()> {
            let point = client_point(self.hwnd, pt);
            // The paths were read once, on enter: the data object's own list is gone by the time the
            // button comes up for some sources, and the drag must not read twice for the same drop.
            let paths = unsafe { std::mem::take(&mut *self.offered.get()) };
            if !paths.is_empty() {
                self.emit(
                    DRAG_DROP,
                    DragPayload {
                        paths: Some(&paths),
                        position: point,
                    },
                );
            }
            unsafe { *pdwEffect = *self.effect.get() };
            Ok(())
        }
    }

    /// Where the pointer is, in the client coordinates of the window the drop arrived on.
    fn client_point(hwnd: HWND, pt: &POINTL) -> DragPoint {
        let mut point = POINT { x: pt.x, y: pt.y };
        let _ = unsafe { ScreenToClient(hwnd, &mut point) };
        DragPoint {
            x: point.x as f64,
            y: point.y as f64,
        }
    }

    /// The paths a drag object offers, in the order a user would name them.
    ///
    /// `CF_HDROP` wins whenever the source publishes it: it is the shell's own list and it is what
    /// a directory drop arrives in, which the composer reports as a skipped entry rather than as
    /// nothing. The text fallback is only for sources that publish no list at all.
    fn offered_paths(data: &IDataObject) -> Vec<PathBuf> {
        if let Some(paths) = hdrop_paths(data) {
            return paths;
        }
        match unicode_text(data) {
            Some(text) => file_paths_in_text(&text),
            None => Vec::new(),
        }
    }

    fn format_of(cf_format: u16) -> FORMATETC {
        FORMATETC {
            cfFormat: cf_format,
            ptd: ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        }
    }

    /// The file list, when the drag carries one. `None` means this drag has no `CF_HDROP`, so the
    /// caller may look at the text formats; `Some(vec![])` means it has one that is empty.
    fn hdrop_paths(data: &IDataObject) -> Option<Vec<PathBuf>> {
        let format = format_of(CF_HDROP.0);
        // SAFETY: `GetData` is asked for the one format described above; the medium it fills is
        // released exactly once, after the paths have been copied out of it.
        let mut medium = unsafe { data.GetData(&format) }.ok()?;
        let hdrop = HDROP(unsafe { medium.u.hGlobal.0 });
        let mut paths = Vec::new();
        let count = unsafe { DragQueryFileW(hdrop, DRAG_QUERY_FILE_COUNT, None) };
        for index in 0..count {
            let length = unsafe { DragQueryFileW(hdrop, index, None) } as usize;
            if length == 0 {
                continue;
            }
            let mut buffer = vec![0u16; length + 1];
            let written = unsafe { DragQueryFileW(hdrop, index, Some(&mut buffer)) } as usize;
            if written == 0 {
                continue;
            }
            paths.push(PathBuf::from(String::from_utf16_lossy(&buffer[..written])));
        }
        unsafe { ReleaseStgMedium(&mut medium) };
        Some(paths)
    }

    /// The drag's `text/plain`, which is where a Chromium editor puts the paths of what is being
    /// dragged. `None` when the drag carries no text at all.
    fn unicode_text(data: &IDataObject) -> Option<String> {
        let format = format_of(CF_UNICODETEXT.0);
        // SAFETY: as in `hdrop_paths`, the medium is released once after its bytes are copied.
        let mut medium = unsafe { data.GetData(&format) }.ok()?;
        let handle = unsafe { medium.u.hGlobal };
        let mut units: Vec<u16> = Vec::new();
        unsafe {
            let pointer = GlobalLock(handle) as *const u16;
            if !pointer.is_null() {
                let bytes = GlobalSize(handle).min(MAX_DRAG_TEXT_BYTES);
                let capacity = bytes / 2;
                let mut length = 0;
                while length < capacity && *pointer.add(length) != 0 {
                    length += 1;
                }
                units = std::slice::from_raw_parts(pointer, length).to_vec();
                let _ = GlobalUnlock(handle);
            }
            ReleaseStgMedium(&mut medium);
        }
        if units.is_empty() {
            None
        } else {
            Some(String::from_utf16_lossy(&units))
        }
    }

    /// The paths in a drag's text, keeping only lines that name a file that exists.
    ///
    /// A Chromium editor joins the paths of a multi-selection with the platform's line separator
    /// and leaves everything else alone: dragging a code selection puts that code here instead, and
    /// a relative line or a bare word is not a file path. Keeping only existing absolute files is
    /// what tells the two apart without trusting the source.
    fn file_paths_in_text(text: &str) -> Vec<PathBuf> {
        let mut candidates = 0;
        let mut paths = Vec::new();
        for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
            candidates += 1;
            // Refused whole rather than read in part: a list this long is not a file drag, and
            // importing the first [`MAX_DRAG_LINES`] of it would be a lie about what was dropped.
            if candidates > MAX_DRAG_LINES {
                return Vec::new();
            }
            if let Some(path) = file_path_of(line) {
                paths.push(path);
            }
        }
        paths
    }

    fn file_path_of(line: &str) -> Option<PathBuf> {
        let direct = Path::new(line);
        if direct.is_absolute() && direct.is_file() {
            return Some(direct.to_path_buf());
        }
        // A drag that starts in an editor names where it started: `C:\work\x.ts:12:3`. The selection
        // is not part of the file, so the path is retried without it.
        let candidate = Path::new(strip_selection(line)?);
        (candidate.is_absolute() && candidate.is_file()).then(|| candidate.to_path_buf())
    }

    /// `C:\work\x.ts:12:3` → `C:\work\x.ts`. `None` when the line has no trailing `:line[:column]`.
    fn strip_selection(line: &str) -> Option<&str> {
        let (path, stripped) = strip_one_suffix(line);
        if !stripped {
            return None;
        }
        // Two suffixes at most: `:line:column`. A third would be somebody else's format.
        Some(strip_one_suffix(path).0)
    }

    /// The line without one trailing `:digits`, and whether there was one to take.
    fn strip_one_suffix(value: &str) -> (&str, bool) {
        let Some(colon) = value.rfind(':') else {
            return (value, false);
        };
        // A drive letter's colon (`C:`) is part of the path, and an empty suffix is no selection.
        if colon < 2 || colon + 1 == value.len() {
            return (value, false);
        }
        if !value[colon + 1..].bytes().all(|byte| byte.is_ascii_digit()) {
            return (value, false);
        }
        (&value[..colon], true)
    }

    /// Put our target on the window handles of the main webview.
    pub(super) fn install(app: &AppHandle) {
        let Some(window) = app.get_webview_window(presence::MAIN_WINDOW) else {
            log::warn("the window's file drop was not installed: the main window is not there");
            return;
        };
        let label = window.label().to_string();
        let app = app.clone();
        let attached = window.with_webview(move |platform| {
            let controller = platform.controller();
            let mut root = HWND::default();
            // SAFETY: the controller is alive for the life of the webview, and the call only reads
            // the parent handle wry created the controller with.
            if let Err(error) = unsafe { controller.ParentWindow(&mut root) } {
                log::warn(&format!(
                    "the window's file drop was not installed: its webview handle is unavailable ({error})"
                ));
                return;
            }
            let handles = register_tree(root, app, label);
            log::info(&format!(
                "the window's file drop target replaced Tauri's on {handles} window handle(s)"
            ));
        });
        if let Err(error) = attached {
            log::warn(&format!(
                "the window's file drop was not installed: {error}"
            ));
        }
    }

    /// Replace the drop target of every window handle under `root`.
    ///
    /// This mirrors where wry put its own target: OLE delivers a drag to the handle under the
    /// pointer, so every descendant of the webview's container has to answer. Each target is owned
    /// by its registration for the life of the process - the window these serve is the main one,
    /// which a run does not recreate.
    fn register_tree(root: HWND, app: AppHandle, label: String) -> usize {
        let mut handles = 0;
        let mut enumerate = |hwnd: HWND| {
            if register(hwnd, &app, &label) {
                handles += 1;
            }
            true
        };
        let mut callback_object: &mut dyn FnMut(HWND) -> bool = &mut enumerate;
        // SAFETY: the pointer only has to outlive the `EnumChildWindows` call below, and the
        // closure stays alive in this frame until it returns. The trampoline casts the parameter
        // back to exactly the type it was given.
        let parameter = LPARAM(
            &mut callback_object as *mut &mut dyn FnMut(HWND) -> bool as *mut c_void as isize,
        );
        unsafe extern "system" fn callback(hwnd: HWND, parameter: LPARAM) -> BOOL {
            let callback_object =
                &mut *(parameter.0 as *mut c_void as *mut &mut dyn FnMut(HWND) -> bool);
            (*callback_object)(hwnd).into()
        }
        let _ = unsafe { EnumChildWindows(Some(root), Some(callback), parameter) };
        handles
    }

    /// Answers whether the handle now carries the target.
    fn register(hwnd: HWND, app: &AppHandle, label: &str) -> bool {
        let target: IDropTarget = WindowDropTarget {
            hwnd,
            app: app.clone(),
            label: label.to_string(),
            offered: UnsafeCell::new(Vec::new()),
            effect: UnsafeCell::new(DROPEFFECT_NONE),
        }
        .into();
        // SAFETY: `RevokeDragDrop` only reports whether anything was registered, and the handle is
        // one of this webview's own. The target has to outlive its registration: OLE holds the
        // pointer without taking a reference, so it is handed over rather than dropped here.
        unsafe {
            let _ = RevokeDragDrop(hwnd);
            match RegisterDragDrop(hwnd, &target) {
                Ok(()) => {
                    std::mem::forget(target);
                    true
                }
                Err(error) => {
                    log::warn(&format!(
                        "a window handle could not take the file drop target: {error}"
                    ));
                    false
                }
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{
            fs,
            sync::atomic::{AtomicU32, Ordering},
        };

        static SEQUENCE: AtomicU32 = AtomicU32::new(0);

        /// A directory of real files, removed when the test that made it ends.
        struct Scratch {
            directory: PathBuf,
        }

        impl Scratch {
            fn new() -> Self {
                let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
                let directory = std::env::temp_dir()
                    .join(format!("omp-drop-{}-{sequence}", std::process::id()));
                fs::create_dir_all(&directory).expect("the scratch directory could be created");
                Self { directory }
            }

            fn file(&self, name: &str) -> PathBuf {
                let path = self.directory.join(name);
                fs::write(&path, "x").expect("the staged file could be written");
                path
            }
        }

        impl Drop for Scratch {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.directory);
            }
        }

        #[test]
        fn a_dragged_path_list_is_read_line_by_line() {
            let scratch = Scratch::new();
            let first = scratch.file("a.ts");
            let second = scratch.file("b b.ts");
            let text = format!("{}\r\n{}\r\n", first.display(), second.display());
            assert_eq!(file_paths_in_text(&text), vec![first, second]);
        }

        #[test]
        fn a_selection_suffix_is_not_part_of_the_path() {
            let scratch = Scratch::new();
            let file = scratch.file("c.ts");
            let text = format!("{}:12:3", file.display());
            assert_eq!(file_paths_in_text(&text), vec![file]);
        }

        #[test]
        fn text_that_is_not_a_file_path_is_refused() {
            let scratch = Scratch::new();
            let staged = scratch.file("d.ts");
            let text = format!(
                "const value = 1\r\n{}\r\nC:\\definitely\\missing\\file.ts\r\nnotes.txt",
                staged.display()
            );
            assert_eq!(file_paths_in_text(&text), vec![staged]);
        }

        #[test]
        fn a_bare_drive_letter_is_not_a_selection() {
            assert_eq!(strip_selection("C:\\work\\x.ts"), None);
            assert_eq!(strip_selection("C:\\work\\x.ts:9"), Some("C:\\work\\x.ts"));
            assert_eq!(
                strip_selection("C:\\work\\x.ts:9:2"),
                Some("C:\\work\\x.ts")
            );
        }

        #[test]
        fn a_text_with_more_lines_than_a_drop_can_name_is_refused() {
            let scratch = Scratch::new();
            let lines: Vec<String> = (0..=MAX_DRAG_LINES)
                .map(|index| scratch.file(&format!("f{index}.ts")).display().to_string())
                .collect();
            assert!(file_paths_in_text(&lines.join("\r\n")).is_empty());
        }

        #[test]
        fn a_relative_line_names_no_file() {
            assert_eq!(file_path_of("12:3"), None);
            assert!(file_paths_in_text("12:3").is_empty());
        }
    }
}
