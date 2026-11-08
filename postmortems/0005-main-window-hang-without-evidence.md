# Postmortem 0005: the window froze for a minute and left no evidence
Status: mitigated


## Summary

On 2026-10-30 the installed application's main window stopped answering and the system's own hang dialog closed the
process. Nothing crashed: Windows recorded `Application Hang` 1002, and there was no `Application Error`, no Windows
Error Reporting report and no WebView2 Crashpad dump in any profile. The application's log agreed from the other side —
the run wrote its last line at 14:19:28 and never wrote `run ended` — but between that line and the process being closed
it wrote nothing at all, so the freeze left no record of what the main thread was doing.

## Impact

- The reader lost about a minute to a window that could not paint, take input or answer IPC, then had to close it and
  start the application again.
- The conversation survived: the relaunched process re-activated the same session id (`s7a328705617ff44c`) from the
  store, and its transcript was intact. Nothing in flight was lost beyond the turn's own progress.
- The diagnosis cost was the real damage: the host's death at 14:20:27 on `EPIPE: broken pipe, write` was the only
  error in any log, and it is a *consequence* — the parent's pipe went away — which reads like a host failure and is not
  one.

## Timeline

- 14:10:52 — `app.log`: `run started (app 0.1.0, protocol 33)`. Its engine host (pid 3780) started at 14:10:57.
- 14:19:28 — `app.log`: `taskbar: a turn finished away from the reader`. The last line this run ever wrote.
- 14:19:28–14:20:27 — no line from any part of the desktop. The window showed the system's "not responding" state.
- 14:20:27 — Windows: `Application Hang` 1002, `omp_desktop.exe` 0.1.0.0, "stopped interacting with Windows and was
  closed".
- 14:20:27 — the engine host disposed both sessions (`reason=dispose kind=normal`, then `uncaught_exception
  kind=fatal`) and died writing its own log: `EPIPE: broken pipe, write`. Its parent had already gone.
- 14:20:29 — `app.log`: `run started` again: the reader's relaunch.

## Root cause

Not established. What the evidence fixes: the process was alive, and its **main thread** was not pumping messages —
that is what the system's hang detection measures, and what makes every IPC response and every repaint wait. What it
rules out: a Rust panic (the log would carry it), an out-of-memory kill (no report, and the process answered nothing
before it died), a host fault (the host was healthy to the last second and only failed writing to a pipe whose reader
was gone), and a WebView2 process crash (no Crashpad report in any of the five profiles).

The leading hypothesis is the native browser panel. The window was showing a guest page still in its loading state
(`localhost:5199/narrow-probe.html`, served by a Vite server that answers in 12 ms), with an agent driving that page,
and every browser command was a synchronous Tauri command at the time: its body ran inside the IPC handler *on the main
thread*, and the service reaches into WebView2 through wry, which marshals the call straight back to that same thread.
A guest browser process slow to answer therefore blocks the thread that paints — indefinitely, since nothing bounds a
synchronous WebView2 call. It is a hypothesis, not a finding: the log that would have separated it from a plain
deadlock did not exist.

## Fix

Two changes, one for the evidence and one for the mechanism (`removed:notes/implemented/bug-fix/2026-10-30-main-thread-stall-evidence.md`):

- `services/main_thread_watch.rs` pings the main thread once a second and writes a line when a ping is five seconds
  late — while it is still late — plus the total when the answer arrives. A healthy run writes nothing; one stall writes
  at most three lines. The line carries the CPU the thread spent over the same wait, which separates a thread that was
  waiting from one that was computing, and the stack walk that follows names the modules it was in.
- Every browser command is `#[tauri::command(async)]`, so the body runs on a worker and only the WebView2 call itself
  executes on the main thread. Waiting now happens where waiting is harmless.
- A host request that times out now names its command and id, and the late answer names the id it carried, so the two
  lines a freeze produces join instead of leaving a reader to guess which request was in flight.

The first stall the watchdog recorded came the same afternoon: 8.4 s at 16:15:23, in a build carrying both changes,
with the engine host idle from 16:07:55 to 16:15:36 and no line anywhere saying what the thread was doing. That run is
why the CPU figure and the stack walk exist; the next occurrence is the one that names the blocking call.

## Rules changed

- `rules.md#main-thread-budget` — a command that reaches a webview is `#[tauri::command(async)]`; a silent main thread
  is logged.
