//! The call wait's budget rule: the plugin's time is not the user's time.
//!
//! `await_settlement` is the supervisor's half of one promise: a worker that stops answering is
//! stopped after `CALL_TIMEOUT`, while a worker parked on a consent card waits for the person and is
//! not charged for it. The two clocks are proven here without a child process: a channel stands in
//! for the worker, and a closure stands in for the question table.

use super::*;
use crate::services::plugins::process::supervise::{await_settlement, CallWait};
use std::sync::atomic::AtomicBool;

/// A settlement a test can hand over.
fn settlement() -> Settlement {
    Settlement {
        ok: true,
        value: Some(serde_json::json!({ "probe": true })),
        code: None,
        message: None,
    }
}

#[test]
fn an_unanswered_call_expires_inside_its_budget() {
    let (_sender, receiver) = mpsc::sync_channel::<Settlement>(1);
    let started = Instant::now();
    let wait = await_settlement(&receiver, Duration::from_millis(120), &|| false);
    let elapsed = started.elapsed();
    assert!(
        matches!(wait, CallWait::Expired),
        "no answer and no question is a timeout"
    );
    assert!(
        elapsed >= Duration::from_millis(120),
        "the budget is spent before the call is given up on: {elapsed:?}"
    );
}

#[test]
fn an_open_question_keeps_the_call_alive_past_its_budget() {
    let (sender, receiver) = mpsc::sync_channel::<Settlement>(1);
    let budget = Duration::from_millis(60);
    // The question is open for longer than the budget; the answer arrives after it. Without the
    // rule this test times out, which is exactly the bug it exists for.
    let open = Arc::new(AtomicBool::new(true));
    let flag = Arc::clone(&open);
    let answer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        let _ = sender.try_send(settlement());
    });
    let question_open = || flag.load(Ordering::SeqCst);
    let wait = await_settlement(&receiver, budget, &question_open);
    answer.join().expect("the answering thread");
    assert!(
        matches!(wait, CallWait::Answered(_)),
        "a call parked on the user's answer is answered, not timed out"
    );
    open.store(false, Ordering::SeqCst);
}

#[test]
fn a_closed_channel_is_read_as_the_process_ending() {
    let (sender, receiver) = mpsc::sync_channel::<Settlement>(1);
    drop(sender);
    assert!(matches!(
        await_settlement(&receiver, Duration::from_secs(5), &|| false),
        CallWait::Gone
    ));
}

#[test]
fn a_question_that_closes_and_stays_closed_still_lets_the_budget_run_out() {
    // The question is answered (or expires) and nothing follows: the ordinary budget applies again,
    // so a hung worker after a prompt is still stopped rather than waited on forever.
    let (_sender, receiver) = mpsc::sync_channel::<Settlement>(1);
    let seen = AtomicBool::new(false);
    let question_open = || {
        if seen.swap(true, Ordering::SeqCst) {
            return false;
        }
        true
    };
    let started = Instant::now();
    let wait = await_settlement(&receiver, Duration::from_millis(150), &question_open);
    assert!(matches!(wait, CallWait::Expired));
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "the wait is bounded once no question is open"
    );
}
