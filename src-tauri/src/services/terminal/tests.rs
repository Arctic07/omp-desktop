//! The terminal service's tests: pty lifecycle, the page/agent lanes, and the agent's own view.
//!
//! Split out of `terminal.rs` so that file stays under the repository's line bound.

use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use super::*;

/// A sink that keeps every frame, and the buffer it keeps them in.
fn collector() -> (Sink, Arc<Mutex<Vec<TerminalFrame>>>) {
    let frames = Arc::new(Mutex::new(Vec::new()));
    let sink_frames = Arc::clone(&frames);
    let sink: Sink = Arc::new(move |frame| {
        lock(&sink_frames).push(frame);
        true
    });
    (sink, frames)
}

/// Everything the shell has printed so far, decoded back from the frames' base64.
fn collected_text(frames: &Mutex<Vec<TerminalFrame>>) -> String {
    lock(frames)
        .iter()
        .filter_map(|frame| match frame {
            TerminalFrame::Data { data } => STANDARD.decode(data).ok(),
            TerminalFrame::Exit { .. } => None,
        })
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .collect()
}

/// What a shell's output reduces to when the agent reads it: escape sequences gone, carriage
/// returns gone, and everything else - including multi-byte characters - left exactly as it was.
#[test]
fn plain_text_keeps_what_the_screen_shows_and_drops_the_rest() {
    assert_eq!(plain_text(b"hello\nworld"), "hello\nworld");
    assert_eq!(plain_text(b"a\tb"), "a\tb");
    // Colour, an erase, and the title a shell sets: all gone, the text between them kept.
    assert_eq!(plain_text(b"\x1b[31mred\x1b[0m"), "red");
    assert_eq!(plain_text(b"\x1b[2J\x1b[Hclear"), "clear");
    assert_eq!(plain_text(b"\x1b]0;title\x07body"), "body");
    assert_eq!(plain_text(b"\x1b]0;title\x1b\\body"), "body");
    assert_eq!(plain_text(b"\x1bPpayload\x1b\\after"), "after");
    // A two-byte sequence is just that: the byte after it is text, not part of it.
    assert_eq!(plain_text(b"\x1b=text"), "text");
    assert_eq!(plain_text(b"\x1b(Btext"), "Btext");
    assert_eq!(plain_text("终端".as_bytes()), "终端");
    // A progress line's carriage return goes, so what is left is what was drawn over.
    assert_eq!(plain_text(b"1%\r50%\r100%\n"), "1%50%100%\n");
    // Bytes that are not UTF-8 are replaced rather than refused: a stray byte is not a reason
    // for an agent to see nothing at all.
    assert_eq!(plain_text(&[0x61, 0xff, 0x62]), "a\u{fffd}b");
    // A sequence cut in half by the tail of the ring is dropped, not guessed at.
    assert_eq!(plain_text(b"\x1b[3"), "");
    assert_eq!(plain_text(b"before\x1b"), "before");
}

/// What the panel does with a tab: open a shell, type a command into it, read the answer off
/// the frame stream, then close it. The write is the raw bytes of a command line, because that
/// is what the page sends once its base64 has been decoded.
///
/// Nothing in this test answers the shell's cursor query: the service does it, which is what lets
/// a shell nobody is looking at print a prompt at all. A run that had to answer the query itself
/// would be testing the terminal client, not the service.
#[test]
fn a_shell_answers_a_command_and_leaves_nothing_behind() {
    let service = TerminalService::new();
    let (sink, frames) = collector();
    let cwd = std::env::temp_dir();
    let opened = service
        .open(
            &cwd.to_string_lossy(),
            "test-session",
            &cwd.to_string_lossy(),
            &cwd.to_string_lossy(),
            80,
            24,
            sink,
        )
        .expect("a shell on this machine");

    assert!(opened.id.starts_with("terminal-"));
    assert!(!opened.shell.is_empty(), "the tab draws a shell label");

    service
        .write(&opened.id, b"echo omp-terminal-ready\r\n")
        .expect("the shell accepts input");

    let deadline = Instant::now() + Duration::from_secs(15);
    let mut printed = false;
    while Instant::now() < deadline {
        if collected_text(&frames).contains("omp-terminal-ready") {
            printed = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(printed, "the shell's answer arrives as data frames");
    // The prompt comes before the answer, so it is in hand by now: it names the plain
    // directory, not the verbatim form (which PowerShell prints as a provider path).
    let text = collected_text(&frames);
    let plain = paths::plain_process_path(&cwd.canonicalize().expect("the temp dir exists"));
    assert!(
        text.contains(plain.to_string_lossy().as_ref()),
        "the prompt names the directory the shell was given"
    );
    assert!(
        !text.contains(r"\\?\"),
        "no verbatim path reaches the shell"
    );

    service.close(&opened.id).expect("the shell closes");
    service.shutdown_all();
    assert_eq!(
        lock(&service.inner.sessions).len(),
        0,
        "no session outlives the shutdown"
    );
}

/// A burst of shell output crosses IPC in a few frames, not one per pty read.
///
/// The regression this guards was measured 2026-11-03: every 16 KiB pty read was its own channel
/// frame, so a terminal build put one main-thread `eval` and one `RedrawWindow` per read in flight,
/// stalled the window for 42.6 s, and made the host look wedged to the liveness probe. The bytes
/// still have to arrive exactly once and in order; only the frame count is what changed.
///
/// The producer is Node because it writes megabytes without a shell-specific loop; the repository
/// already requires Node to build the frontend. A machine without it skips this scenario rather
/// than failing the terminal suite.
#[test]
fn a_burst_of_shell_output_is_coalesced_without_losing_bytes() {
    if std::process::Command::new("node")
        .arg("--version")
        .output()
        .is_err()
    {
        return;
    }
    let service = TerminalService::new();
    let (sink, frames) = collector();
    let cwd = std::env::temp_dir();
    let opened = service
        .open(
            &cwd.to_string_lossy(),
            "test-session",
            &cwd.to_string_lossy(),
            &cwd.to_string_lossy(),
            80,
            24,
            sink,
        )
        .expect("a shell on this machine");

    // Four megabytes, then a marker the command line does not contain as one word: the shell
    // echoes the typed line, and a literal marker would be read from that echo before the output
    // arrived.
    let bytes = 4 * 1024 * 1024;
    let command = format!(
        "node -e \"process.stdout.write('x'.repeat({bytes})); console.log('omp-'+'burst-done')\"\r\n"
    );
    service
        .write(&opened.id, command.as_bytes())
        .expect("the shell accepts input");

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut printed = false;
    while Instant::now() < deadline {
        // Only the tail is decoded while waiting: the full transcript is megabytes, and scanning
        // it once per poll would make this test measure its own copy.
        let tail = {
            let frames = lock(&frames);
            let start = frames.len().saturating_sub(4);
            frames[start..]
                .iter()
                .filter_map(|frame| match frame {
                    TerminalFrame::Data { data } => STANDARD.decode(data).ok(),
                    TerminalFrame::Exit { .. } => None,
                })
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                .collect::<String>()
        };
        if tail.contains("omp-burst-done") {
            printed = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(printed, "the burst's end arrives");

    let text = collected_text(&frames);
    assert!(
        text.matches('x').count() >= bytes,
        "every byte of the burst reaches the page"
    );
    let data_frames = lock(&frames)
        .iter()
        .filter(|frame| matches!(frame, TerminalFrame::Data { .. }))
        .count();
    assert!(
        data_frames < 100,
        "the burst crosses IPC in {data_frames} frames; one frame per 16 KiB read would be over 250"
    );

    service.close(&opened.id).expect("the shell closes");
    service.shutdown_all();
}

/// Closing a tab ends what the shell started. A tab that ran a build or a dev server must not
/// leave it behind, and Windows is where that is easy to get wrong: the pty hands out no process
/// group to signal, so the tree is walked from the shell's own pid (`taskkill /T`) - which only
/// finds anything while that pid still names the shell.
#[cfg(target_os = "windows")]
#[test]
fn closing_a_shell_ends_the_program_it_started() {
    let service = TerminalService::new();
    let (sink, frames) = collector();
    let cwd = std::env::temp_dir();
    let opened = service
        .open(
            &cwd.to_string_lossy(),
            "test-session",
            &cwd.to_string_lossy(),
            &cwd.to_string_lossy(),
            80,
            24,
            sink,
        )
        .expect("a shell on this machine");

    // One program of the shell's own, started the way a tab running a server does, and its pid
    // printed so the test can look for it afterwards.
    service
        .write(
            &opened.id,
            b"$child = Start-Process -FilePath 'ping.exe' -ArgumentList '-n','120','127.0.0.1' -PassThru -NoNewWindow; \"OMP-CHILD-PID=$($child.Id)\"\r\n",
        )
        .expect("the shell accepts input");

    let deadline = Instant::now() + Duration::from_secs(20);
    let mut child = None;
    while Instant::now() < deadline && child.is_none() {
        let text = collected_text(&frames);
        // The typed line is echoed with syntax highlighting before it runs, so the marker is in
        // the stream twice: only the occurrence followed by digits is the answer.
        child = text.split("OMP-CHILD-PID=").skip(1).find_map(|tail| {
            let digits: String = tail.chars().take_while(char::is_ascii_digit).collect();
            digits.parse::<u32>().ok()
        });
        if child.is_none() {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    let child = match child {
        Some(child) => child,
        None => panic!(
            "the shell reports the pid of the program it started; it printed: {:?}",
            collected_text(&frames)
        ),
    };
    assert!(process_is_alive(child), "the program runs before the close");

    service.close(&opened.id).expect("the shell closes");

    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && process_is_alive(child) {
        std::thread::sleep(Duration::from_millis(100));
    }
    let alive = process_is_alive(child);
    if alive {
        // A failed assertion must not leave a two-minute ping behind for the next run.
        let _ = std::process::Command::new(system32("taskkill.exe"))
            .args(["/PID", &child.to_string(), "/F"])
            .status();
    }
    assert!(
        !alive,
        "the program the shell started is gone with the tab that started it"
    );

    service.shutdown_all();
}

/// Whether one pid names a running process, as the task list reports it.
#[cfg(target_os = "windows")]
fn process_is_alive(pid: u32) -> bool {
    let output = std::process::Command::new(system32("tasklist.exe"))
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .expect("the task list can be read");
    String::from_utf8_lossy(&output.stdout).contains(&pid.to_string())
}

/// One Windows tool, by its system path: a test inherits whatever `PATH` the harness gave it.
#[cfg(target_os = "windows")]
fn system32(tool: &str) -> std::path::PathBuf {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_owned());
    std::path::Path::new(&root).join("System32").join(tool)
}

/// Every operation the page can aim at a tab it no longer has. Each one is refused, and the
/// close is the refusal the page reads as "already gone".
#[test]
fn operations_on_an_unknown_terminal_are_refused() {
    let service = TerminalService::new();
    assert!(service.write("terminal-404", b"x").is_err());
    assert!(service.resize("terminal-404", 80, 24).is_err());
    assert!(service.close("terminal-404").is_err());
    assert!(service.read("terminal-404", 1024).is_err());
    assert!(is_unknown_session("That terminal is not open."));
    assert!(!is_unknown_session("The terminal could not be written to."));
}

/// The shell's cursor query is answered here and removed from what the page receives.
///
/// Two facts at once: the answer is one report per query (a second one would be left on the screen
/// as a stray `R`), and the query itself never reaches a terminal that would answer it again.
#[test]
fn a_device_status_query_is_answered_here_and_not_forwarded() {
    // Nothing to answer: the bytes are the page's, untouched.
    let (visible, answer) = split_device_status(b"hello\n");
    assert_eq!(visible, b"hello\n");
    assert!(answer.is_none());

    // One query: the report goes back, the query does not go forward.
    let (visible, answer) = split_device_status(b"before\x1b[6nafter");
    assert_eq!(visible, b"beforeafter");
    assert_eq!(answer.as_deref(), Some(&b"\x1b[1;1R"[..]));

    // Two queries in one read are answered twice, in order.
    let (visible, answer) = split_device_status(b"\x1b[6n\x1b[6n");
    assert!(visible.is_empty());
    assert_eq!(answer.as_deref(), Some(&b"\x1b[1;1R\x1b[1;1R"[..]));

    // A query split across two reads is not a query: the first half stays as the page's bytes,
    // and the second half cannot complete it. The shell asks again on its own timer, and a
    // half-answer would be worse than none.
    let (visible, answer) = split_device_status(b"\x1b[");
    assert_eq!(visible, b"\x1b[");
    assert!(answer.is_none());
}

/// The agent's own view of a tab: the shell is found by the directory it runs in - not by an id
/// the page invented - and what it has printed can be read back as text.
#[test]
fn a_shell_is_listed_by_its_directory_and_its_output_can_be_read() {
    let service = TerminalService::new();
    let (sink, frames) = collector();
    let cwd = std::env::temp_dir();
    let opened = service
        .open(
            &cwd.to_string_lossy(),
            "test-session",
            &cwd.to_string_lossy(),
            &cwd.to_string_lossy(),
            80,
            24,
            sink,
        )
        .expect("a shell on this machine");

    let found = service.list(&cwd.to_string_lossy(), &cwd.to_string_lossy());
    assert_eq!(found.len(), 1, "the one shell this service holds");
    assert_eq!(found[0].id, opened.id);
    assert_eq!(found[0].shell, opened.shell);
    assert!(
        service
            .list(
                &cwd.join("omp-terminal-missing").to_string_lossy(),
                &cwd.to_string_lossy(),
            )
            .is_empty(),
        "a directory that cannot be resolved lists nothing"
    );

    service
        .write(&opened.id, b"echo omp-terminal-readback\r\n")
        .expect("the shell accepts input");

    let deadline = Instant::now() + Duration::from_secs(15);
    let mut printed = false;
    while Instant::now() < deadline {
        if collected_text(&frames).contains("omp-terminal-readback") {
            printed = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(printed, "the shell answers");

    // What the agent reads is the same output as text: the line is there, and the escape
    // sequences and carriage returns a screen would have acted on are not.
    let read = service
        .read(&opened.id, READ_LIMIT)
        .expect("a live terminal");
    assert!(read.contains("omp-terminal-readback"), "{read}");
    assert!(!read.contains('\u{1b}'), "escape sequences are removed");
    assert!(!read.contains('\r'), "carriage returns are removed");

    service.close(&opened.id).expect("the shell closes");
    service.shutdown_all();
}

/// A cwd that is not a directory: the shell would start somewhere that cannot exist, so the
/// open is refused before a pty is created and nothing is left in the map.
/// A page leaving closes its lane even while the agent's sink is still connected.
///
/// Before the kind was stored beside the sink, `watched` was only cleared when the whole
/// subscriber list emptied. The agent's sink never refuses a frame, so once it had attached a
/// shell, a page closing left `watched` true forever and the next `create` started a new shell.
#[test]
fn a_page_leaving_unwatches_the_shell_even_with_the_agents_sink_attached() {
    let service = TerminalService::new();
    let cwd = std::env::temp_dir();
    let owner = cwd.to_string_lossy().into_owned();
    let (agent_sink, _agent_frames) = collector();
    let (opened, _) = service
        .open_for_agent(&owner, "test-session", &owner, &owner, 80, 24, agent_sink)
        .expect("a shell for the agent");

    let accepting = Arc::new(AtomicBool::new(true));
    let page_accepting = Arc::clone(&accepting);
    let page_sink: Sink = Arc::new(move |_| page_accepting.load(Ordering::Relaxed));
    service
        .attach(&opened.id, page_sink)
        .expect("the page attaches to the shell");
    assert!(
        !service
            .list_live_by_owner(&owner, &owner)
            .iter()
            .find(|summary| summary.id == opened.id)
            .expect("the shell is listed")
            .unwatched,
        "an attached page is watching the shell"
    );

    // The page's channel closes: its sink refuses the next frame. The agent's sink accepts it.
    accepting.store(false, Ordering::Relaxed);
    service
        .session(&opened.id)
        .expect("the shell is live")
        .broadcast(TerminalFrame::Data {
            data: STANDARD.encode(b"tick"),
        });
    assert!(
        service
            .list_live_by_owner(&owner, &owner)
            .iter()
            .find(|summary| summary.id == opened.id)
            .expect("the shell is still listed")
            .unwatched,
        "with no page left, the agent's shell is reusable again"
    );
}

#[test]
fn opening_in_a_file_is_refused() {
    let service = TerminalService::new();
    let file = std::env::temp_dir().join(format!("omp-terminal-file-{}.txt", std::process::id()));
    std::fs::write(&file, "not a directory").expect("a file to point the shell at");

    let (sink, _frames) = collector();
    assert!(service
        .open(
            &file.to_string_lossy(),
            "test-session",
            &file.to_string_lossy(),
            &file.to_string_lossy(),
            80,
            24,
            sink,
        )
        .is_err());

    let _ = std::fs::remove_file(&file);
    assert_eq!(
        lock(&service.inner.sessions).len(),
        0,
        "a refused open leaves no session"
    );
}

/// A conversation may own several terminals, and the agent reuses only an unwatched one.
///
/// Three facts, each of which the column and the tool depend on: the page's own opens each start
/// a shell (the "new terminal" menu item adds one), an agent `create` starts its own rather than
/// taking over a tab the reader is watching, and a second `create` reuses the background shell the
/// first one started instead of piling up invisible pty's.
#[test]
fn terminals_are_per_tab_and_the_agent_reuses_only_an_unwatched_shell() {
    let service = TerminalService::new();
    let cwd = std::env::temp_dir();
    let owner = cwd.to_string_lossy().into_owned();
    let (page_sink, _page_frames) = collector();
    let watched = service
        .open(&owner, "test-session", &owner, &owner, 80, 24, page_sink)
        .expect("a shell on this machine");
    // The page's own tab name, carried over so the agent's `list` shows what the reader says out
    // loud: it is the page that numbers a conversation's tabs, this side only keeps the name.
    service
        .set_label(&watched.id, "PowerShell-1")
        .expect("a live shell takes the name its tab reads as");
    let listed = service.list_live_by_owner(&owner, &owner);
    assert_eq!(
        listed
            .iter()
            .find(|entry| entry.id == watched.id)
            .and_then(|entry| entry.label.clone()),
        Some("PowerShell-1".to_owned()),
        "the agent's list carries the tab's own name"
    );
    assert!(
        service.set_label(&watched.id, "").is_err(),
        "an empty name is refused"
    );
    // The page draws it: this is the second half of the reader's own path (`open`, then the
    // panel's `attach`), and it is what marks the shell as watched.
    let (attach_sink, _attach_frames) = collector();
    service
        .attach(&watched.id, attach_sink)
        .expect("the page attaches to its own shell");

    // The agent asks for a terminal while the reader's tab is attached: it must not take it over.
    let (agent_sink, _agent_frames) = collector();
    let (first, reused) = service
        .open_for_agent(&owner, "test-session", &owner, &owner, 80, 24, agent_sink)
        .expect("a shell for the agent");
    assert!(!reused, "a watched shell is not reused");
    assert_ne!(first.id, watched.id, "the agent gets its own shell");

    // A second create finds the agent's own shell unattended and reuses it.
    let (again_sink, _again_frames) = collector();
    let (second, reused) = service
        .open_for_agent(&owner, "test-session", &owner, &owner, 80, 24, again_sink)
        .expect("the agent's shell is reachable");
    assert!(reused, "the agent's own unwatched shell is reused");
    assert_eq!(second.id, first.id);

    // Attaching the agent's sink must not make its shell look watched: a third create reuses
    // the same shell instead of starting another invisible pty.
    let (third_sink, _third_frames) = collector();
    let (third, reused) = service
        .open_for_agent(&owner, "test-session", &owner, &owner, 80, 24, third_sink)
        .expect("the agent's shell is still reachable");
    assert!(reused, "the agent's shell stays reusable");
    assert_eq!(third.id, first.id);

    assert_eq!(
        service.list_live_by_owner(&owner, &owner).len(),
        2,
        "the reader's tab and the agent's shell, not one or three"
    );

    service.shutdown_all();
    assert_eq!(lock(&service.inner.sessions).len(), 0);
}

/// A different conversation in the same workspace gets its own shell: ownership is the
/// conversation, not the directory.
#[test]
fn another_owner_in_the_same_workspace_starts_its_own_shell() {
    let service = TerminalService::new();
    let cwd = std::env::temp_dir();
    let workspace = cwd.to_string_lossy().into_owned();
    let first = cwd.join("session-a.jsonl").to_string_lossy().into_owned();
    let second = cwd.join("session-b.jsonl").to_string_lossy().into_owned();

    let (sink_a, _frames_a) = collector();
    let (opened_a, attached_a) = service
        .open_for_agent(&workspace, "a", &first, &workspace, 80, 24, sink_a)
        .expect("a shell for A");
    assert!(!attached_a);

    let (sink_b, _frames_b) = collector();
    let (opened_b, attached_b) = service
        .open_for_agent(&workspace, "b", &second, &workspace, 80, 24, sink_b)
        .expect("a shell for B");
    assert!(!attached_b, "B does not borrow A's shell");
    assert_ne!(opened_a.id, opened_b.id);
    assert_eq!(service.list_live_by_owner(&first, &workspace).len(), 1);
    assert_eq!(service.list_live_by_owner(&second, &workspace).len(), 1);

    service.shutdown_all();
}
