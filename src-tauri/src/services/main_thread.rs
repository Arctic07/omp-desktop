//! What the main thread is doing, read from another thread.
//!
//! The watchdog (`services::main_thread_watch`) asks two questions about a thread it does not own,
//! and this module answers them: how much CPU that thread has spent ([`MainThread::used`]), and,
//! when a stall makes the answer worth the cost, where it is executing ([`MainThread::frames`]).
//!
//! The stack walk is the debugger's own x64 unwind, done with `RtlLookupFunctionEntry` and
//! `RtlVirtualUnwind` from ntdll: no symbol server, no `dbghelp`, no loader lock. Two rules make
//! suspending a thread safe enough to do from inside the process it belongs to:
//!
//! - **Nothing is allocated while the thread is suspended.** A suspended thread can be holding the
//!   process heap, and an allocation made by the walker would then wait for a thread that is not
//!   running. Addresses land in a fixed array on the walker's own stack; the strings are built
//!   after the thread is running again.
//! - **The thread is always resumed.** The guard that resumes it is a `Drop`, so a panic in the
//!   walk still leaves the process with a running main thread.
//!
//! What comes back is `module+0xoffset`, not a symbol: naming the function needs the module's PDB,
//! which the installed build does not ship. The module is what the first question asks for anyway -
//! our own code, `combase`, `ntdll`, or the WebView2 loader.

/// The most frames one walk keeps. A stack that matters is at the top; the rest is the message
/// loop and the thread start, which every stall shares.
pub(crate) const FRAME_LIMIT: usize = 12;

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
mod platform {
    use std::ffi::c_void;
    use std::time::Duration;

    use tauri::Window;
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, HMODULE};
    use windows_sys::Win32::System::Diagnostics::Debug::{
        GetThreadContext, ReadProcessMemory, RtlLookupFunctionEntry, RtlPcToFileHeader,
        RtlVirtualUnwind, CONTEXT, CONTEXT_CONTROL_AMD64, CONTEXT_INTEGER_AMD64,
        IMAGE_RUNTIME_FUNCTION_ENTRY, KNONVOLATILE_CONTEXT_POINTERS, UNWIND_HISTORY_TABLE,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleFileNameW;
    use windows_sys::Win32::System::Threading::{
        GetThreadTimes, OpenThread, ResumeThread, SuspendThread, THREAD_GET_CONTEXT,
        THREAD_QUERY_INFORMATION, THREAD_SUSPEND_RESUME,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

    use super::FRAME_LIMIT;

    /// One thread of this process, opened once and read many times.
    pub(crate) struct MainThread(HANDLE);

    impl MainThread {
        pub(crate) fn open(window: &Window) -> Option<Self> {
            let hwnd = window.hwnd().ok()?;
            let mut process = 0_u32;
            // SAFETY: `hwnd` is this process's own live main window, and the call only reads ids.
            let thread = unsafe { GetWindowThreadProcessId(hwnd.0, &mut process) };
            if thread == 0 {
                return None;
            }
            // SAFETY: a handle to a thread id the call above just reported; the rights are the
            // three this module reads, and nothing is inherited.
            let handle = unsafe {
                OpenThread(
                    THREAD_QUERY_INFORMATION | THREAD_GET_CONTEXT | THREAD_SUSPEND_RESUME,
                    0,
                    thread,
                )
            };
            if handle.is_null() {
                return None;
            }
            Some(Self::from_handle(handle))
        }

        /// A handle already opened for this thread, owned from here on.
        pub(super) fn from_handle(handle: HANDLE) -> Self {
            Self(handle)
        }

        /// User plus kernel time this thread has spent since it started.
        pub(crate) fn used(&self) -> Option<Duration> {
            let zero = FILETIME {
                dwLowDateTime: 0,
                dwHighDateTime: 0,
            };
            let (mut creation, mut exit, mut kernel, mut user) = (zero, zero, zero, zero);
            // SAFETY: four owned buffers, and a handle opened for exactly this query.
            let read =
                unsafe { GetThreadTimes(self.0, &mut creation, &mut exit, &mut kernel, &mut user) };
            if read == 0 {
                return None;
            }
            Some(Duration::from_nanos(
                hundred_nanos(kernel) + hundred_nanos(user),
            ))
        }

        /// The thread's frames, innermost first, as `module+0xoffset`.
        pub(crate) fn frames(&self) -> Option<Vec<String>> {
            let mut raw = [0_usize; FRAME_LIMIT];
            // SAFETY: `walk` suspends this thread, reads only its context and the unwind tables of
            // modules already loaded, and resumes it before returning.
            let count = unsafe { walk(self.0, &mut raw) }?;
            Some(raw[..count].iter().map(|pc| name(*pc)).collect())
        }
    }

    impl Drop for MainThread {
        fn drop(&mut self) {
            // SAFETY: the handle was opened by `open` and is closed exactly once, here.
            unsafe { CloseHandle(self.0) };
        }
    }

    /// FILETIME counts 100 ns units; `Duration` counts nanoseconds.
    fn hundred_nanos(time: FILETIME) -> u64 {
        (((time.dwHighDateTime as u64) << 32) | time.dwLowDateTime as u64) * 100
    }

    /// Resumes the thread however this function leaves - including by panic.
    struct Resumed(HANDLE);

    impl Drop for Resumed {
        fn drop(&mut self) {
            // SAFETY: the matching `SuspendThread` succeeded, and the handle stays open until the
            // caller's `MainThread` is dropped.
            unsafe { ResumeThread(self.0) };
        }
    }

    /// Fills `out` with the thread's instruction pointers and answers how many there are.
    ///
    /// Every frame is looked up in its module's unwind data; a function without any (a leaf) is
    /// followed by taking the return address from the stack pointer, which is what the frame has
    /// to hold when nothing recorded how to unwind it.
    unsafe fn walk(thread: HANDLE, out: &mut [usize; FRAME_LIMIT]) -> Option<usize> {
        if SuspendThread(thread) == u32::MAX {
            return None;
        }
        let _resume = Resumed(thread);

        /// `GetThreadContext` refuses a `CONTEXT` that is not 16-byte aligned on x64, and the
        /// binding's own type is 8-byte aligned (its `M128A` is two `u64`s), so the buffer is
        /// over-aligned here instead of trusting the stack layout - which is how the first version
        /// of this walk failed with `ERROR_NOACCESS`.
        #[repr(align(16))]
        struct Aligned(CONTEXT);

        let mut buffer = Aligned(std::mem::zeroed());
        let context = &mut buffer.0;
        context.ContextFlags = CONTEXT_CONTROL_AMD64 | CONTEXT_INTEGER_AMD64;
        // SAFETY: the thread is suspended, and `context` is a 16-byte aligned CONTEXT for this
        // architecture.
        if GetThreadContext(thread, context) == 0 {
            return None;
        }

        let mut count = 0;
        let mut ip = context.Rip as usize;
        while count < out.len() && ip != 0 {
            out[count] = ip;
            count += 1;

            let mut image_base = 0_u64;
            let mut table: UNWIND_HISTORY_TABLE = std::mem::zeroed();
            // SAFETY: a plain address lookup against the loaded images; `table` is the scratch
            // cache the call may fill.
            let entry = RtlLookupFunctionEntry(ip as u64, &mut image_base, &mut table);
            if entry.is_null() {
                let mut next = 0_usize;
                if !read_stack(context.Rsp as usize, &mut next) {
                    break;
                }
                context.Rsp = context.Rsp.wrapping_add(8);
                ip = next;
                continue;
            }
            // SAFETY: `entry` belongs to the image at `image_base` for the address `ip`, and the
            // call only rewrites `context` from that image's unwind data. The three out-parameters
            // are documented as optional and are not: a null `ContextPointers` faults inside the
            // call (measured on Windows 11 22621, 2026-10-30), so they are all real storage.
            let mut handler_data: *mut std::ffi::c_void = std::ptr::null_mut();
            let mut establisher = 0_u64;
            let mut pointers: KNONVOLATILE_CONTEXT_POINTERS = std::mem::zeroed();
            RtlVirtualUnwind(
                0,
                image_base,
                ip as u64,
                entry as *const IMAGE_RUNTIME_FUNCTION_ENTRY,
                context,
                &mut handler_data,
                &mut establisher,
                &mut pointers,
            );
            ip = context.Rip as usize;
        }
        Some(count)
    }

    /// One word off the suspended thread's stack, refused rather than faulted when the address is
    /// not readable: a stack pointer taken from a frame the walker guessed wrong must not take the
    /// process down.
    fn read_stack(address: usize, out: &mut usize) -> bool {
        use windows_sys::Win32::System::Threading::GetCurrentProcess;

        let mut read = 0_usize;
        // SAFETY: the destination is an owned `usize`, the process handle is this process, and
        // `ReadProcessMemory` reports a bad source address instead of raising.
        let ok = unsafe {
            ReadProcessMemory(
                GetCurrentProcess(),
                address as *const c_void,
                out as *mut usize as *mut c_void,
                std::mem::size_of::<usize>(),
                &mut read,
            )
        };
        ok != 0 && read == std::mem::size_of::<usize>()
    }

    /// `module+0xoffset` for one address, or the bare address when no loaded image owns it.
    fn name(pc: usize) -> String {
        let mut base: *mut c_void = std::ptr::null_mut();
        // SAFETY: a read-only lookup of the image that contains `pc`.
        let image = unsafe { RtlPcToFileHeader(pc as *const c_void, &mut base) };
        if image.is_null() || base.is_null() {
            return format!("0x{pc:x}");
        }
        let offset = pc.wrapping_sub(base as usize);
        match module_name(base as HMODULE) {
            Some(module) => format!("{module}+0x{offset:x}"),
            None => format!("0x{pc:x}"),
        }
    }

    fn module_name(module: HMODULE) -> Option<String> {
        let mut buffer = [0_u16; 512];
        // SAFETY: a writable buffer of the length passed, for a module already loaded here.
        let len = unsafe { GetModuleFileNameW(module, buffer.as_mut_ptr(), buffer.len() as u32) };
        if len == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&buffer[..len as usize]);
        path.rsplit(['\\', '/']).next().map(str::to_owned)
    }
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
pub(crate) use platform::MainThread;

/// Every other platform reports the stall without the split, which is why `open` answers `None`
/// rather than a clock that always reads zero.
#[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
pub(crate) struct MainThread;

#[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
impl MainThread {
    pub(crate) fn open(_window: &tauri::Window) -> Option<Self> {
        None
    }

    pub(crate) fn used(&self) -> Option<std::time::Duration> {
        None
    }

    pub(crate) fn frames(&self) -> Option<Vec<String>> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The walk, exercised against a thread this process owns: it must terminate, name every frame
    /// by its module, and leave the thread running. A walker that failed any of the three would
    /// either freeze the window it was diagnosing or report nothing usable - and nothing else in
    /// this repository would notice, because the only other caller runs once, inside a stall.
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    #[test]
    fn a_sleeping_thread_is_walked_and_named_by_module() {
        use std::sync::mpsc;
        use windows_sys::Win32::System::Threading::{
            GetCurrentThreadId, OpenThread, THREAD_GET_CONTEXT, THREAD_QUERY_INFORMATION,
            THREAD_SUSPEND_RESUME,
        };

        let (sender, receiver) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            // SAFETY: a plain query of the calling thread's own id.
            let id = unsafe { GetCurrentThreadId() };
            let _ = sender.send(id);
            std::thread::sleep(std::time::Duration::from_millis(750));
        });
        let id = receiver.recv().expect("the worker reports its id");
        // SAFETY: a handle to a live thread of this process, with the three rights the walk needs.
        let handle = unsafe {
            OpenThread(
                THREAD_QUERY_INFORMATION | THREAD_GET_CONTEXT | THREAD_SUSPEND_RESUME,
                0,
                id,
            )
        };
        assert!(!handle.is_null(), "the worker's thread handle");

        let thread = MainThread::from_handle(handle);
        let frames = thread.frames().expect("the walk answers");
        drop(thread);

        // A walk that left the thread suspended would never let this join return.
        worker.join().expect("the worker finished");

        assert!(
            frames.len() >= 2,
            "a sleeping thread has a stack: {frames:?}"
        );
        assert!(
            frames.iter().all(|frame| frame.contains("+0x")),
            "every frame names its module: {frames:?}"
        );
    }
}
