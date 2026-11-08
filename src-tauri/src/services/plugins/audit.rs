//! The plugin audit trail: one structured line per consent-relevant plugin write, written through
//! the application's own log (`services::log`).
//!
//! The events are the ones the spec names (§11): an install, a removal, an enable, a disable, a
//! confirmation given or refused, and a settings write. What a line carries is deliberately thin -
//! the event name, the plugin id and the scope - because whoever reads the log later is diagnosing
//! the machine, and the material this layer handles is exactly the material that must not end up
//! there: a setting's value can be a token, an install source can be a path into the user's home,
//! and a host message can hold either. None of them is written here. The fields this module does
//! write are ids and scope tokens, which the command layer has already validated as such
//! (`services::plugins::validate`) before any of this runs.
//!
//! A line is one JSON object, so a reader can split the file by newline and read a field by name
//! instead of matching text - and `serde_json` escapes what it writes, which is what keeps an
//! unexpected character inside the id from opening a second line. Nothing here can fail a caller:
//! the log is evidence, and a caller is not refused a plugin write because a line could not be
//! formatted.
//!
//! The scope is the one the write addressed. Some commands do not address one at all (the settings
//! writes, where the engine picks the installation), and those lines carry [`SCOPE_UNSPECIFIED`]:
//! guessing which installation the engine picked would put a fact in the trail that nobody
//! observed, which is worse than recording that the write named none.

use serde::Serialize;

use std::collections::{HashSet, VecDeque};
use std::sync::{LazyLock, Mutex};

use crate::services::log;

/// The scope field of an event whose command named no scope.
const SCOPE_UNSPECIFIED: &str = "-";

/// One event as it is written: the event name and the two fields every plugin event carries.
#[derive(Serialize)]
struct Event<'a> {
    event: &'a str,
    #[serde(rename = "pluginId")]
    plugin_id: &'a str,
    scope: &'a str,
    /// The source a switch was about (plan §8.3: the marketplace is its own field, not part of a
    /// wider payload). Absent from every other event, which is why it is optional rather than a
    /// sentinel: a reader of the trail sees the field only where the fact exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    marketplace: Option<&'a str>,
}

/// An install finished and the list that came back holds what it added.
pub(crate) fn install(plugin_id: &str, scope: Option<&str>) {
    write("plugin.install", plugin_id, scope);
}

/// A plugin was removed from an installation, and every confirmation of that id was forgotten with
/// it.
pub(crate) fn uninstall(plugin_id: &str, scope: Option<&str>) {
    write("plugin.uninstall", plugin_id, scope);
}

/// A plugin installation was switched on.
pub(crate) fn enable(plugin_id: &str, scope: Option<&str>) {
    write("plugin.enable", plugin_id, scope);
}

/// A plugin installation was switched off - by the user's own toggle, by an install that had to
/// quarantine what it just added, or by a withdrawal that had to stop what it covered.
pub(crate) fn disable(plugin_id: &str, scope: Option<&str>) {
    write("plugin.disable", plugin_id, scope);
}

/// The user confirmed that this installation may run code.
pub(crate) fn permission_granted(plugin_id: &str, scope: Option<&str>) {
    write("plugin.permission.granted", plugin_id, scope);
}

/// The confirmation this installation would have needed was not given: either the user withdrew it,
/// or a write asked for something that runs code before it was confirmed.
pub(crate) fn permission_denied(plugin_id: &str, scope: Option<&str>) {
    write("plugin.permission.denied", plugin_id, scope);
}

/// One setting of one plugin was stored. The value is never part of the line.
pub(crate) fn config_set(plugin_id: &str, scope: Option<&str>) {
    write("plugin.config.set", plugin_id, scope);
}

/// One setting of one plugin was forgotten, or every explicit one when no key was named.
pub(crate) fn config_reset(plugin_id: &str, scope: Option<&str>) {
    write("plugin.config.reset", plugin_id, scope);
}

/// One plugin was moved from one marketplace to another: the two-step switch happened, and the
/// installation now comes from `marketplace` (plan §4.3).
pub(crate) fn update_switch(plugin_id: &str, scope: Option<&str>, marketplace: &str) {
    write_source("plugin.update.switch", plugin_id, scope, marketplace);
}

/// One installation's resident process started and reached `worker_hello` (plan §8.3, §6.4).
///
/// The line says a process was started, not what the plugin then did: the frames it sends are its
/// own work, and the trail is about what this application began and ended on the user's behalf.
pub(crate) fn process_start(plugin_id: &str, scope: &str) {
    write("plugin.process.start", plugin_id, Some(scope));
}

/// One installation's resident process was stopped - by a disable, an uninstall, an upgrade, the
/// live-process ceiling, or the application leaving.
pub(crate) fn process_stop(plugin_id: &str, scope: &str) {
    write("plugin.process.stop", plugin_id, Some(scope));
}

/// One installation's resident process ended without being asked to. The reason (a crash class, a
/// protocol mismatch, a startup refusal) is on the row and in the log line; this event is the fact.
pub(crate) fn process_crash(plugin_id: &str, scope: &str) {
    write("plugin.process.crash", plugin_id, Some(scope));
}

/// One installation's resident process did not answer inside the budget this application gives it,
/// so it was stopped (`services::plugins::process`).
pub(crate) fn process_timeout(plugin_id: &str, scope: &str) {
    write("plugin.process.timeout", plugin_id, Some(scope));
}

/// One contributed command was executed through its installation's process. What the command was
/// and what it returned are not part of the line: a command id is the plugin's own vocabulary and a
/// value can carry anything the plugin touched.
pub(crate) fn command_run(plugin_id: &str, scope: &str) {
    write("plugin.command.run", plugin_id, Some(scope));
}

/// A theme's stylesheet was prepared for an installation the engine is running, so the row the page
/// paints from carries text it can inject (plan §8.3).
///
/// The four values are the dedupe key and nothing else: the installation's handle, its package
/// revision and the theme id say *which content* reached the row, and none of them is written - the
/// line carries the event, the plugin id and the scope, like every other plugin event. A plugin list
/// is read again on every settings visit, so without this the same stylesheet would be recorded once
/// per read; with it, once per package (`services::plugins::theme_css` is what applies it).
///
/// Owner / bound / release (`rules.md#resource-bounds-and-release-points`): the set of keys already recorded is a process-level
/// singleton owned by this module ([`THEME_CSS_APPLIED_MAX`] entries), released oldest-first when the
/// bound is reached - each key is one stylesheet this process has already said reached a row, and the
/// process ending is what releases the rest.
pub(crate) fn theme_css_applied(
    plugin_id: &str,
    scope: &str,
    install: &str,
    revision: &str,
    theme: &str,
) {
    let key = format!("{install}\u{0}{scope}\u{0}{revision}\u{0}{theme}");
    let first = THEME_CSS_APPLIED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remember(&key, THEME_CSS_APPLIED_MAX);
    if first {
        write("plugin.theme.css.applied", plugin_id, Some(scope));
    }
}

/// One installation's slot module was served (plan §8.3, T3).
///
/// Emitted by the protocol handler, not by a list read: "served" is the one fact this process can
/// observe - the module bytes left for the application document - and a row that merely declared a
/// module is not a load. `revision` is the digest of exactly those bytes, so reading the same file
/// twice is one event and replacing its content is a new one; neither the bytes nor the module path
/// is written, only the event, the plugin id and the scope.
///
/// Owner / bound / release (`rules.md#resource-bounds-and-release-points`): the set of keys already recorded is a process-level
/// singleton owned by this module ([`RENDERER_LOAD_MAX`] entries), released oldest-first when the
/// bound is reached - each key is one module revision this process has already said it served, and
/// the process ending is what releases the rest.
pub(crate) fn renderer_load(plugin_id: &str, scope: &str, revision: &str) {
    let key = format!("{plugin_id}\u{0}{scope}\u{0}{revision}");
    let first = RENDERER_LOAD
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remember(&key, RENDERER_LOAD_MAX);
    if first {
        write("plugin.renderer.load", plugin_id, Some(scope));
    }
}

/// How many `(installation, revision, theme)` triples this process remembers having recorded.
const THEME_CSS_APPLIED_MAX: usize = 512;

/// The triples already recorded, oldest first.
///
/// A poisoned lock is not a reason to take the application down: the set is a record, and the worst a
/// poisoned one costs is a repeated line.
static THEME_CSS_APPLIED: LazyLock<Mutex<BoundedKeys>> =
    LazyLock::new(|| Mutex::new(BoundedKeys::default()));

/// How many `(installation, scope, module revision)` triples this process remembers having served.
const RENDERER_LOAD_MAX: usize = 512;

/// The module revisions already recorded, oldest first.
static RENDERER_LOAD: LazyLock<Mutex<BoundedKeys>> =
    LazyLock::new(|| Mutex::new(BoundedKeys::default()));

/// A bounded set of dedupe keys, oldest first.
///
/// Owner / bound / release (`rules.md#resource-bounds-and-release-points`): each instance is held by one event's `static` in this
/// module, bounded by that event's own constant, and releases its oldest key when the bound is
/// reached - the process ending releases the rest. Generic over nothing, because every key is a
/// `\0`-joined tuple of ids and revisions.
#[derive(Default)]
struct BoundedKeys {
    seen: HashSet<String>,
    order: VecDeque<String>,
}

impl BoundedKeys {
    /// Whether this key is new, remembering it when it is.
    fn remember(&mut self, key: &str, bound: usize) -> bool {
        if !self.seen.insert(key.to_owned()) {
            return false;
        }
        self.order.push_back(key.to_owned());
        while self.order.len() > bound {
            if let Some(oldest) = self.order.pop_front() {
                self.seen.remove(&oldest);
            }
        }
        true
    }
}

/// The install half of a switch failed and putting the previous installation back failed too: the
/// plugin is now uninstalled, and its confirmation is deliberately kept (plan §4.3).
pub(crate) fn update_rollback_failed(plugin_id: &str, scope: Option<&str>, marketplace: &str) {
    write_source(
        "plugin.update.rollback_failed",
        plugin_id,
        scope,
        marketplace,
    );
}

/// Writes one event, or nothing when the line could not be formatted.
///
/// Serializing three strings cannot fail in practice; a caller is still not handed an error for it,
/// because the log is evidence about a write and never a condition of one.
fn write(event: &str, plugin_id: &str, scope: Option<&str>) {
    write_line(event_line(event, plugin_id, scope, None));
}

/// Writes one event that also names the source it was about.
fn write_source(event: &str, plugin_id: &str, scope: Option<&str>, marketplace: &str) {
    write_line(event_line(event, plugin_id, scope, Some(marketplace)));
}

/// The one place a line reaches the log.
fn write_line(line: Option<String>) {
    if let Some(line) = line {
        log::info(&line);
    }
}

/// The line one event is written as: `serde_json`'s object form, which escapes whatever the id
/// holds and therefore keeps one event on one line.
fn event_line(
    event: &str,
    plugin_id: &str,
    scope: Option<&str>,
    marketplace: Option<&str>,
) -> Option<String> {
    serde_json::to_string(&Event {
        event,
        plugin_id,
        scope: scope.unwrap_or(SCOPE_UNSPECIFIED),
        marketplace,
    })
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// A line is one parseable object holding the event and the installation it is about - the shape
    /// a reader of the log depends on.
    #[test]
    fn an_event_is_one_object_with_the_event_and_the_installation() {
        let line =
            event_line("plugin.enable", "hello@official", Some("user"), None).expect("a line");
        assert!(!line.contains('\n'), "one event is one line: {line}");
        let parsed: Value = serde_json::from_str(&line).expect("a JSON object");
        assert_eq!(parsed["event"], "plugin.enable");
        assert_eq!(parsed["pluginId"], "hello@official");
        assert_eq!(parsed["scope"], "user");
    }

    /// The theme event is recorded once per package revision: a plugin list is read again on every
    /// settings visit, and the trail is about the content, not about the reads.
    #[test]
    fn a_theme_stylesheet_is_recorded_once_per_package_revision() {
        let mut recorded = BoundedKeys::default();
        let remember =
            |recorded: &mut BoundedKeys, key: &str| recorded.remember(key, THEME_CSS_APPLIED_MAX);
        assert!(remember(
            &mut recorded,
            "hello@official\u{0}user\u{0}rev-1\u{0}midnight"
        ));
        assert!(
            !remember(
                &mut recorded,
                "hello@official\u{0}user\u{0}rev-1\u{0}midnight"
            ),
            "the same stylesheet of the same package is one fact"
        );
        assert!(
            remember(
                &mut recorded,
                "hello@official\u{0}user\u{0}rev-2\u{0}midnight"
            ),
            "a new package revision is a new fact"
        );
        assert!(
            remember(&mut recorded, "hello@official\u{0}user\u{0}rev-1\u{0}dusk"),
            "another theme of the same package is its own fact"
        );
    }

    /// The renderer event dedupes the same way: one line per served module revision, a changed
    /// module is a new fact, and a different scope is a different installation.
    #[test]
    fn a_served_module_is_recorded_once_per_module_revision() {
        let mut recorded = BoundedKeys::default();
        let remember =
            |recorded: &mut BoundedKeys, key: &str| recorded.remember(key, RENDERER_LOAD_MAX);
        assert!(remember(&mut recorded, "demo\u{0}user\u{0}sha-a"));
        assert!(
            !remember(&mut recorded, "demo\u{0}user\u{0}sha-a"),
            "the same served bytes are one load"
        );
        assert!(
            remember(&mut recorded, "demo\u{0}user\u{0}sha-b"),
            "new module content is a new load"
        );
        assert!(
            remember(&mut recorded, "demo\u{0}project\u{0}sha-a"),
            "the other scope is another installation"
        );
    }

    /// The record is bounded, and what it releases is the oldest triple - so a long-lived process
    /// cannot grow it without end while still recording the packages in front of it.
    #[test]
    fn the_record_is_bounded_and_releases_the_oldest() {
        let mut recorded = BoundedKeys::default();
        for index in 0..THEME_CSS_APPLIED_MAX {
            assert!(recorded.remember(
                &format!("install\u{0}user\u{0}rev-{index}\u{0}t"),
                THEME_CSS_APPLIED_MAX
            ));
        }
        assert_eq!(recorded.order.len(), THEME_CSS_APPLIED_MAX);
        assert!(recorded.remember("install\u{0}user\u{0}rev-next\u{0}t", THEME_CSS_APPLIED_MAX));
        assert_eq!(recorded.order.len(), THEME_CSS_APPLIED_MAX);
        assert_eq!(recorded.seen.len(), THEME_CSS_APPLIED_MAX);
        assert!(
            recorded.remember("install\u{0}user\u{0}rev-0\u{0}t", THEME_CSS_APPLIED_MAX),
            "the oldest triple was released"
        );
    }

    /// A write that named no scope says so rather than inventing one, and an id carrying characters
    /// that would otherwise break the line is escaped, not written as a second line.
    #[test]
    fn an_unnamed_scope_and_an_odd_id_stay_in_one_line() {
        let unnamed =
            event_line("plugin.config.set", "hello@official", None, None).expect("a line");
        assert_eq!(
            serde_json::from_str::<Value>(&unnamed).expect("a JSON object")["scope"],
            SCOPE_UNSPECIFIED
        );

        let odd =
            event_line("plugin.install", "hello\"\nworld", Some("project"), None).expect("a line");
        assert!(!odd.contains('\n'), "escaped, not split: {odd}");
        assert_eq!(
            serde_json::from_str::<Value>(&odd).expect("a JSON object")["pluginId"],
            "hello\"\nworld"
        );
    }
}
