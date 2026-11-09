//! The find keystrokes this application takes back from the webview.
//!
//! `Ctrl+F`, `Ctrl+G`, `Ctrl+Shift+G`, `F3` and `Shift+F3` are browser accelerator keys: WebView2
//! answers them with its own find dialog over the whole document — the transcript, the sidebar and
//! the open file alike. This application has one find, and it belongs to the file preview
//! (`components/workspace/file-find-bar.tsx`): there, and only there, does `Ctrl+F` mean anything.
//! `Ctrl+Shift+G` belongs to the work column's git review; `Ctrl+G` and the `F3` pair mean nothing
//! here. So the browser's handling of those keys is turned off on every webview this process owns.
//!
//! Per key, on the `AcceleratorKeyPressed` event, rather than `AreBrowserAcceleratorKeysEnabled`
//! switched off wholesale: that setting also takes `Ctrl+R`, `Ctrl+P`, zoom and the devtools chords
//! with it. Marking the press as "the browser does not handle this one" does not mark it handled —
//! the key still reaches the page, which is what lets the file panel and the work column answer it.

/// The virtual keys of the find accelerators: `F`, `G`, and `F3` (with or without Shift).
#[cfg(windows)]
const FIND_KEYS: [u32; 3] = [0x46, 0x47, 0x72];

/// Takes the find accelerators away from the main window's webview.
///
/// A window whose accelerator could not be claimed keeps the dialog: the file panel's find bar and
/// the work column's `Ctrl+Shift+G` still work, the reader just also sees the runtime's dialog when
/// they press the key over anything else.
pub(crate) fn release_find_keys(app: &tauri::AppHandle) {
    #[cfg(windows)]
    {
        use tauri::Manager;

        let Some(window) = app.get_webview_window(crate::services::presence::MAIN_WINDOW) else {
            crate::services::log::warn(
                "the find accelerators were left to the main webview: the main window is not there",
            );
            return;
        };
        claim_find_keys(window.as_ref(), "the main window");
    }
    #[cfg(not(windows))]
    let _ = app;
}

/// Takes the same find accelerators away from one guest webview.
///
/// The built-in browser and a plugin panel are WebView2 controllers of their own: the handler on
/// the main window never sees a key pressed while one of them has focus, and each would otherwise
/// keep the runtime's find dialog. The chord opens no work column there — those pages own their
/// keyboard, and a plugin window has no column to open — so the find dialog is the only thing this
/// removes.
pub(crate) fn release_find_keys_on(webview: &tauri::Webview, label: &'static str) {
    #[cfg(windows)]
    claim_find_keys(webview, label);
    #[cfg(not(windows))]
    {
        let _ = (webview, label);
    }
}

/// Installs the find-key handler on one webview's controller.
#[cfg(windows)]
fn claim_find_keys(webview: &tauri::Webview, label: &'static str) {
    use webview2_com::AcceleratorKeyPressedEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2AcceleratorKeyPressedEventArgs, ICoreWebView2AcceleratorKeyPressedEventArgs2,
        ICoreWebView2Controller, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
        COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
    };
    use windows::core::Interface;

    let claimed = webview.with_webview(move |platform| {
        let installed = (|| -> windows::core::Result<()> {
            let controller = platform.controller();
            // The handler is held by the event source for as long as the webview lives, which is
            // the page's whole life: nothing here removes it again.
            let handler = AcceleratorKeyPressedEventHandler::create(Box::new(
                |_sender: Option<ICoreWebView2Controller>,
                 args: Option<ICoreWebView2AcceleratorKeyPressedEventArgs>| {
                    let Some(args) = args else { return Ok(()) };
                    let mut key = 0;
                    unsafe { args.VirtualKey(&mut key) }?;
                    if !FIND_KEYS.contains(&key) {
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
                "the find accelerators were left to {label}'s webview: its accelerator could not be claimed ({error})"
            ));
        }
    });
    if let Err(error) = claimed {
        crate::services::log::warn(&format!(
            "the find accelerators were left to {label}'s webview: it is not reachable ({error})"
        ));
    }
}
