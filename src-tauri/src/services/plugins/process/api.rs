//! The one channel a plugin's resident process asks the desktop through (`worker_invoke`).
//!
//! A worker is JavaScript this application did not write, and the `pi.*` calls it makes are the
//! *same* calls a plugin page makes through the bridge (`services::plugins::bridge`). So this file
//! adds no rule of its own: a file read is judged by the bridge's four gates, a fetch by the same
//! allow-list and redirect policy, and the clipboard by the same first-use question. What is
//! genuinely new is the three methods a page has no use for - the engine's
//! settings (`plugin.settings.*`), the command registry (`command.register` / `command.unregister`)
//! and the two view calls (`ui.openView` / `ui.reveal`) - and each of those is a thin route to the
//! authority that already owns the question:
//!
//! - settings go to the engine through `HostRuntime::plugin_config*` (nothing here stores a second
//!   copy; `rules.md#plugin-system`), addressed to the workspace the installation was published for,
//!   because the engine keeps one settings file per workspace and a project installation only exists
//!   in one;
//! - a command registration is stamped into the installation's run-time registry, which is bounded
//!   by `MAX_REGISTERED_COMMANDS` and dies with the process;
//! - a view is *asked for*, not drawn here: the shell is told (`plugin-view`) and the page's own
//!   registry decides whether the installation declares that view at all.
//!
//! The refusal vocabulary is therefore three vocabularies that already existed: the bridge's tokens
//! for a gate, the worker's for its own methods, and this side's for a process that cannot be called
//! at all. Nothing here invents a fourth.

use std::collections::BTreeSet;
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use crate::services::plugins::audit;
use crate::services::plugins::bridge::{
    self, BridgeCall, BridgeMethod, Judgement, RefusalOrRequest,
};
use crate::services::plugins::gates::FsRoots;
use crate::services::plugins::pages::PluginPage;
use crate::services::plugins::protocol::LiveEffects;
use crate::services::plugins::validate::{validate_setting_key_length, validate_setting_value};
use crate::state::AppState;

use super::{
    ProcessInstall, Settlement, COMMAND_PERMISSION, MAX_REGISTERED_COMMANDS, VIEW_PERMISSION,
};

/// The event a worker's `ui.openView` / `ui.reveal` delivers.
///
/// The shell is the only side that can show a docked view, and a process has no document to draw in,
/// so the call is a request: the payload names the installation and the view, and the front end's
/// view host opens (or reveals) it. Nothing is claimed about whether a view was on screen - an
/// installation whose view the shell does not render is simply not shown, which is the same answer a
/// disabled plugin's page gets.
pub(crate) const VIEW_EVENT: &str = "plugin-view";

/// The longest command id this side accepts (`PLUGIN_DESKTOP_COMMAND_ID`, mirrored).
const COMMAND_ID_MAX: usize = 64;

/// Answers one `worker_invoke`, on a thread the reader does not wait for.
///
/// `app` is `None` in the supervisor's own tests: the gates that are pure judgements still run (a
/// missing permission is refused), and a call that would need the application to act is refused as
/// `internal` rather than pretending to have done something.
pub(super) fn dispatch(
    app: Option<&tauri::AppHandle>,
    install: &ProcessInstall,
    commands: &Mutex<BTreeSet<String>>,
    method: &str,
    params: &Value,
) -> Settlement {
    match method {
        "plugin.settings.get" => settings_get(app, install),
        "plugin.settings.set" => settings_set(app, install, params),
        "command.register" => register_command(install, commands, params),
        "command.unregister" => unregister_command(install, commands, params),
        "ui.openView" => open_view(app, install, params, false),
        "ui.reveal" => open_view(app, install, params, true),
        other => bridge_call(app, install, other, params),
    }
}

// ---- the bridge's own methods ----

/// One call the bridge already serves, judged and performed exactly as a page's call is.
///
/// The two page-only methods are refused rather than mapped: `ready` is a document announcing its
/// bridge, and `close` closes the calling window - a process is neither, and answering either with
/// something invented would be a second meaning for one name.
fn bridge_call(
    app: Option<&tauri::AppHandle>,
    install: &ProcessInstall,
    method: &str,
    params: &Value,
) -> Settlement {
    let Some(parsed) = BridgeMethod::parse(method) else {
        return unknown_method(method);
    };
    if matches!(parsed, BridgeMethod::Ready | BridgeMethod::Close) {
        return unknown_method(method);
    }
    let Ok(body) = serde_json::to_vec(&json!({ "m": method, "params": params })) else {
        return invalid("The call could not be read.");
    };
    let call = BridgeCall::Body(body);
    let page = page_of(install);
    let roots = roots_of(install);
    let Some(app) = app else {
        // No application: the pure half of the gate still answers (a missing permission, a path
        // outside the package, a host the manifest did not list), and anything that would have to
        // *act* is refused. This is what lets the supervisor's own tests prove the refusal relay
        // without a running window.
        return match bridge::judge(&page, &roots, &call, &|_| false) {
            Ok(Judgement::Refuse(refusal)) => refusal_settlement(refusal),
            Ok(_) => internal(),
            Err(_) => unknown_method(method),
        };
    };
    let Some(state) = app.try_state::<AppState>() else {
        return internal();
    };
    let key = install.key();
    let mut effects = LiveEffects::for_process(
        app,
        &state,
        &page,
        &key,
        crate::services::presence::MAIN_WINDOW,
    );
    match bridge::answer(&page, &roots, &call, &mut effects) {
        Ok(answer) => settlement_of_answer(&answer),
        Err(RefusalOrRequest::Refused(refusal)) => refusal_settlement(refusal),
        Err(RefusalOrRequest::Request) => unknown_method(method),
    }
}

/// The installation as the bridge judges it: the same granted block, the same root, no pages.
///
/// The page list is empty because a worker has no document of its own; the bridge reads only the
/// grants, the identity and the root out of this value, and all three are the installation's.
fn page_of(install: &ProcessInstall) -> PluginPage {
    PluginPage {
        plugin_id: install.plugin_id.clone(),
        name: install.name.clone(),
        scope: install.scope.clone(),
        root: install.root.clone(),
        enabled: install.enabled,
        revision: install.revision.clone(),
        pages: Vec::new(),
        theme_assets: Vec::new(),
        renderer_module: None,
        grants: install.grants.clone(),
    }
}

/// The roots a process's file gates resolve against: its workspace, then its own package.
fn roots_of(install: &ProcessInstall) -> FsRoots {
    FsRoots {
        workspace: install.workspace.clone(),
        plugin: install.root.clone(),
    }
}

// ---- the engine's settings (D3: the engine stays authoritative) ----

/// `plugin.settings.get`: the engine's own settings for this installation, read through the frames
/// the settings page uses.
fn settings_get(app: Option<&tauri::AppHandle>, install: &ProcessInstall) -> Settlement {
    let Some((state, cwd)) = settings_target(app, install) else {
        return scope_mismatch();
    };
    match tauri::async_runtime::block_on(
        state
            .runtime
            .plugin_config(cwd.as_deref(), &install.plugin_id),
    ) {
        Ok(settings) => match serde_json::to_value(&settings) {
            Ok(value) => Settlement::ok(value),
            Err(_) => internal(),
        },
        Err(error) => Settlement::refused(error.code.to_string(), error.message),
    }
}

/// `plugin.settings.set`: one value, checked against the schema the engine just reported and written
/// through the engine's own frame.
///
/// The checks are the settings command's (`commands::plugins::engine_plugin_config_set`): the key is
/// bounded and has to be one the plugin declares, and the value has to fit that key's schema. A
/// plugin's own process is not a reason to write something the form would refuse.
fn settings_set(
    app: Option<&tauri::AppHandle>,
    install: &ProcessInstall,
    params: &Value,
) -> Settlement {
    let Some(key) = params
        .get("key")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|key| !key.is_empty())
    else {
        return invalid("A settings write needs a key.");
    };
    if let Err(error) = validate_setting_key_length(key) {
        return Settlement::refused(error.code.to_string(), error.message);
    }
    let value = params.get("value").cloned().unwrap_or(Value::Null);
    let Some((state, cwd)) = settings_target(app, install) else {
        return scope_mismatch();
    };
    let settings = match tauri::async_runtime::block_on(
        state
            .runtime
            .plugin_config(cwd.as_deref(), &install.plugin_id),
    ) {
        Ok(settings) => settings,
        Err(error) => return Settlement::refused(error.code.to_string(), error.message),
    };
    let Some(schema) = settings.schema.get(key) else {
        return invalid("The plugin declares no such setting.");
    };
    if let Err(error) = validate_setting_value(schema, &value) {
        return Settlement::refused(error.code.to_string(), error.message);
    }
    match tauri::async_runtime::block_on(state.runtime.plugin_config_set(
        cwd.as_deref(),
        &install.plugin_id,
        key,
        value,
        false,
    )) {
        Ok(written) => match serde_json::to_value(&written) {
            Ok(value) => {
                audit::config_set(&install.plugin_id, Some(&install.scope));
                Settlement::ok(value)
            }
            Err(_) => internal(),
        },
        Err(error) => Settlement::refused(error.code.to_string(), error.message),
    }
}

/// The application state and the workspace a settings call addresses, or `None` when a project
/// installation has no workspace to address.
///
/// That last case is the plan's `plugin_scope_mismatch` (§6.3): the engine keys a project
/// installation's settings by the workspace it lives in, so a call with no workspace would either
/// read the user-scope file (a different installation) or guess. Refusing is the honest answer.
fn settings_target<'a>(
    app: Option<&'a tauri::AppHandle>,
    install: &ProcessInstall,
) -> Option<(tauri::State<'a, AppState>, Option<String>)> {
    let app = app?;
    if install.is_project() && install.workspace.is_none() {
        return None;
    }
    let state = app.try_state::<AppState>()?;
    let cwd = install
        .workspace
        .as_ref()
        .map(|path| path.to_string_lossy().into_owned());
    Some((state, cwd))
}

fn scope_mismatch() -> Settlement {
    Settlement::refused(
        "plugin_scope_mismatch",
        "A project-scope plugin needs its workspace to reach its settings.",
    )
}

// ---- the command registry ----

/// `command.register`: one id stamped into the installation's run-time registry.
///
/// The permission is the manifest's (`command.register`), and the registry is the process's: it is
/// bounded by [`MAX_REGISTERED_COMMANDS`] and goes away with the child, so a plugin cannot grow this
/// side's memory and a restarted process starts from what its code registers again.
fn register_command(
    install: &ProcessInstall,
    commands: &Mutex<BTreeSet<String>>,
    params: &Value,
) -> Settlement {
    if !install.grants.declares(COMMAND_PERMISSION) {
        return Settlement::refused(
            "permission_denied",
            "This plugin did not declare the permission this call needs.",
        );
    }
    let Some(id) = command_id(params) else {
        return invalid("A command registration needs an id of the declared shape.");
    };
    let mut held = lock(commands);
    if held.contains(&id) {
        return Settlement::refused(
            "invalid_request",
            "That command is already registered by this process.",
        );
    }
    if held.len() >= MAX_REGISTERED_COMMANDS {
        return Settlement::refused(
            "too_many_requests",
            "This process has registered as many commands as this build allows.",
        );
    }
    held.insert(id);
    Settlement::ok(Value::Null)
}

/// `command.unregister`: the entry leaves the registry. Removing what is not there is not a failure.
fn unregister_command(
    install: &ProcessInstall,
    commands: &Mutex<BTreeSet<String>>,
    params: &Value,
) -> Settlement {
    if !install.grants.declares(COMMAND_PERMISSION) {
        return Settlement::refused(
            "permission_denied",
            "This plugin did not declare the permission this call needs.",
        );
    }
    let Some(id) = command_id(params) else {
        return invalid("A command registration needs an id of the declared shape.");
    };
    lock(commands).remove(&id);
    Settlement::ok(Value::Null)
}

/// One command id of the shape both sides serve (`PLUGIN_DESKTOP_COMMAND_ID`).
fn command_id(params: &Value) -> Option<String> {
    let id = params.get("id").and_then(Value::as_str)?.trim();
    if id.is_empty() || id.chars().count() > COMMAND_ID_MAX {
        return None;
    }
    let mut characters = id.chars();
    if !characters.next()?.is_ascii_alphabetic() {
        return None;
    }
    if !characters
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.'))
    {
        return None;
    }
    Some(id.to_owned())
}

// ---- the views ----

/// `ui.openView` / `ui.reveal`: the shell is told which view this installation asks for.
///
/// The view has to be one the installation declares (the page registry holds it) and `ui.view` has
/// to be declared, which is the same pair of facts the block's own re-check requires of a `views[]`
/// entry. What happens next is the shell's: it opens the entry's tab, or brings an open one forward
/// when `reveal` asked for it.
fn open_view(
    app: Option<&tauri::AppHandle>,
    install: &ProcessInstall,
    params: &Value,
    reveal: bool,
) -> Settlement {
    if !install.grants.declares(VIEW_PERMISSION) {
        return Settlement::refused(
            "permission_denied",
            "This plugin did not declare the permission this call needs.",
        );
    }
    let Some(entry_id) = params
        .get("entryId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty() && id.chars().count() <= 64)
    else {
        return invalid("A view call needs an entryId.");
    };
    let Some(app) = app else {
        return internal();
    };
    let Some(state) = app.try_state::<AppState>() else {
        return internal();
    };
    let Some(page) = state.pages.find(&install.plugin_id, &install.scope) else {
        return Settlement::refused(
            "not_found",
            "This plugin's pages are not loaded; refresh the plugin list and try again.",
        );
    };
    if !page.pages.iter().any(|declared| declared.id == entry_id) {
        return Settlement::refused("not_found", "This plugin declares no such view.");
    }
    let payload = json!({
        "pluginId": install.plugin_id,
        "scope": install.scope,
        "entryId": entry_id,
        "reveal": reveal,
    });
    match app.emit(VIEW_EVENT, payload) {
        Ok(()) => Settlement::ok(Value::Null),
        Err(_) => internal(),
    }
}

// ---- the shared vocabulary ----

/// One bridge envelope as the worker's settlement: a success carries the page's `result`, a refusal
/// its `code` and `message`.
fn settlement_of_answer(answer: &Value) -> Settlement {
    let ok = answer.get("ok").and_then(Value::as_bool).unwrap_or(false);
    if ok {
        return Settlement::ok(answer.get("result").cloned().unwrap_or(Value::Null));
    }
    Settlement::refused(
        answer
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("internal"),
        answer
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("The call was refused."),
    )
}

fn refusal_settlement(refusal: bridge::Refusal) -> Settlement {
    Settlement::refused(refusal.code, refusal.message)
}

fn invalid(message: &str) -> Settlement {
    Settlement::refused("invalid_request", message)
}

fn internal() -> Settlement {
    Settlement::refused("internal", "The call could not be completed.")
}

fn unknown_method(method: &str) -> Settlement {
    Settlement::refused(
        "unknown_method",
        format!("This worker does not serve {method}."),
    )
}

/// Locks a mutex, treating a poisoned one as usable (the registry is one small set).
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn install(permissions: &[&str]) -> ProcessInstall {
        ProcessInstall {
            install: "demo@market".to_owned(),
            plugin_id: "demo".to_owned(),
            name: "Demo".to_owned(),
            scope: "user".to_owned(),
            root: std::path::PathBuf::from("."),
            commands: Vec::new(),
            activation_events: Vec::new(),
            renderer_call_methods: Vec::new(),
            grants: crate::services::plugins::pages::PageGrants {
                permissions: permissions.iter().map(|name| (*name).to_owned()).collect(),
                ..crate::services::plugins::pages::PageGrants::default()
            },
            enabled: true,
            workspace: None,
            auto_restart: true,
            revision: "1.0.0\u{0}main.js".to_owned(),
        }
    }

    /// A method this build does not serve is `unknown_method`, and the two page-only bridge methods
    /// are refused there too: a process has no document to announce and no window to close.
    #[test]
    fn an_unserved_method_is_unknown() {
        let demo = install(&[]);
        let registry = Mutex::new(BTreeSet::new());
        let params = Value::Null;
        for method in ["ready", "close", "fs.copy", ""] {
            assert_eq!(
                dispatch(None, &demo, &registry, method, &params)
                    .code
                    .as_deref(),
                Some("unknown_method"),
                "{method}"
            );
        }
    }

    /// A registration without the permission is refused by the manifest's own rule, and with it the
    /// registry stays empty; the bound is the host's command ceiling.
    #[test]
    fn a_command_registration_needs_the_permission_and_the_shape() {
        let registry = Mutex::new(BTreeSet::new());
        without_permission(&registry);
        with_permission(&registry);
    }

    fn without_permission(registry: &Mutex<BTreeSet<String>>) {
        let demo = install(&[]);
        let params = json!({ "id": "demo.open" });
        let refusal = dispatch(None, &demo, registry, "command.register", &params);
        assert_eq!(refusal.code.as_deref(), Some("permission_denied"));
        assert!(lock(registry).is_empty());
    }

    fn with_permission(registry: &Mutex<BTreeSet<String>>) {
        let demo = install(&["command.register"]);
        let ok = dispatch(
            None,
            &demo,
            registry,
            "command.register",
            &json!({ "id": "demo.open" }),
        );
        assert!(ok.ok);
        assert!(lock(registry).contains("demo.open"));
        assert_eq!(
            dispatch(
                None,
                &demo,
                registry,
                "command.register",
                &json!({ "id": "demo.open" })
            )
            .code
            .as_deref(),
            Some("invalid_request"),
            "the same id twice is one registration"
        );
        assert_eq!(
            dispatch(
                None,
                &demo,
                registry,
                "command.register",
                &json!({ "id": "not a command" })
            )
            .code
            .as_deref(),
            Some("invalid_request")
        );
        assert!(
            dispatch(
                None,
                &demo,
                registry,
                "command.unregister",
                &json!({ "id": "demo.open" })
            )
            .ok
        );
        assert!(lock(registry).is_empty());
    }

    /// A file read without `fs.read` is refused by the bridge's own gate, which is what proves the
    /// worker's calls cannot buy a permission the manifest did not declare.
    #[test]
    fn the_bridge_gate_answers_a_worker_without_its_permission() {
        let demo = install(&[]);
        let registry = Mutex::new(BTreeSet::new());
        let refusal = dispatch(
            None,
            &demo,
            &registry,
            "fs.read",
            &json!({ "path": "notes.md" }),
        );
        assert_eq!(refusal.code.as_deref(), Some("permission_denied"));
        assert!(!refusal.ok);
    }

    /// A settings write needs a workspace when the installation is a project one, which is the
    /// plan's `plugin_scope_mismatch` (§6.3) - and the tests have no application, so this is also
    /// the one answer that does not depend on a running host.
    #[test]
    fn a_project_installation_without_a_workspace_cannot_reach_its_settings() {
        let mut demo = install(&[]);
        demo.scope = "project".to_owned();
        let registry = Mutex::new(BTreeSet::new());
        let refusal = dispatch(None, &demo, &registry, "plugin.settings.get", &Value::Null);
        assert_eq!(refusal.code.as_deref(), Some("plugin_scope_mismatch"));
    }
}
