//! The one keystroke this application takes back from the webview.
//!
//! `Ctrl+F` is a browser accelerator key: WebView2 answers it with its own find dialog over the
//! whole document — the transcript, the sidebar and the open file alike. This application has one
//! find, and it belongs to the file preview (`components/workspace/file-find-bar.tsx`): there, and
//! only there, does `Ctrl+F` mean anything. So the browser's handling of that key is turned off on
//! the application's own webview.
//!
//! Per key, on the `AcceleratorKeyPressed` event, rather than `AreBrowserAcceleratorKeysEnabled`
//! switched off wholesale: that setting also takes `Ctrl+R`, `Ctrl+P`, zoom and the devtools chords
//! with it. Marking the press as "the browser does not handle this one" does not mark it handled —
//! the key still reaches the page, which is what lets the file panel answer it.

/// Takes `Ctrl+F` away from the webview's own find dialog on the application's window.
///
/// A window whose accelerator could not be claimed keeps the dialog: the file panel's find bar
/// still works, the reader just also sees the runtime's when they press the key over anything else.
pub(crate) fn release_find_key(app: &tauri::AppHandle) {
    #[cfg(windows)]
    install(app);
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(windows)]
fn install(app: &tauri::AppHandle) {
    use tauri::Manager;
    use webview2_com::AcceleratorKeyPressedEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2AcceleratorKeyPressedEventArgs, ICoreWebView2AcceleratorKeyPressedEventArgs2,
        ICoreWebView2Controller, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
        COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
    };
    use windows::core::Interface;

    /// `F`, the virtual key of the letter half of `Ctrl+F`.
    const KEY_F: u32 = 0x46;

    let Some(window) = app.get_webview_window(crate::services::presence::MAIN_WINDOW) else {
        crate::services::log::warn(
            "Ctrl+F was left to the webview's own find: the main window is not there",
        );
        return;
    };
    let claimed = window.with_webview(|platform| {
        let installed = (|| -> windows::core::Result<()> {
            let controller = platform.controller();
            // The handler is held by the event source for as long as the webview lives, which is
            // this process's whole life: nothing here removes it again.
            let handler = AcceleratorKeyPressedEventHandler::create(Box::new(
                |_sender: Option<ICoreWebView2Controller>,
                 args: Option<ICoreWebView2AcceleratorKeyPressedEventArgs>| {
                    let Some(args) = args else { return Ok(()) };
                    let mut key = 0;
                    unsafe { args.VirtualKey(&mut key) }?;
                    if key != KEY_F {
                        return Ok(());
                    }
                    let mut kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
                    unsafe { args.KeyEventKind(&mut kind) }?;
                    if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
                        && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN
                    {
                        return Ok(());
                    }
                    let Ok(keyed) = args.cast::<ICoreWebView2AcceleratorKeyPressedEventArgs2>()
                    else {
                        return Ok(());
                    };
                    unsafe { keyed.SetIsBrowserAcceleratorKeyEnabled(false) }
                },
            ));
            let mut token = 0;
            unsafe { controller.add_AcceleratorKeyPressed(&handler, &mut token) }
        })();
        if let Err(error) = installed {
            crate::services::log::warn(&format!(
                "Ctrl+F was left to the webview's own find: its accelerator could not be claimed ({error})"
            ));
        }
    });
    if let Err(error) = claimed {
        crate::services::log::warn(&format!(
            "Ctrl+F was left to the webview's own find: the window's webview is not reachable ({error})"
        ));
    }
}
