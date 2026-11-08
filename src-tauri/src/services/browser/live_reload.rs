//! Live reload for a local HTML preview: watch the file's directory, debounce, reload.
//!
//! For a `file:` page this is a watcher on the loaded file's directory, a 250 ms debounce, and a
//! cache-ignoring reload.
//! The watcher belongs to the page and is dropped when the page navigates to the web or closes, so
//! nothing keeps watching a directory nobody is previewing.

use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};

/// How long a burst of writes settles before the page is reloaded.
const DEBOUNCE: Duration = Duration::from_millis(250);

/// One directory watcher, alive for as long as the page previews a file in it.
pub(crate) struct LiveReload {
    /// Dropping the watcher drops the sender its callback owns; the reload thread then exits.
    _watcher: RecommendedWatcher,
}

impl LiveReload {
    /// Start watching `dir`; `reload` runs once per settled burst.
    pub(crate) fn new(dir: &Path, reload: impl Fn() + Send + 'static) -> Option<Self> {
        let (sender, receiver) = mpsc::channel::<()>();
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                if result.is_ok() {
                    let _ = sender.send(());
                }
            })
            .ok()?;
        watcher.watch(dir, RecursiveMode::NonRecursive).ok()?;
        std::thread::Builder::new()
            .name("omp-browser-reload".to_owned())
            .spawn(move || {
                while receiver.recv().is_ok() {
                    // Drain the burst: one save is several file events on Windows.
                    while receiver.recv_timeout(DEBOUNCE).is_ok() {}
                    reload();
                }
            })
            .ok()?;
        Some(Self { _watcher: watcher })
    }
}
