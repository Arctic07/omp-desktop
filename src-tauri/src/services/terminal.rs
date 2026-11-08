//! Persistent shells for the terminal panel: one pty per tab, its output streamed to the page as
//! base64 data frames and its keystrokes written back as they arrive.

use std::{
    collections::{HashMap, VecDeque},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

use crate::models::{TerminalFrame, TerminalOpened};
use crate::services::log;
use crate::services::paths;

mod output;

/// Ceiling on live terminals. Every session holds a pty, a shell and two threads, so this is what
/// keeps a page that opens tabs in a loop from running the process out of handles.
const MAX_SESSIONS: usize = 16;

/// Ceiling on one write, measured before the pty sees it. Input is keystrokes; anything past this
/// is a paste the page should have refused, and the pty write below it would block the caller.
pub(crate) const WRITE_LIMIT: usize = 64 * 1024;

/// Ceiling on a tab's name, as the page reads it out. A shell label plus a number is a handful of
/// characters; a page sending more than this is not naming a tab.
const LABEL_LIMIT: usize = 64;

/// Ceiling on one pty read. The pty answers with whatever it has, and a build printing faster than
/// the page can draw must not make the reader's buffer grow.
const READ_BUFFER: usize = 16 * 1024;

/// How much of a shell's output this process keeps for the agent to read back.
///
/// The page never needs it - xterm owns the scrollback and the frames are written as the flusher
/// sends them - so this exists for one caller: the `workspace_terminal` tool, which asks what the
/// shell has printed. It is a tail rather than a log on purpose: a build's first ten thousand
/// lines are not what the agent is looking at, and a bound keeps a shell that prints forever from
/// growing this process without end (owner: one session; bound: this many bytes; release: the session).
const OUTPUT_RING_BYTES: usize = 128 * 1024;
/// Maximum number of live UI/host consumers for one PTY.
const MAX_SUBSCRIBERS: usize = 8;

pub(crate) type Sink = Arc<dyn Fn(TerminalFrame) -> bool + Send + Sync + 'static>;
pub(crate) type ExitEmitter = Arc<dyn Fn(TerminalSummary, i32) + Send + Sync + 'static>;

/// Longest tail one `read` may ask for, so a caller cannot ask for the whole ring at once.
pub(crate) const READ_LIMIT: usize = 64 * 1024;

/// What a pty will accept as a grid. A panel that reports zero columns has not been laid out yet,
/// and a pty given that either refuses the frame or draws a one-column shell.
pub(crate) const MIN_DIMENSION: u16 = 2;
pub(crate) const MAX_DIMENSION: u16 = 1000;

/// The one refusal for an id this process does not know. The page reads it as an already-gone tab.
const UNKNOWN_SESSION: &str = "That terminal is not open.";

/// Whether one refusal from this module means the id names no live shell.
///
/// The service answers with a plain message (the page reads it as an already-gone tab), so this is
/// the module's own statement about which of its refusals that is - the caller that has to tell a
/// missing terminal from a pty that refused (`services::runtime::host::terminal`) asks here rather
/// than comparing the text itself.
pub(crate) fn is_unknown_session(message: &str) -> bool {
    message == UNKNOWN_SESSION
}

/// Whether two spellings name one workspace root.
///
/// The callers of this module reach it from three places that each canonicalize a little
/// differently: the page hands over a bare `canonicalize` result (no trailing separator), the
/// agent's tool and the close-by-workspace command hand over `canonicalize_workspace`'s trimmed
/// root, and the store keeps whatever it was given. Folding the separator and the case is the whole
/// of the difference that matters, and it keeps a lookup from answering "no terminal" for a shell
/// that is running right there.
fn same_workspace(left: &str, right: &str) -> bool {
    let fold = |value: &str| {
        value
            .trim_end_matches(['\\', '/'])
            .replace('/', "\\")
            .to_lowercase()
    };
    fold(left) == fold(right)
}

/// Live terminals: the pty behind every open tab, and the sequence that names them.
pub(crate) struct TerminalService {
    inner: Arc<Inner>,
}

struct Inner {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// Names the sessions. A counter never repeats an id, so a tab that was closed cannot be
    /// confused with one that opened later in its place. The id is this process's own key; what the
    /// reader and the agent call a shell is the page's tab name (`terminal_label_set`).
    sequence: AtomicU64,
    /// Serializes "find a shell to reuse or start one" (`open_for_agent`), so two callers racing for
    /// one conversation cannot both decide there is none.
    open_gate: Mutex<()>,
    exit_emitter: Mutex<Option<ExitEmitter>>,
}

/// One live shell: the pty master (resizes), its writer (keystrokes) and the child's killer.
///
/// The child and the pty reader belong to the threads that started with the session; nothing here
/// is taken unless a call needs it, and never across a pty operation, so a shell that has stopped
/// reading its input cannot block a close.
struct Session {
    id: String,
    shell: String,
    /// What the page's tab reads as (`PowerShell-2`), told to this side by `terminal_label_set`.
    ///
    /// The tab owns the number — it is the conversation's, not this process's — so this is a name
    /// carried over for the agent's `list`, never something derived here.
    label: Mutex<Option<String>>,
    /// The conversation that owns this terminal tab.
    owner_session_id: String,
    /// Canonical session file that owns this terminal tab.
    owner_session_file: String,
    /// Canonical workspace root that owns this terminal tab.
    workspace_key: String,
    /// The directory the shell was started in, as the plain path the pty was handed. It is what the
    /// agent's own tool matches a workspace against, so a session is found by where it runs rather
    /// than by an id the page invented.
    cwd: String,
    /// The tail of what this shell has printed, for the agent's read (`OUTPUT_RING_BYTES`). The page
    /// is never served from here: its frames are written as the flusher drains the buffer.
    output: Mutex<VecDeque<u8>>,
    /// Output the reader has taken from the pty but no frame has carried yet.
    ///
    /// The flusher (`output::run`) coalesces it into bounded frames, pauses while the main thread is
    /// stalled, and the reader stops taking bytes at `PENDING_LIMIT`. Owner: one session; release:
    /// the flusher takes it, and the session drops it with the pty.
    pending: output::Pending,
    /// Every live consumer of the shell's bytes, and whether it is the page's lane or the agent's.
    ///
    /// The distinction is what `watched` means: a page drawing a tab is watching the shell, while the
    /// agent's own `create` installs a sink that accepts everything and must not make its background
    /// shell look watched. Storing the kind beside the sink is what lets a page leaving be noticed
    /// even while the agent's sink is still connected.
    subscribers: Mutex<Vec<(bool, Sink)>>,
    /// Whether a page is drawing this shell right now.
    ///
    /// Derived from the page lane of [`Self::subscribers`]: set when a page attaches, recomputed when
    /// any sink is dropped. The agent attaches without setting it, so a repeated `create` reuses the
    /// background shell it started instead of piling up invisible pty's.
    watched: AtomicBool,
    /// Serializes attach replay with live broadcasts so a subscriber sees a contiguous stream.
    replay_lock: Mutex<()>,
    /// Only Windows needs this: `ChildKiller` ends the shell's own process group on unix, while
    /// Windows has to walk the tree under this pid separately.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pid: Option<u32>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

/// One live shell, as the agent's own tool reads it: enough to choose one and to talk to it.
pub(crate) struct TerminalSummary {
    pub(crate) id: String,
    /// The shell's display name, as the page draws it on the tab.
    pub(crate) shell: String,
    /// What the page's tab reads as (`PowerShell-2`), once it has told this side; the agent's own
    /// `list` shows it beside the id, so a tab the reader names is one the agent can address.
    pub(crate) label: Option<String>,
    pub(crate) cwd: String,
    pub(crate) owner_session_id: String,
    pub(crate) owner_session_file: String,
    pub(crate) workspace_key: String,
    /// Whether no page is drawing this shell right now.
    ///
    /// The one fact that tells a shell the reader is watching from a shell the agent started and left
    /// in the background: `create` reuses the latter and never the former, because taking over a tab
    /// the reader is looking at would replace their screen with the agent's.
    pub(crate) unwatched: bool,
}
impl TerminalService {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                sessions: Mutex::new(HashMap::new()),
                sequence: AtomicU64::new(0),
                open_gate: Mutex::new(()),
                exit_emitter: Mutex::new(None),
            }),
        }
    }

    pub(crate) fn set_exit_emitter(&self, emitter: ExitEmitter) {
        *lock(&self.inner.exit_emitter) = Some(emitter);
    }

    /// Start one shell in `cwd`, streaming what it prints to `sink` until it exits.
    ///
    /// The sink is called from this service's own threads - the reader for output, the waiter for
    /// the exit frame - so it has to be cheap and must not call back into the service.
    /// Starts a shell for the page's own tab (`terminal_open`): the shell is on screen from the
    /// first frame, so it is watched and the agent's `create` will not reuse it.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn open(
        &self,
        cwd: &str,
        owner_session_id: &str,
        owner_session_file: &str,
        workspace_key: &str,
        cols: u16,
        rows: u16,
        sink: Sink,
    ) -> Result<TerminalOpened, String> {
        self.open_lane(
            cwd,
            owner_session_id,
            owner_session_file,
            workspace_key,
            cols,
            rows,
            sink,
            true,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn open_lane(
        &self,
        cwd: &str,
        owner_session_id: &str,
        owner_session_file: &str,
        workspace_key: &str,
        cols: u16,
        rows: u16,
        sink: Sink,
        page: bool,
    ) -> Result<TerminalOpened, String> {
        if lock(&self.inner.sessions).len() >= MAX_SESSIONS {
            return Err("Too many terminals are open.".to_owned());
        }
        let cwd = Path::new(cwd)
            .canonicalize()
            .map_err(|_| "That working directory does not exist.".to_owned())?;
        if !cwd.is_dir() {
            return Err("That working directory is not a directory.".to_owned());
        }
        let shell = resolve_shell()?;
        let (cols, rows) = clamp_dimensions(cols, rows);
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())?;

        let mut command = CommandBuilder::new(&shell);
        // The canonical path is only its existence check: the shell is handed a plain path.
        let plain_cwd = paths::plain_process_path(&cwd);
        command.cwd(&plain_cwd);
        // The panel draws 24-bit colour and every program in the tab reads what the shell believes
        // its terminal supports, so both are set before the shell's own profile runs. Windows has
        // no TERM, and ConPTY renders for its client.
        #[cfg(unix)]
        {
            command.env("TERM", "xterm-256color");
            command.env("COLORTERM", "truecolor");
        }

        let mut child = pair.slave.spawn_command(command).map_err(|error| {
            // A tab whose shell cannot start is a failure the user only ever sees as a panel that
            // stays empty, and nothing else writes it down.
            log::warn(&format!(
                "omp: the terminal shell could not be started: {error}"
            ));
            error.to_string()
        })?;
        let killer = child.clone_killer();
        let pid = child.process_id();
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| error.to_string())?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| error.to_string())?;
        // The slave side goes before either thread runs: it is a pty handle of its own, and a
        // reader that still has one open would never see the shell's exit as EOF.
        drop(pair.slave);

        let session = Arc::new(Session {
            id: format!(
                "terminal-{}",
                self.inner.sequence.fetch_add(1, Ordering::Relaxed)
            ),
            shell: shell_label(&shell),
            label: Mutex::new(None),
            owner_session_id: owner_session_id.to_owned(),
            owner_session_file: owner_session_file.to_owned(),
            workspace_key: workspace_key.to_owned(),
            cwd: plain_cwd.to_string_lossy().into_owned(),
            output: Mutex::new(VecDeque::new()),
            pending: output::Pending::new(),
            subscribers: Mutex::new(vec![(page, sink)]),
            watched: AtomicBool::new(page),
            replay_lock: Mutex::new(()),
            pid,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
        });
        lock(&self.inner.sessions).insert(session.id.clone(), Arc::clone(&session));

        // The reader owns the output side. It never sends an exit frame: a pty read ends both when
        // the shell exits and when the pty is closed, and only the waiter can tell those apart.
        let reader_session = Arc::clone(&session);
        std::thread::Builder::new()
            .name("omp-terminal-reader".to_owned())
            .spawn(move || {
                let mut buffer = vec![0_u8; READ_BUFFER];
                loop {
                    // The window is not draining: stop taking bytes and let the shell's pipe back
                    // up. Memory stays bounded, and a build waits rather than this process growing.
                    while !reader_session.pending.is_closed() && reader_session.pending.over_limit()
                    {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    if reader_session.pending.is_closed() {
                        break;
                    }
                    let read = match reader.read(&mut buffer) {
                        Ok(read) if read > 0 => read,
                        // A read error and EOF are the same here: the stream is over either way.
                        _ => break,
                    };
                    // A shell asks its terminal where the cursor is before it prints a prompt, and
                    // blocks until the answer arrives. This process answers that query itself, for
                    // every shell, and the query is **not** forwarded to the page: xterm answers it
                    // too, and two reports for one question leave the second one on the screen as
                    // stray `R` characters. Answering here is also what makes an agent's background
                    // shell (`show:false`, no terminal at all) able to print anything.
                    let (visible, answer) = split_device_status(&buffer[..read]);
                    if let Some(answer) = answer {
                        let _ = reader_session.write_bytes(&answer);
                    }
                    // Kept before it is queued: the page's copy is the pty's own bytes, and this is
                    // the tail the agent may later ask to read.
                    reader_session.record(&visible);
                    reader_session.pending.push(&visible);
                }
                // No more output can arrive. The flusher drains what is left and leaves; the
                // waiter sends the exit frame after it has flushed too.
                reader_session.pending.close();
            })
            .map_err(|_| {
                self.discard(&session);
                "The terminal reader thread could not start.".to_owned()
            })?;

        // The flusher is what keeps a build from becoming one IPC message per pty read: it waits
        // one display frame for company, sends bounded frames, and pauses while the window is
        // stalled (`output::run`).
        let flusher_session = Arc::clone(&session);
        std::thread::Builder::new()
            .name("omp-terminal-flush".to_owned())
            .spawn(move || output::run(flusher_session))
            .map_err(|_| {
                self.discard(&session);
                "The terminal flush thread could not start.".to_owned()
            })?;

        // The waiter owns the child, so the exit frame is sent exactly once and the session leaves
        // the map once the shell is really gone.
        let waiter_inner = Arc::clone(&self.inner);
        let waiter_session = Arc::clone(&session);
        std::thread::Builder::new()
            .name("omp-terminal-wait".to_owned())
            .spawn(move || {
                let code = match child.wait() {
                    Ok(status) => status.exit_code() as i32,
                    Err(_) => -1,
                };
                waiter_session.finish(code);
                if let Some(emitter) = lock(&waiter_inner.exit_emitter).clone() {
                    emitter(waiter_session.summary(), code);
                }
                // The frame is out, so the entry is not what the page reads next: dropping it here
                // means a tab whose shell exited is one the page can open again. The map lock is
                // taken after the sink returned and is never held across a kill.
                lock(&waiter_inner.sessions).remove(&waiter_session.id);
            })
            .map_err(|_| {
                self.discard(&session);
                "The terminal waiter thread could not start.".to_owned()
            })?;

        Ok(TerminalOpened {
            id: session.id.clone(),
            shell: session.shell.clone(),
            owner_session_id: session.owner_session_id.clone(),
            owner_session_file: session.owner_session_file.clone(),
            workspace_key: session.workspace_key.clone(),
            cwd: session.cwd.clone(),
        })
    }

    /// Attaches the page's lane: the shell is on screen, so the agent's `create` will not take it
    /// over.
    pub(crate) fn attach(&self, id: &str, sink: Sink) -> Result<TerminalOpened, String> {
        self.attach_lane(id, sink, true)
    }

    /// Attaches the agent's lane: it receives output, but it is not a page watching the shell.
    ///
    /// `open_for_agent` reuses a background shell through this; marking it watched there would make
    /// the next `create` believe the reader is looking at it and start another one, which is exactly
    /// the pile of invisible shells the reuse rule exists to prevent.
    pub(crate) fn attach_agent(&self, id: &str, sink: Sink) -> Result<TerminalOpened, String> {
        self.attach_lane(id, sink, false)
    }

    fn attach_lane(&self, id: &str, sink: Sink, page: bool) -> Result<TerminalOpened, String> {
        let session = self.session(id)?;
        let _replay_guard = lock(&session.replay_lock);
        // Output that was read but not yet sent belongs in the replay: the new subscriber must see
        // it exactly once, and the subscribers already attached must not wait for it behind the
        // replay. Sending it first leaves the ring (which already recorded it) as the new
        // subscriber's only copy.
        let pending = session.pending.take();
        if !pending.is_empty() {
            session.broadcast_locked(TerminalFrame::Data {
                data: STANDARD.encode(pending),
            });
        }
        let replay = {
            let ring = lock(&session.output);
            ring.iter().copied().collect::<Vec<u8>>()
        };
        let mut subscribers = lock(&session.subscribers);
        if subscribers.len() >= MAX_SUBSCRIBERS {
            return Err("Too many terminal subscribers are open.".to_owned());
        }
        let replay_sink = Arc::clone(&sink);
        subscribers.push((page, sink));
        if page {
            session.watched.store(true, Ordering::Relaxed);
        }
        drop(subscribers);
        if !replay.is_empty()
            && !replay_sink(TerminalFrame::Data {
                data: STANDARD.encode(replay),
            })
        {
            let mut subscribers = lock(&session.subscribers);
            subscribers.retain(|(_, candidate)| !Arc::ptr_eq(candidate, &replay_sink));
            session
                .watched
                .store(subscribers.iter().any(|(page, _)| *page), Ordering::Relaxed);
            return Err("The terminal subscriber is no longer connected.".to_owned());
        }
        Ok(TerminalOpened {
            id: session.id.clone(),
            shell: session.shell.clone(),
            owner_session_id: session.owner_session_id.clone(),
            owner_session_file: session.owner_session_file.clone(),
            workspace_key: session.workspace_key.clone(),
            cwd: session.cwd.clone(),
        })
    }

    /// Name one shell what the page's tab reads as (`PowerShell-2`).
    ///
    /// The page is the one that owns the number — it is the conversation's, allocated by the strip
    /// and reused once a tab is closed — so this side only carries the name for the agent's `list`.
    /// A shell that is gone is refused the way every other operation on it is: the page writing a
    /// label it computed before the shell exited is not an error worth reporting anywhere.
    pub(crate) fn set_label(&self, id: &str, label: &str) -> Result<(), String> {
        if label.is_empty() || label.chars().count() > LABEL_LIMIT {
            return Err("That terminal name is not valid.".to_owned());
        }
        let session = self.session(id)?;
        *lock(&session.label) = Some(label.to_owned());
        Ok(())
    }

    /// Write one batch of input into a shell. `data` is already decoded: the command layer owns the
    /// base64 boundary, so this is the only place that measures what the pty actually receives.
    pub(crate) fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        if data.len() > WRITE_LIMIT {
            return Err("That terminal input is too large.".to_owned());
        }
        let session = self.session(id)?;
        let mut writer = lock(&session.writer);
        writer
            .write_all(data)
            .and_then(|()| writer.flush())
            .map_err(|_| "The terminal could not be written to.".to_owned())
    }

    /// Resize one shell's pty. The page reports the panel's character grid, so both dimensions are
    /// clamped exactly as they are on an open.
    pub(crate) fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let (cols, rows) = clamp_dimensions(cols, rows);
        let session = self.session(id)?;
        let resized = lock(&session.master).resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
        resized.map_err(|_| "The terminal could not be resized.".to_owned())
    }

    /// End one shell. An id this process does not know is a refusal the page reads as "already
    /// gone", which is what a close racing the shell's own exit looks like.
    pub(crate) fn close(&self, id: &str) -> Result<(), String> {
        // The map lock is released at the end of this statement, before the kill below.
        let session = lock(&self.inner.sessions)
            .remove(id)
            .ok_or_else(|| UNKNOWN_SESSION.to_owned())?;
        session.kill();
        Ok(())
    }

    /// End every shell owned by one conversation. The map is filtered and drained atomically;
    /// killing happens after the lock is released.
    pub(crate) fn close_by_session(&self, owner_session_id: &str) {
        let sessions: Vec<Arc<Session>> = {
            let mut live = lock(&self.inner.sessions);
            let ids: Vec<String> = live
                .iter()
                .filter(|(_, session)| session.owner_session_id == owner_session_id)
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter().filter_map(|id| live.remove(&id)).collect()
        };
        for session in sessions {
            session.kill();
        }
    }

    /// End every shell owned by one canonical workspace. The map is filtered and drained
    /// atomically; killing happens after the lock is released.
    pub(crate) fn close_by_workspace(&self, workspace_key: &str) {
        let sessions: Vec<Arc<Session>> = {
            let mut live = lock(&self.inner.sessions);
            let ids: Vec<String> = live
                .iter()
                .filter(|(_, session)| session.workspace_key == workspace_key)
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter().filter_map(|id| live.remove(&id)).collect()
        };
        for session in sessions {
            session.kill();
        }
    }

    /// End every shell. Called once, as the application exits: these shells are this process's own
    /// children, so nothing else will end them.
    pub(crate) fn shutdown_all(&self) {
        let sessions: Vec<Arc<Session>> = lock(&self.inner.sessions)
            .drain()
            .map(|(_, session)| session)
            .collect();
        for session in sessions {
            session.kill();
        }
    }

    /// The one way to reach a live session: the map lock is held only long enough to clone the
    /// `Arc`, so no caller holds it across a pty write, a resize or a kill.
    fn session(&self, id: &str) -> Result<Arc<Session>, String> {
        lock(&self.inner.sessions)
            .get(id)
            .cloned()
            .ok_or_else(|| UNKNOWN_SESSION.to_owned())
    }

    /// Every live shell owned by one conversation, in a stable order.
    ///
    /// This is how the agent finds "the terminal in this workspace": the page names its tabs, but
    /// the id it invents means nothing here, and the conversation's own session file is the one key
    /// both sides already agree about. A conversation owns one shell, and ownership is the
    /// conversation rather than the directory: two conversations opened in one workspace each have
    /// their own terminal.
    ///
    /// The workspace is only a coarse filter here, because the caller spells it with or without a
    /// trailing separator (`canonicalize_workspace` trims it, a bare `canonicalize` does not). The
    /// session file is the precise key and is compared exactly.
    pub(crate) fn list(
        &self,
        workspace_key: &str,
        owner_session_file: &str,
    ) -> Vec<TerminalSummary> {
        self.list_live_by_owner(owner_session_file, workspace_key)
    }

    /// Return only shells owned by the exact session file and workspace root.
    pub(crate) fn list_live_by_owner(
        &self,
        owner_session_file: &str,
        workspace_key: &str,
    ) -> Vec<TerminalSummary> {
        self.live_by_owner(owner_session_file, workspace_key)
    }

    fn live_by_owner(&self, owner_session_file: &str, workspace_key: &str) -> Vec<TerminalSummary> {
        let mut found: Vec<TerminalSummary> = lock(&self.inner.sessions)
            .values()
            .filter(|session| {
                session.owner_session_file == owner_session_file
                    && same_workspace(&session.workspace_key, workspace_key)
            })
            .map(|session| session.summary())
            .collect();
        found.sort_by(|left, right| left.id.cmp(&right.id));
        found
    }

    /// Start a shell for the agent, reusing one only when it has no viewer at all.
    ///
    /// A conversation may now own several terminals (the reader's tabs), so "the conversation's
    /// shell" is no longer a single thing: `create` must not hijack a shell the reader is looking at,
    /// and it must not spawn a second one beside a shell it already started and nobody is watching.
    /// A viewer is what distinguishes the two: the page attaches a sink when it draws a tab, and a
    /// shell created by the agent has no page attached until the agent's `create` shows it. So the
    /// reuse condition is *no viewer*, and everything else starts a new shell — atomically, because
    /// two `create` calls (or a `create` racing the page's own open) would otherwise both find none.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn open_for_agent(
        &self,
        cwd: &str,
        owner_session_id: &str,
        owner_session_file: &str,
        workspace_key: &str,
        cols: u16,
        rows: u16,
        sink: Sink,
    ) -> Result<(TerminalOpened, bool), String> {
        let _gate = lock(&self.inner.open_gate);
        if let Some(existing) = self
            .live_by_owner(owner_session_file, workspace_key)
            .into_iter()
            .find(|summary| summary.unwatched)
        {
            let opened = self.attach_agent(&existing.id, sink)?;
            return Ok((opened, true));
        }
        self.open_lane(
            cwd,
            owner_session_id,
            owner_session_file,
            workspace_key,
            cols,
            rows,
            sink,
            false,
        )
        .map(|opened| (opened, false))
    }

    /// The last `limit` bytes of one shell's output, as text.
    ///
    /// The tail rather than the whole ring, because that is what a reader means by "what is on the
    /// screen", and the limit is clamped so no caller can ask for more than the ring holds.
    pub(crate) fn read(&self, id: &str, limit: usize) -> Result<String, String> {
        let session = self.session(id)?;
        let limit = limit.clamp(1, READ_LIMIT);
        let tail: Vec<u8> = {
            let ring = lock(&session.output);
            let skip = ring.len().saturating_sub(limit);
            ring.iter().skip(skip).copied().collect()
        };
        Ok(plain_text(&tail))
    }

    /// The raw tail of what this shell has printed, for a view that has to rebuild itself.
    ///
    /// `read` answers the agent in plain text; a terminal view needs the bytes exactly as the pty
    /// wrote them (escape sequences included), so this is the same ring under the same bound with no
    /// rewriting. Only a view whose buffer has gone calls it — it is a repair, not a second stream.
    pub(crate) fn tail(&self, id: &str, limit: usize) -> Result<Vec<u8>, String> {
        let session = self.session(id)?;
        let limit = limit.clamp(1, READ_LIMIT);
        let ring = lock(&session.output);
        let skip = ring.len().saturating_sub(limit);
        Ok(ring.iter().skip(skip).copied().collect())
    }

    /// Drop a session that never got its threads, and end the shell behind it. Nothing else knows
    /// the id yet, so the entry would outlive its only user.
    fn discard(&self, session: &Session) {
        lock(&self.inner.sessions).remove(&session.id);
        session.kill();
    }
}

impl Session {
    fn summary(&self) -> TerminalSummary {
        TerminalSummary {
            id: self.id.clone(),
            shell: self.shell.clone(),
            label: lock(&self.label).clone(),
            cwd: self.cwd.clone(),
            owner_session_id: self.owner_session_id.clone(),
            owner_session_file: self.owner_session_file.clone(),
            workspace_key: self.workspace_key.clone(),
            unwatched: !self.watched.load(Ordering::Relaxed),
        }
    }

    /// Sends what is queued, then the exit frame, under one replay lock.
    ///
    /// The order is the contract: a subscriber sees the shell's last output before the line that
    /// says it exited. Closing the pending buffer after this frame stops the flusher from sending
    /// after it; the reader has already seen EOF by the time the child is reaped in the ordinary
    /// case.
    fn finish(&self, code: i32) {
        let _replay_guard = lock(&self.replay_lock);
        let bytes = self.pending.take();
        if !bytes.is_empty() {
            self.broadcast_locked(TerminalFrame::Data {
                data: STANDARD.encode(bytes),
            });
        }
        self.broadcast_locked(TerminalFrame::Exit { code });
        self.pending.close();
    }

    /// Sends one frame to every live subscriber. The caller holds `replay_lock`, which is what
    /// keeps a live frame from overtaking an attach's replay.
    fn broadcast_locked(&self, frame: TerminalFrame) {
        let mut subscribers = lock(&self.subscribers);
        let before = subscribers.len();
        subscribers.retain(|(_, sink)| sink(frame.clone()));
        // A sink that refused the frame is a consumer that closed. The agent's own sink never
        // refuses, so a drop here is the page leaving; `watched` is the page lane's answer, not the
        // whole list's, so it is recomputed even when the agent's sink is still connected.
        if subscribers.len() != before {
            self.watched
                .store(subscribers.iter().any(|(page, _)| *page), Ordering::Relaxed);
        }
    }

    /// Test seam: one live frame through the same lock the flusher takes.
    #[cfg(test)]
    fn broadcast(&self, frame: TerminalFrame) {
        let _replay_guard = lock(&self.replay_lock);
        self.broadcast_locked(frame);
    }

    /// End the shell and whatever it started. `ChildKiller` covers the shell itself (and its
    /// process group on unix); Windows needs the extra pass below for whatever the shell started,
    /// and that pass runs **first**: `taskkill /T` expands the tree from the pid it is given, so
    /// once the shell is gone the tree cannot be walked and its children keep running - the dev
    /// server that outlived the tab that started it.
    fn kill(&self) {
        self.pending.close();
        #[cfg(target_os = "windows")]
        kill_process_tree(self.pid);
        let _ = lock(&self.killer).kill();
    }

    /// Keeps the tail of what this shell printed, dropping the oldest bytes once it is over the
    /// bound. Called from the pty reader thread, so it takes no other lock and never blocks on one.
    fn record(&self, data: &[u8]) {
        let mut ring = lock(&self.output);
        ring.extend(data.iter().copied());
        let excess = ring.len().saturating_sub(OUTPUT_RING_BYTES);
        if excess > 0 {
            ring.drain(..excess);
        }
    }

    /// Write straight into the shell, for this process's own answer to a device-status query.
    ///
    /// Called from the pty reader thread, so it takes only the writer lock and never touches the
    /// subscriber list: the answer belongs to the shell, not to the page, and a reader that is not
    /// looking must not be able to make it fail.
    fn write_bytes(&self, data: &[u8]) -> Result<(), String> {
        let mut writer = lock(&self.writer);
        writer
            .write_all(data)
            .and_then(|()| writer.flush())
            .map_err(|_| "The terminal could not be written to.".to_owned())
    }
}

/// One chunk of pty output as the text a reader would see: escape sequences removed, and the
/// carriage returns that only redraw a line dropped.
///
/// It is a scanner rather than a terminal emulator, and it is deliberately forgiving: an escape
/// sequence cut in half by the tail of the ring is dropped rather than guessed at, and a byte
/// sequence that is not valid UTF-8 becomes the replacement character instead of being refused -
/// the alternative is an agent that cannot read a shell's output because one program printed a
/// stray byte.
pub(crate) fn plain_text(bytes: &[u8]) -> String {
    let mut kept: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == 0x1b {
            index = skip_escape(bytes, index);
            continue;
        }
        // Printable bytes, and the two whitespace ones a screen keeps: `\r` moves the cursor back to
        // the start of the line, which no text reader can show, and the rest of C0 is a control the
        // terminal acts on rather than something printed.
        if byte >= 0x20 || byte == b'\n' || byte == b'\t' {
            kept.push(byte);
        }
        index += 1;
    }
    String::from_utf8_lossy(&kept).into_owned()
}

/// Splits one pty read into what the screen should see and the answer a shell is waiting for.
///
/// A shell asks its terminal where the cursor is (`ESC[6n`) before printing a prompt and blocks until
/// the report comes back. That question is answered **here, once, for every shell**: xterm would
/// answer it too, and a shell that receives two reports leaves the extra one on the screen as stray
/// characters. Removing the query from the stream the page receives is what keeps the answer count at
/// one, and it is also what lets a terminal nobody is looking at — the agent's background shell, or
/// one whose tab was closed — print anything at all.
///
/// Only `ESC[6n` is handled: it is the one query a shell blocks on before it can do anything. Every
/// other query a program may make stays in the stream for the viewer, which is the only side that
/// knows the real screen.
///
/// The answer is `ESC[1;1R` — "row 1, column 1" — which is where a fresh pty's cursor is.
fn split_device_status(bytes: &[u8]) -> (Vec<u8>, Option<Vec<u8>>) {
    const QUERY: &[u8] = b"\x1b[6n";
    let mut visible = Vec::with_capacity(bytes.len());
    let mut answer: Option<Vec<u8>> = None;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index..].starts_with(QUERY) {
            index += QUERY.len();
            answer
                .get_or_insert_with(Vec::new)
                .extend_from_slice(b"\x1b[1;1R");
            continue;
        }
        visible.push(bytes[index]);
        index += 1;
    }
    (visible, answer)
}

/// The index just past the escape sequence that begins at `start` (an ESC byte).
///
/// The four shapes a pty actually emits are handled - CSI, OSC, the DCS/SOS/PM/APC strings, and the
/// two-byte sequences - and anything else is treated as the two bytes it looks like, which keeps a
/// malformed sequence from swallowing the rest of the output.
fn skip_escape(bytes: &[u8], start: usize) -> usize {
    let Some(next) = bytes.get(start + 1) else {
        return bytes.len();
    };
    match next {
        // CSI: parameters, then one final byte in 0x40..=0x7e.
        b'[' => {
            let mut index = start + 2;
            while index < bytes.len() {
                let byte = bytes[index];
                index += 1;
                if (0x40..=0x7e).contains(&byte) {
                    break;
                }
            }
            index
        }
        // OSC: a string ended by BEL or by ST (`ESC \`).
        b']' => {
            let mut index = start + 2;
            while index < bytes.len() {
                if bytes[index] == 0x07 {
                    return index + 1;
                }
                if bytes[index] == 0x1b && bytes.get(index + 1) == Some(&b'\\') {
                    return index + 2;
                }
                index += 1;
            }
            bytes.len()
        }
        // DCS / SOS / PM / APC: a string ended by ST only.
        b'P' | b'X' | b'^' | b'_' => {
            let mut index = start + 2;
            while index < bytes.len() {
                if bytes[index] == 0x1b && bytes.get(index + 1) == Some(&b'\\') {
                    return index + 2;
                }
                index += 1;
            }
            bytes.len()
        }
        // A two-byte sequence (`ESC ( B`, `ESC =`, …), or an ESC at the very end of the buffer.
        _ => start + 2,
    }
}

/// The one lock discipline of this module: a poisoned lock is not a reason to take the application
/// down, because every holder only touches short-lived session state.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Both dimensions as the pty may see them.
fn clamp_dimensions(cols: u16, rows: u16) -> (u16, u16) {
    (
        cols.clamp(MIN_DIMENSION, MAX_DIMENSION),
        rows.clamp(MIN_DIMENSION, MAX_DIMENSION),
    )
}

/// The shell to start on this machine, as the pty has to receive it: an absolute path.
fn resolve_shell() -> Result<PathBuf, String> {
    resolve_shell_candidate()
        .ok_or_else(|| "No usable shell was found for the terminal.".to_owned())
}

#[cfg(target_os = "windows")]
fn resolve_shell_candidate() -> Option<PathBuf> {
    // PowerShell 7 where this machine has it, then Windows PowerShell, then COMSPEC, then cmd.exe.
    // The System32 paths back the two PowerShell names and cmd up for a stripped-down PATH (a
    // service account, a CI runner), where the search below cannot see a shell that is there.
    let system_root = std::env::var_os("SystemRoot").map(PathBuf::from);
    let in_system32 = |relative: &str| -> Option<PathBuf> {
        let candidate = system_root.as_ref()?.join("System32").join(relative);
        candidate.is_file().then_some(candidate)
    };

    find_on_path("pwsh.exe")
        .or_else(|| find_on_path("powershell.exe"))
        .or_else(|| in_system32("WindowsPowerShell/v1.0/powershell.exe"))
        .or_else(|| {
            // COMSPEC is only trusted when it names a file outright: a bare name would reach the
            // pty spawn unresolved.
            let comspec = PathBuf::from(std::env::var_os("ComSpec")?);
            (comspec.is_absolute() && comspec.is_file()).then_some(comspec)
        })
        .or_else(|| find_on_path("cmd.exe"))
        .or_else(|| in_system32("cmd.exe"))
}

#[cfg(unix)]
fn resolve_shell_candidate() -> Option<PathBuf> {
    // The user's own shell first: the tab is theirs, and `$SHELL` is what they chose. It has to be
    // absolute and executable, because that is the path the pty is handed.
    if let Some(shell) = std::env::var_os("SHELL") {
        let shell = PathBuf::from(shell);
        if shell.is_absolute() && is_executable(&shell) {
            return Some(shell);
        }
    }
    ["/bin/zsh", "/bin/bash", "/bin/sh"]
        .into_iter()
        .map(PathBuf::from)
        .find(|shell| is_executable(shell))
}

/// One executable found by walking `PATH` (`;`-separated on Windows, `:` elsewhere, which is what
/// `split_paths` reads). A bare name means nothing to the pty spawn, so the search is done here.
#[cfg(target_os = "windows")]
fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
}

/// Whether this process may execute `path`: the pty spawn hands the path to the kernel, so a file
/// without the execute bit would fail the open after a pty was already created.
#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    match std::fs::metadata(path) {
        Ok(metadata) => metadata.is_file() && metadata.permissions().mode() & 0o111 != 0,
        Err(_) => false,
    }
}

/// The label the page draws on the tab. `file_stem` already drops the extension, and `pwsh` and
/// `powershell` are the same product to the user; `cmd` is already its own name.
///
/// A path with no readable stem is a shell this process cannot name, and the tab says so rather than
/// drawing a word that reads like a product ("Shell") — the reader would have no way to tell that
/// label from a real shell called that.
fn shell_label(path: &Path) -> String {
    let Some(stem) = path.file_stem().and_then(std::ffi::OsStr::to_str) else {
        return "Terminal".to_owned();
    };
    if stem.eq_ignore_ascii_case("pwsh") || stem.eq_ignore_ascii_case("powershell") {
        "PowerShell".to_owned()
    } else if stem.is_empty() {
        "Terminal".to_owned()
    } else {
        stem.to_owned()
    }
}

/// End the tree under one pid. Windows has no process group to signal: a shell that started a
/// build, an editor or a REPL would leave those grandchildren running after the tab is closed.
/// `taskkill /T` walks the tree by parent pid and `/F` makes it immediate; its window is hidden so
/// a closing tab never flashes a console, and its exit status is not this process's to report.
#[cfg(target_os = "windows")]
fn kill_process_tree(pid: Option<u32>) {
    use std::{
        os::windows::process::CommandExt,
        process::{Command, Stdio},
    };

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let Some(pid) = pid else {
        return;
    };
    let pid = pid.to_string();
    let _ = Command::new("taskkill")
        .args(["/PID", pid.as_str(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

#[cfg(test)]
mod tests;
