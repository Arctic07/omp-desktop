//! The refusal vocabulary one bridge call can answer with (spec §6.3 / §6.4).
//!
//! Every one of these is `&'static str` data: the `code` is the token a page branches on (a closed
//! set, stable across builds) and the `message` is the sentence its author reads. They live in their
//! own file because there are twenty of them and because a wrong sentence is a bug of its own kind:
//! two causes sharing one message is what sent an author looking for a permission their manifest
//! already declared (`PERMISSION_DENIED` vs `PERMISSION_REFUSED_BY_USER`), and one message about
//! filesystem paths answered a network refusal (`DENIED_BY_POLICY` vs `HOST_NOT_DECLARED`). When a
//! new cause is added, add a constant for it rather than borrowing the nearest one.

use serde_json::{json, Value};

/// Why one call was refused, as the envelope carries it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Refusal {
    pub(crate) code: &'static str,
    pub(crate) message: &'static str,
}

impl Refusal {
    pub(crate) fn body(self) -> Value {
        json!({ "ok": false, "code": self.code, "message": self.message })
    }
}

/// The plugin did not declare, or was not granted, the permission this call needs (spec §6.1).
pub(crate) const PERMISSION_DENIED: Refusal = Refusal {
    code: "permission_denied",
    message: "This plugin did not declare the permission this call needs.",
};
/// The call is not the shape this build reads.
pub(crate) const INVALID_REQUEST: Refusal = Refusal {
    code: "invalid_request",
    message: "This call is not the shape this build reads.",
};
/// The call carries more than this build answers with.
pub(crate) const TOO_LARGE: Refusal = Refusal {
    code: "too_large",
    message: "This call carries more than this build answers with.",
};
/// Nothing usable is there: a read or a delete names a file that does not exist, and a write names a
/// file whose directory is not there (or names a directory).
///
/// The sentence is mode-neutral on purpose: it used to say "may read", which a write and a delete
/// both borrowed, so a plugin writing into a directory it had not shipped read a sentence about
/// reading.
pub(crate) const NOT_FOUND: Refusal = Refusal {
    code: "not_found",
    message: "That path names no file this plugin can use.",
};
/// The reject table names it, or the path leaves the installation (spec §6.3-2/-3).
pub(crate) const DENIED_BY_POLICY: Refusal = Refusal {
    code: "denied_by_policy",
    message: "This application never hands that path out, whatever the scope or the answer.",
};
/// The **user** answered no to the question this call raised (spec §6.3-4).
///
/// The code is `permission_denied` because a permission answer is what refused the call, but the
/// sentence must not be [`PERMISSION_DENIED`]'s: a plugin that declared `clipboard.write` and whose
/// reader clicked 拒绝 has not forgotten its manifest, and telling its author otherwise sends them
/// looking for a permission that is already there.
pub(crate) const PERMISSION_REFUSED_BY_USER: Refusal = Refusal {
    code: "permission_denied",
    message: "The user did not allow this call.",
};
/// The user did not allow what the call asked for (spec §6.3-4).
pub(crate) const OUT_OF_SCOPE: Refusal = Refusal {
    code: "out_of_scope",
    message: "The user did not allow this call.",
};
/// The address is not one this application fetches for a plugin: `net.fetch` speaks http(s) only.
pub(crate) const SCHEME_NOT_FETCHABLE: Refusal = Refusal {
    code: "denied_by_policy",
    message: "Only http(s) addresses are fetched.",
};
/// The address is not one this application hands to the system's own browser: `shell.openExternal`
/// speaks http(s) only, because the launcher opens handlers and files for every other scheme.
///
/// Its own sentence rather than [`SCHEME_NOT_FETCHABLE`]'s, for the reason that file's header gives:
/// a plugin author reading "fetched" after a `shell.openExternal` is being told about a call they did
/// not make. Both carry the same code, which is the family the caller branches on.
pub(crate) const SCHEME_NOT_OPENABLE: Refusal = Refusal {
    code: "denied_by_policy",
    message: "Only http(s) addresses are opened.",
};
/// The address reaches a host the manifest's `net.domains` does not list (spec §6.4).
///
/// Its own sentence, not [`DENIED_BY_POLICY`]'s: that one is about a filesystem path, and a plugin
/// author reading it after a `net.fetch` has no way to tell which gate refused them.
pub(crate) const HOST_NOT_DECLARED: Refusal = Refusal {
    code: "denied_by_policy",
    message: "That host is not one this plugin declared.",
};
/// One path this application never hands to the system's own opener (`fs.openDefault`, `fs.reveal`).
///
/// Its own constant with [`DENIED_BY_POLICY`]'s code, for the reason [`SCHEME_NOT_OPENABLE`] gives:
/// the caller branches on the family, while the sentence has to name what actually happened. Here
/// that is "this is a program": a path the system would *run* is refused even for an installation
/// that declared the permission, and even one holding `fs.anyPath`, because no file permission makes
/// handing an executable to a launcher a reach this application serves.
pub(crate) const EXECUTABLE_REFUSED: Refusal = Refusal {
    code: "denied_by_policy",
    message: "This application never opens a program file for a plugin.",
};
/// The call could not be completed for a reason that is not the caller's.
pub(crate) const INTERNAL: Refusal = Refusal {
    code: "internal",
    message: "The call could not be completed.",
};
/// A redirect left the domains the manifest lists, so the request stopped there (spec §6.4).
pub(crate) const REDIRECT_REFUSED: Refusal = Refusal {
    code: "redirect_refused",
    message: "That request was redirected to a host this plugin may not reach.",
};
/// The call did not finish inside the time this build gives it.
pub(crate) const REQUEST_TIMEOUT: Refusal = Refusal {
    code: "timeout",
    message: "The request did not finish in time.",
};
/// One installation made more deletes in a minute than this build allows.
pub(crate) const TOO_MANY_DELETES: Refusal = Refusal {
    code: "too_many_deletes",
    message: "This plugin deleted more files in a minute than this build allows.",
};
/// This build does not serve that call on this platform.
pub(crate) const UNSUPPORTED: Refusal = Refusal {
    code: "unsupported",
    message: "This build does not serve that on this platform.",
};
/// The plugin's own browser page is not reachable (`browser.*`, API 0.3.0).
///
/// One sentence for the two causes that share it - a window with no built-in browser at all, and a
/// plugin that has not navigated yet - because what a plugin does about either is the same, and the
/// alternative is a message that picks one cause and is wrong half the time.
pub(crate) const BROWSER_PAGE_UNAVAILABLE: Refusal = Refusal {
    code: "unsupported",
    message: "The browser page is not available: this window has no built-in browser, or this plugin has not navigated yet.",
};
/// One installation's pace for one capability is spent: the completions of this minute, the bus
/// messages of this second, or the sockets it may hold at once.
///
/// The token is the one the worker budget already answers with (`too_many_requests`), because it is
/// the same fact from the plugin's side - slow down - and a second spelling of it would be a second
/// thing an author has to learn to branch on. The sentence names what is spent, because "too many
/// requests" alone does not tell a plugin which of its loops to slow.
pub(crate) const TOO_MANY_REQUESTS: Refusal = Refusal {
    code: "too_many_requests",
    message:
        "This plugin is calling faster than this build allows, or holding more open than it may.",
};
/// The conversation a `session.rename` / `session.delete` named is not one this application holds.
///
/// One sentence for the two causes the host reports as one code - a rename of a conversation that is
/// not open here, and a delete of an id the session index does not list - because the caller sees the
/// code, not the operation (`host_refusal`). Both halves are what a plugin author acts on: open the
/// conversation, or read the list again before naming an id.
pub(crate) const HOST_SESSION_NOT_HELD: Refusal = Refusal {
    code: "not_found",
    message: "That conversation is not one this application can act on: a rename needs it open, and a delete needs it listed.",
};
/// The conversation is still working, and the host will not take a transcript a turn is writing.
pub(crate) const HOST_SESSION_BUSY: Refusal = Refusal {
    code: "too_many_requests",
    message: "That conversation is still working; this call can be made again once it stops.",
};
