use super::*;

/// A directory one test alone owns.
fn fresh_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("omp-engine-log-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("log directory");
    dir
}

/// A file a previous host filled is moved aside, so the directory keeps the current log and one
/// predecessor - the rule `app.log` already followed, and the reason a long-lived install cannot
/// grow `host.log` without bound.
#[test]
fn a_filled_engine_log_is_rotated_before_the_next_host_opens_it() {
    let dir = fresh_dir("rotate");
    let live = dir.join("host.log");
    std::fs::write(&live, "x".repeat(65)).expect("a log a previous host filled");

    let log = EngineLog::new_with_cap(&dir, "host", 64);
    log.line("after the rotation");

    let rotated = dir.join("host.log.1");
    assert_eq!(
        std::fs::metadata(&rotated).expect("the rotated log").len(),
        65,
        "the previous log is kept whole"
    );
    assert_eq!(
        std::fs::metadata(&live).expect("this host's log").len(),
        "after the rotation\n".len() as u64,
        "this host starts at the top of a fresh file"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// The cap counts the file, not one host process: a fresh host opening a file that is already
/// near the ceiling stops early rather than writing another sixteen megabytes into it. The
/// comparison is against what the file held *before* the line, so the line that crosses the
/// ceiling is written and everything after it is not - one line's worth of overshoot, ever.
#[test]
fn the_cap_counts_the_file_not_the_run() {
    let dir = fresh_dir("cap");
    let live = dir.join("host.log");
    std::fs::write(&live, "x".repeat(60)).expect("a file a host left behind");

    let log = EngineLog::new_with_cap(&dir, "host", 64);
    log.line("the last line that fits");
    let after_one = std::fs::metadata(&live).expect("the live log").len();
    assert_eq!(
        after_one, 84,
        "60 bytes left behind plus the 24 of the line"
    );

    log.line("a line past what is left of the cap");
    assert!(
        log.capped.load(Ordering::Relaxed),
        "the file's ceiling, not the host's share of it, is what stops it"
    );
    assert_eq!(
        std::fs::metadata(&live).expect("the live log").len(),
        after_one,
        "a refused line does not reach the file"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
