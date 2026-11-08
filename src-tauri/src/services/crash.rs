//! What this process leaves behind when it dies of a native fault.
//!
//! A Rust panic reaches `log`'s hook (`panic at file:line:column`), and a window that stops pumping
//! messages reaches the main-thread watchdog (`main_thread_watch`). Neither covers the way this
//! process most often disappears without a word: an access violation, a CRT `abort`, a stack
//! overflow, or a fault inside a native library. Those never unwind through Rust, so no hook runs
//! and `app.log` simply stops between `run started` and `run ended`.
//!
//! This module installs the one process-wide filter Windows calls for exactly that case. It writes
//! the exception to `app.log` - code, access kind and address, the faulting `module+0xoffset`, and
//! where the minidump went - and then continues to the previous handler, so Windows Error Reporting
//! still sees the crash. The next start reads the missing `run ended` and says so (`log::init`).
//!
//! Rules for this path, because it runs on the crashing thread with the process already lost:
//!
//! - **No shared log state.** The thread may have crashed while holding the log's mutex; the record
//!   is appended through a handle of its own (`log::error_record` + `CreateFileW`).
//! - **The first record goes out before the dump is attempted.** A dump of a live process can take
//!   a second and can hang on a corrupted heap; the exception and its module are the facts worth
//!   surviving that.
//! - **One attempt, then Windows owns the crash.** A second exception while handling the first is
//!   left to the default handling rather than nested.
//! - **Never write `run ended`.** Its absence is what identifies the run as a death.
//! - **Dumps are bounded.** Install keeps at most [`DUMP_KEEP`] files and prunes the rest.
//!
//! Two limits are deliberate. The filter is installed only once the data root and the log exist
//! (`state::AppState::new`), so a fault inside Tauri's own start-up is not covered. And a WebView2
//! renderer or GPU process that dies is a different process: its crash is Windows' or Crashpad's
//! record, not this handler's.

#[cfg(not(windows))]
use std::path::Path;

/// How many dumps survive on disk. A crash loop would otherwise fill the data root with one dump
/// per start; five is enough to compare the last few deaths.
const DUMP_KEEP: usize = 5;

/// The prefix every dump this module writes carries; the start second and pid follow it.
const DUMP_PREFIX: &str = "omp-desktop-";

#[cfg(windows)]
mod platform {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;
    use std::time::{SystemTime, UNIX_EPOCH};

    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, GENERIC_WRITE, HANDLE, HMODULE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FlushFileBuffers, WriteFile, CREATE_ALWAYS, FILE_APPEND_DATA,
        FILE_ATTRIBUTE_NORMAL, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_ALWAYS,
    };
    use windows_sys::Win32::System::Diagnostics::Debug::{
        MiniDumpNormal, MiniDumpWithThreadInfo, MiniDumpWriteDump, RtlPcToFileHeader,
        SetUnhandledExceptionFilter, EXCEPTION_CONTINUE_SEARCH, EXCEPTION_POINTERS,
        LPTOP_LEVEL_EXCEPTION_FILTER, MINIDUMP_EXCEPTION_INFORMATION,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleFileNameW;
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetCurrentProcessId, GetCurrentThreadId,
    };

    use super::{DUMP_KEEP, DUMP_PREFIX};
    use crate::services::log;

    /// Set for the duration of one handling, so a fault inside the handler cannot recurse.
    static HANDLING: AtomicBool = AtomicBool::new(false);

    /// The filter's precomputed paths and the handler it replaced. Written once by [`install`]
    /// before any fault can be expected, and read lock-free by the handler afterwards. The
    /// initializer needs the resolved logs directory, which exists only at runtime.
    static STATE: OnceLock<State> = OnceLock::new();

    /// Installed exactly once: a second install would chain this filter to itself and a fault would
    /// then recurse until the stack was gone.
    static INSTALLED: OnceLock<()> = OnceLock::new();

    struct State {
        /// `app.log`, as UTF-16 for `CreateFileW`.
        log: Vec<u16>,
        /// The dump this run would write, as UTF-16 for `CreateFileW`, and its path relative to the
        /// logs directory for the record. The record carries `dumps/<name>` rather than the absolute
        /// path on purpose: the log's redaction replaces a drive path with `<path>`, and the name is
        /// what the reader needs to find the file the settings page's directory already lists.
        dump_wide: Vec<u16>,
        dump_label: String,
        /// The filter in force before this one, so the crash still reaches whoever handled it.
        previous: LPTOP_LEVEL_EXCEPTION_FILTER,
    }

    pub(crate) fn install(logs_dir: &Path) {
        if INSTALLED.set(()).is_err() {
            return;
        }
        let dump_dir = logs_dir.join("dumps");
        if let Err(error) = std::fs::create_dir_all(&dump_dir) {
            log::warn(&format!(
                "crash dumps cannot be written to {}: {error}",
                dump_dir.display()
            ));
        }
        prune(&dump_dir);
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_secs());
        let dump_name = format!("{DUMP_PREFIX}{secs:010}-{}.dmp", std::process::id());
        let dump = dump_dir.join(&dump_name);
        // SAFETY: installing a process-wide filter; the function pointer matches the declared
        // signature and stays valid for the life of the process. A fault in the few instructions
        // between this call and the `STATE` store finds no state and is left to Windows.
        let previous = unsafe { SetUnhandledExceptionFilter(Some(filter)) };
        let _ = STATE.set(State {
            log: wide(&logs_dir.join(log::APP_LOG_FILE)),
            dump_wide: wide(&dump),
            dump_label: format!("dumps/{dump_name}"),
            previous,
        });
    }

    /// `path` as a NUL-terminated UTF-16 buffer for the Win32 calls on the crash path.
    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// Keeps the newest [`DUMP_KEEP`] dumps. Their names start with a zero-padded Unix second, so
    /// name order is age order; a failed removal leaves the file for the next start to try again.
    fn prune(dir: &Path) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut dumps: Vec<std::path::PathBuf> = entries
            .flatten()
            .filter_map(|entry| {
                let path = entry.path();
                let name = path.file_name()?.to_str()?;
                (name.starts_with(DUMP_PREFIX) && name.ends_with(".dmp")).then_some(path)
            })
            .collect();
        if dumps.len() <= DUMP_KEEP {
            return;
        }
        dumps.sort();
        let excess = dumps.len() - DUMP_KEEP;
        for path in dumps.into_iter().take(excess) {
            let _ = std::fs::remove_file(path);
        }
    }

    /// The filter itself: record, dump, then let the previous handler (and Windows) continue.
    unsafe extern "system" fn filter(info: *const EXCEPTION_POINTERS) -> i32 {
        if HANDLING.swap(true, Ordering::SeqCst) {
            return EXCEPTION_CONTINUE_SEARCH;
        }
        if let Some(state) = STATE.get() {
            let (code, address, parameters) =
                match info.as_ref().and_then(|info| info.ExceptionRecord.as_ref()) {
                    Some(record) => (
                        record.ExceptionCode as u32,
                        record.ExceptionAddress as usize,
                        record.ExceptionInformation,
                    ),
                    None => (0, 0, [0; 15]),
                };
            // The exception and its location first: a dump can hang on a process this far gone.
            append_record(
                &state.log,
                &log::error_record(&format!(
                    "omp: fatal exception {} at {}; writing dump {}",
                    exception_detail(code, &parameters),
                    fault_site(address),
                    state.dump_label
                )),
            );
            match write_dump(state, info) {
                Ok(()) => append_record(
                    &state.log,
                    &log::error_record(&format!("omp: fatal dump written to {}", state.dump_label)),
                ),
                Err(code) => append_record(
                    &state.log,
                    &log::error_record(&format!(
                        "omp: fatal dump failed for {} (win32 error {code})",
                        state.dump_label
                    )),
                ),
            }
            if let Some(previous) = state.previous {
                // `previous` may be another module's filter; chain to it so its own reporting (a
                // debugger's, WebView2's) keeps working. It is never this function: install runs
                // once.
                if previous as usize != filter as *const () as usize {
                    return previous(info);
                }
            }
        }
        EXCEPTION_CONTINUE_SEARCH
    }

    /// The exception as one clause a reader can act on: the code in hex, plus the detail the two
    /// codes that carry one (an access violation, a stack overflow) add.
    fn exception_detail(code: u32, parameters: &[usize; 15]) -> String {
        match code {
            0xC000_0005 => {
                let access = match parameters[0] {
                    0 => "read",
                    1 => "write",
                    8 => "execute",
                    _ => "access",
                };
                format!(
                    "0xC0000005 (access violation: {access} at 0x{:x})",
                    parameters[1]
                )
            }
            0xC000_00FD => "0xC00000FD (stack overflow)".to_owned(),
            other => format!("0x{other:08X}"),
        }
    }

    /// `module+0xoffset` for one address, or the bare address when no loaded image owns it. The
    /// offset resolves against the build's PDB; `run started` names the build for exactly that.
    fn fault_site(address: usize) -> String {
        let mut base: *mut c_void = std::ptr::null_mut();
        // SAFETY: a read-only lookup of the image that contains `address`.
        let image = unsafe { RtlPcToFileHeader(address as *const c_void, &mut base) };
        if image.is_null() || base.is_null() {
            return format!("0x{address:x}");
        }
        let offset = address.wrapping_sub(base as usize);
        match module_name(base) {
            Some(module) => format!("{module}+0x{offset:x}"),
            None => format!("0x{address:x}"),
        }
    }

    fn module_name(module: HMODULE) -> Option<String> {
        let mut buffer = [0_u16; 512];
        // SAFETY: a writable buffer of the length passed, for a module loaded in this process.
        let len = unsafe { GetModuleFileNameW(module, buffer.as_mut_ptr(), buffer.len() as u32) };
        if len == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&buffer[..len as usize]);
        path.rsplit(['\\', '/']).next().map(str::to_owned)
    }

    /// Writes one minidump for this process and the exception about to kill it.
    ///
    /// Direct `MiniDumpWriteDump` from `dbghelp`: windows-sys links it at load time, so the crash
    /// path does not load a DLL or resolve a symbol while the loader may be the thing that faulted.
    unsafe fn write_dump(state: &State, info: *const EXCEPTION_POINTERS) -> Result<(), u32> {
        // SAFETY: a path buffer built at install and NUL-terminated; the handle is checked.
        let file: HANDLE = CreateFileW(
            state.dump_wide.as_ptr(),
            GENERIC_WRITE,
            0,
            std::ptr::null(),
            CREATE_ALWAYS,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        );
        if file == INVALID_HANDLE_VALUE {
            return Err(GetLastError());
        }
        let mut exception = MINIDUMP_EXCEPTION_INFORMATION {
            ThreadId: GetCurrentThreadId(),
            ExceptionPointers: info as *mut EXCEPTION_POINTERS,
            ClientPointers: 0,
        };
        // SAFETY: this process, a live file handle, and the exception the system just passed in.
        // `MiniDumpNormal` carries stacks and loaded modules; thread info adds each thread's owner
        // without copying memory.
        let written = MiniDumpWriteDump(
            GetCurrentProcess(),
            GetCurrentProcessId(),
            file,
            MiniDumpNormal | MiniDumpWithThreadInfo,
            &mut exception,
            std::ptr::null(),
            std::ptr::null(),
        );
        let error = if written == 0 { GetLastError() } else { 0 };
        // SAFETY: the handle came from `CreateFileW` above and is closed exactly once.
        CloseHandle(file);
        if written == 0 {
            return Err(error);
        }
        Ok(())
    }

    /// Appends one already-formatted record to `app.log` through a handle of its own.
    ///
    /// The shared sink is avoided on purpose: the crashing thread may hold its mutex. The handle is
    /// opened for append and shared for read/write/delete, so it disturbs neither the sink's handle
    /// nor a reader's.
    fn append_record(path: &[u16], line: &str) {
        // SAFETY: a NUL-terminated path, and the handle is checked before it is written through.
        let file: HANDLE = unsafe {
            CreateFileW(
                path.as_ptr(),
                FILE_APPEND_DATA,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_ALWAYS,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };
        if file == INVALID_HANDLE_VALUE {
            return;
        }
        let mut written = 0_u32;
        // SAFETY: a live append handle and a buffer that outlives the call. The process is about to
        // die, so the flush is the point: what is still in the file system's cache is what a reader
        // will hand over.
        unsafe {
            WriteFile(
                file,
                line.as_ptr(),
                line.len() as u32,
                &mut written,
                std::ptr::null_mut(),
            );
            FlushFileBuffers(file);
            CloseHandle(file);
        }
    }

    #[cfg(test)]
    mod tests {
        use std::time::{Duration, Instant};

        use super::*;

        fn fresh_dir(name: &str) -> std::path::PathBuf {
            let dir = std::env::temp_dir().join(format!("omp-crash-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("a directory this test owns");
            dir
        }

        /// The whole path, driven as Windows drives it: the test binary runs once more, installs
        /// the filter, writes through a null pointer, and dies. The record and the dump it leaves
        /// are what the next start and a reader get.
        ///
        /// A child process rather than a fabricated `EXCEPTION_POINTERS` in this one: the filter
        /// and `MiniDumpWriteDump` read the context the system captured, which is the only shape the
        /// crash path can honestly claim to handle.
        #[test]
        fn a_native_fault_leaves_a_record_and_a_dump() {
            let dir = fresh_dir("fault");
            let mut child = std::process::Command::new(
                std::env::current_exe().expect("the test binary's own path"),
            )
            .args([
                "--exact",
                "services::crash::platform::tests::inject_a_native_fault",
                "--nocapture",
            ])
            .env("OMP_CRASH_TEST_DIR", &dir)
            .spawn()
            .expect("the faulting child starts");

            let deadline = Instant::now() + Duration::from_secs(60);
            let status = loop {
                if let Some(status) = child.try_wait().expect("the child's status") {
                    break status;
                }
                if Instant::now() > deadline {
                    let _ = child.kill();
                    panic!("the faulting child did not exit");
                }
                std::thread::sleep(Duration::from_millis(50));
            };
            assert!(!status.success(), "the child must die of the fault");

            let text = std::fs::read_to_string(dir.join(log::APP_LOG_FILE)).expect("the record");
            assert!(
                text.contains("fatal exception 0xC0000005 (access violation: write at 0x0)"),
                "{text}"
            );
            assert!(text.contains("+0x"), "the faulting module is named: {text}");
            assert!(text.contains("fatal dump written to"), "{text}");

            let dumps: Vec<_> = std::fs::read_dir(dir.join("dumps"))
                .expect("the dumps directory")
                .flatten()
                .collect();
            assert_eq!(dumps.len(), 1, "one dump for one fault");
            let size = dumps[0].metadata().expect("dump metadata").len();
            assert!(size > 4096, "the dump holds more than its header: {size}");
            let _ = std::fs::remove_dir_all(&dir);
        }

        /// The child half of the test above: only a process the parent points at a directory dies
        /// here, so the ordinary test run is one that returns.
        #[test]
        fn inject_a_native_fault() {
            let Ok(dir) = std::env::var("OMP_CRASH_TEST_DIR") else {
                return;
            };
            install(Path::new(&dir));
            // SAFETY: the null write is the fault this test exists to produce, in a child the parent
            // expects to die. `black_box` keeps the compiler from proving the store unreachable.
            unsafe {
                let null = std::hint::black_box(std::ptr::null_mut::<u8>());
                std::ptr::write_volatile(null, 1);
            }
        }

        /// Only the newest dumps survive, by the zero-padded start second in their names.
        #[test]
        fn install_keeps_only_the_newest_dumps() {
            let dir = fresh_dir("prune");
            for second in 1..=DUMP_KEEP as u64 + 2 {
                let path = dir.join(format!("{DUMP_PREFIX}{second:010}-10.dmp"));
                std::fs::write(&path, b"dump").expect("a fake dump");
            }
            std::fs::write(dir.join("unrelated.txt"), b"keep").expect("an unrelated file");
            prune(&dir);

            let names: Vec<String> = std::fs::read_dir(&dir)
                .expect("the directory")
                .flatten()
                .filter_map(|entry| entry.file_name().into_string().ok())
                .collect();
            assert_eq!(
                names.len(),
                DUMP_KEEP + 1,
                "five dumps plus the unrelated file"
            );
            assert!(names.contains(&format!("{DUMP_PREFIX}{:010}-10.dmp", DUMP_KEEP as u64 + 2)));
            assert!(!names.contains(&format!("{DUMP_PREFIX}{:010}-10.dmp", 1)));
            assert!(names.contains(&"unrelated.txt".to_owned()));
            let _ = std::fs::remove_dir_all(&dir);
        }

        /// The two codes worth expanding, and the bare hex every other one gets.
        #[test]
        fn the_exception_detail_names_the_access_and_the_offset() {
            let mut write = [0_usize; 15];
            write[0] = 1;
            write[1] = 0xdead_beef;
            assert_eq!(
                exception_detail(0xC000_0005, &write),
                "0xC0000005 (access violation: write at 0xdeadbeef)"
            );
            let mut read = [0_usize; 15];
            read[1] = 0x10;
            assert!(exception_detail(0xC000_0005, &read).contains("read at 0x10"));
            assert_eq!(
                exception_detail(0xC000_00FD, &[0; 15]),
                "0xC00000FD (stack overflow)"
            );
            assert_eq!(exception_detail(0xC000_001D, &[0; 15]), "0xC000001D");
        }

        /// A known address in this image is named as a module plus an offset, not as a bare
        /// address: the offset is resolvable against the PDB this build keeps.
        #[test]
        fn a_faulting_address_is_named_by_module_and_offset() {
            let site = fault_site(exception_detail as *const () as usize);
            assert!(site.contains("+0x"), "{site}");
            assert!(!site.starts_with("0x"), "{site}");
        }
    }
}

#[cfg(windows)]
pub(crate) use platform::install;

/// Every other platform has no native fault path this application can intercept: the panic hook and
/// the start/end records are the whole evidence there.
#[cfg(not(windows))]
pub(crate) fn install(_logs_dir: &Path) {}
