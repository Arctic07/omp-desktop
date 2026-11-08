//! One worker's reader thread: frames in, settlements out, and the exit when the pipe
//! closes.

use super::super::api;
use super::lifecycle::wait_exit;
use super::*;

pub(super) struct ReaderContext {
    pub(super) install: Arc<ProcessInstall>,
    pub(super) app: Option<tauri::AppHandle>,
    pub(super) pending: Arc<Pending>,
    pub(super) link: Arc<dyn WorkerLink>,
    /// The installation's run-time command registry, shared with the entry (`command.register`).
    pub(super) commands: Arc<Mutex<BTreeSet<String>>>,
    pub(super) weak: Weak<PluginProcess>,
    pub(super) key: Key,
    pub(super) generation: u64,
}

/// Reads one worker's stdout until it closes, handing every frame to [`handle_frame`].
pub(super) fn read_frames(mut stdout: Box<dyn Read + Send>, context: &Arc<ReaderContext>) {
    let mut framer = LineFramer::new();
    let mut chunk = vec![0u8; READ_CHUNK];
    let mut lines: Vec<Line> = Vec::new();
    loop {
        match stdout.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                framer.push(&chunk[..read], &mut lines);
                for line in lines.drain(..) {
                    match line {
                        Line::Frame(text) => handle_line(&text, context),
                        Line::Oversized(bytes) => log::warn(&format!(
                            "a plugin worker line was dropped for its size: plugin={} bytes={bytes}",
                            context.install.plugin_id
                        )),
                    }
                }
            }
            Err(error) => {
                log::warn(&format!(
                    "a plugin worker's pipe failed: plugin={} error={error}",
                    context.install.plugin_id
                ));
                break;
            }
        }
    }
    if framer.tail_bytes() > 0 {
        log::warn(&format!(
            "a plugin worker ended inside a line: plugin={} bytes={}",
            context.install.plugin_id,
            framer.tail_bytes()
        ));
    }
    let code = wait_exit(&context.link, EXIT_CODE_WAIT);
    if let Some(me) = context.weak.upgrade() {
        me.worker_exited(&context.key, context.generation, code);
    }
}

/// One decoded line, routed to whoever is waiting for it.
fn handle_line(text: &str, context: &Arc<ReaderContext>) {
    match frames::decode(text) {
        Ok(Inbound::Hello {
            protocol,
            plugin_id,
            install_id,
            entry,
        }) => {
            // The identity is checked against the installation this child was spawned for: a worker
            // that answers for another plugin (or another registry) is not this process's worker.
            if plugin_id != context.install.plugin_id || install_id != context.install.install {
                log::warn(&format!(
                    "a plugin worker introduced itself as another installation: expected={}/{} got={plugin_id}/{install_id}",
                    context.install.plugin_id, context.install.install
                ));
                return;
            }
            let sender = lock(&context.pending.hello).take();
            if let Some(sender) = sender {
                let _ = sender.send(Some(Hello { protocol, entry }));
            }
        }
        Ok(Inbound::Result { id, settlement }) => {
            let sender = lock(&context.pending.calls).remove(&id);
            match sender {
                Some(sender) => {
                    let _ = sender.send(settlement);
                }
                None => log::warn(&format!(
                    "a plugin worker answered a request this side did not make: plugin={} id={id}",
                    context.install.plugin_id
                )),
            }
        }
        Ok(Inbound::Invoke { id, method, params }) => spawn_invoke(context, id, method, params),
        Ok(Inbound::Log { level, message }) => {
            let line = format!("plugin[{}] {level}: {message}", context.install.plugin_id);
            match level.as_str() {
                "warn" => log::warn(&line),
                "error" => log::error(&line),
                _ => log::info(&line),
            }
        }
        Ok(Inbound::Fatal { code, message }) => {
            log::warn(&format!(
                "a plugin worker refused to start: plugin={} code={code} message={message}",
                context.install.plugin_id
            ));
            *lock(&context.pending.fatal) = Some((code, message));
        }
        Ok(Inbound::Unusable { reason }) => {
            if context.pending.first_unknown(&reason) {
                log::warn(&format!(
                    "a plugin worker sent a frame this build does not read: plugin={} reason={reason}",
                    context.install.plugin_id
                ));
            }
        }
        Err(frames::DecodeFailure::NotAFrame) => log::warn(&format!(
            "a plugin worker wrote a line that is not a frame: plugin={}",
            context.install.plugin_id
        )),
        Err(frames::DecodeFailure::Invalid(what)) => log::warn(&format!(
            "a plugin worker frame carried no usable {what}: plugin={}",
            context.install.plugin_id
        )),
    }
}

/// One `worker_invoke`, answered on its own thread so a slow call cannot stop the reader.
fn spawn_invoke(context: &Arc<ReaderContext>, id: String, method: String, params: Value) {
    match lock(&context.pending.budget).take(Instant::now()) {
        Ok(()) => {}
        Err(code) => {
            refuse_invoke(
                context,
                &id,
                Settlement::refused(code, "This plugin has too many calls in flight."),
            );
            return;
        }
    }
    let context = Arc::clone(context);
    std::thread::spawn(move || {
        let settlement = api::dispatch(
            context.app.as_ref(),
            &context.install,
            &context.commands,
            &method,
            &params,
        );
        refuse_invoke(&context, &id, settlement);
        lock(&context.pending.budget).release();
    });
}

/// Writes one `worker_invoke_result`, replacing an answer the ceiling cannot carry with a refusal.
fn refuse_invoke(context: &ReaderContext, id: &str, settlement: Settlement) {
    let line = match frames::encode(&frames::Outbound::InvokeResult {
        id,
        settlement: &settlement,
    }) {
        Ok(line) => line,
        Err(_) => match frames::encode(&frames::Outbound::InvokeResult {
            id,
            settlement: &Settlement::refused(
                "too_large",
                "The answer is larger than the plugin worker frame ceiling.",
            ),
        }) {
            Ok(line) => line,
            Err(_) => return,
        },
    };
    if !context.link.send(&line) {
        log::info(&format!(
            "a plugin invoke answer could not be written: plugin={}",
            context.install.plugin_id
        ));
    }
}

/// Reads a worker's stderr until it closes: a panic, a runtime complaint or nothing at all.
///
/// The pipe is drained rather than ignored because a full stderr buffer would block the child; what
/// it carries is logged one cleaned line at a time, attributed to the plugin that wrote it.
pub(super) fn drain_stderr(mut stream: Box<dyn Read + Send>, plugin_id: String) {
    let mut framer = LineFramer::new();
    let mut chunk = vec![0u8; READ_CHUNK];
    let mut lines: Vec<Line> = Vec::new();
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => return,
            Ok(read) => {
                framer.push(&chunk[..read], &mut lines);
                for line in lines.drain(..) {
                    match line {
                        Line::Frame(text) => {
                            let text = frames::clean_log_line(&text);
                            if !text.is_empty() {
                                log::warn(&format!("plugin[{plugin_id}] stderr: {text}"));
                            }
                        }
                        Line::Oversized(bytes) => log::warn(&format!(
                            "a plugin worker wrote {bytes} bytes to stderr without a newline"
                        )),
                    }
                }
            }
            Err(_) => return,
        }
    }
}
