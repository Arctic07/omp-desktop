//! The resident-process half of the plugin commands: the table, its restart, and the two calls a
//! page or a slot component makes into an installation's own worker.
//!
//! These four live apart from `commands::plugins` because they are the only ones that talk to
//! `services::plugins::process` (the supervisor) rather than to the engine's plugin list, the store
//! or the built-in bundle: the split is the supervisor's boundary, not a second command layer.

use serde_json::Value;
use std::sync::Arc;
use tauri::State;

use crate::errors::{
    IpcError, IpcResult, INVALID_INPUT, PLUGIN_PROCESS_CRASHED, PLUGIN_PROCESS_UNAVAILABLE,
};
use crate::models::plugins::{
    EnginePluginCommandRunView, EnginePluginRendererCallView, PluginProcessesView,
};
use crate::services::plugins::validate::{sanitize_id, sanitize_scope};
use crate::state::AppState;

use super::plugin_pages::publish_pages;
use super::plugins::workspace_key;
use super::workspace_cwd;

/// Every resident plugin process this supervisor holds, and the answer to a restart.
///
/// The table is the process's own, not one workspace's: an installation's process belongs to the
/// application, and a reader that switched workspace must not lose sight of one that is still
/// running (`plugin-process` pushes the same table on every change). The workspace is still the
/// *address* the call names, and one this registry does not hold is refused like every other plugin
/// read - a project-scope installation is only reachable from the project it lives in.
#[tauri::command]
pub(crate) async fn engine_plugin_process(
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
) -> Result<PluginProcessesView, IpcError> {
    let _cwd = workspace_cwd(&state, workspace_id).await?;
    Ok(state.plugin_process.snapshot())
}

/// Stops one installation's process and starts it again, answering with the table afterwards.
///
/// The manual restart is the only way out of `crashed` (plan §6.4) - nothing retries past the crash
/// budget and nothing disables the plugin - so the list is read once more first: the usual reason to
/// press it is a confirmation the reader has just given, and the table's verdicts are the previous
/// list's until this read replaces them. A start that fails leaves the row `crashed` with its reason
/// rather than failing the call: the answer is the table as it stands after the attempt.
#[tauri::command]
pub(crate) async fn engine_plugin_process_restart(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
    plugin_id: String,
    scope: String,
) -> Result<PluginProcessesView, IpcError> {
    let cwd = workspace_cwd(&state, workspace_id).await?;
    let key = workspace_key(&state, workspace_id).await?;
    let plugin_id = sanitize_id(&plugin_id)?;
    let scope = sanitize_scope(Some(&scope))?.ok_or_else(|| {
        IpcError::new(
            INVALID_INPUT,
            "A process is restarted for one installation, so its scope has to be named.",
        )
    })?;
    let mut plugins = state.runtime.plugins(cwd.as_deref()).await?;
    publish_pages(&app, &state, &mut plugins, cwd.as_deref(), key.as_deref()).await;
    let process = Arc::clone(&state.plugin_process);
    tauri::async_runtime::spawn_blocking(move || process.restart(&plugin_id, scope))
        .await
        .map_err(|_| {
            IpcError::new(
                PLUGIN_PROCESS_CRASHED,
                "The plugin process could not be restarted.",
            )
        })?
}

/// Runs one command the manifest contributes, through its installation's resident process.
///
/// A refusal is the worker's own answer, not a transport failure: `ok: false` carries the `code` the
/// page states beside the command. A process this side could not reach at all - disabled, no row, a
/// failed start - is the `IpcError` of the same `PLUGIN_PROCESS_*` name, as is an argument this layer
/// refuses or a workspace it does not hold.
#[tauri::command]
pub(crate) async fn engine_plugin_command_run(
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
    plugin_id: String,
    scope: String,
    command_id: String,
) -> Result<EnginePluginCommandRunView, IpcError> {
    let _cwd = workspace_cwd(&state, workspace_id).await?;
    let plugin_id = sanitize_id(&plugin_id)?;
    let scope = sanitize_scope(Some(&scope))?.ok_or_else(|| {
        IpcError::new(
            INVALID_INPUT,
            "A command runs in one installation, so its scope has to be named.",
        )
    })?;
    let command_id = sanitize_command_id(&command_id)?;
    let process = Arc::clone(&state.plugin_process);
    let settlement = tauri::async_runtime::spawn_blocking(move || {
        process.run_command(&plugin_id, scope, &command_id)
    })
    .await
    .map_err(|_| {
        IpcError::new(
            PLUGIN_PROCESS_CRASHED,
            "The plugin command could not be run.",
        )
    })??;
    Ok(EnginePluginCommandRunView {
        ok: settlement.ok,
        value: settlement.value.unwrap_or(Value::Null),
        code: settlement.code,
        message: settlement.message,
    })
}

/// Wakes one installation for an activation event its manifest declares, and answers the table.
///
/// The event comes from the surface that observed it: a plugin page becoming visible names
/// `onView:<entryId>` (the shell is the only party that knows what is on screen). This command is the
/// thin half - it resolves the workspace identity, sanitizes the installation and the event's shape,
/// and hands both to the supervisor, which owns the declaration check (`INVALID_INPUT` naming the
/// event when the package did not declare it), the crash verdict and the start. The answer is the
/// current table, whole, so the page paints the state the start left behind rather than a guess.
///
/// It does not re-read the plugin list: the page that calls it was drawn from a list read, and that
/// read published the descriptor this activation is judged against.
#[tauri::command]
pub(crate) async fn engine_plugin_activate(
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
    plugin_id: String,
    scope: String,
    event: String,
) -> Result<PluginProcessesView, IpcError> {
    let _key = workspace_key(&state, workspace_id).await?;
    let plugin_id = sanitize_id(&plugin_id)?;
    let scope = sanitize_scope(Some(&scope))?.ok_or_else(|| {
        IpcError::new(
            INVALID_INPUT,
            "A process is activated for one installation, so its scope has to be named.",
        )
    })?;
    let event = sanitize_activation_event(&event)?;
    let process = Arc::clone(&state.plugin_process);
    tauri::async_runtime::spawn_blocking(move || process.activate(&plugin_id, scope, &event))
        .await
        .map_err(|_| {
            IpcError::new(
                PLUGIN_PROCESS_UNAVAILABLE,
                "The plugin process could not be activated.",
            )
        })?
}

/// Runs one `plugin.call` from a renderer slot component, through the installation's resident
/// process (plan §7.3, T3's half of the channel).
///
/// The method is checked by the supervisor against the whitelist the installation's descriptor was
/// published from (`rendererCallMethods`, re-read at the desktop boundary): a word outside the
/// method grammar is `PLUGIN_ACTION_UNKNOWN`, one the manifest did not declare is
/// `PLUGIN_ACTION_UNDECLARED`, and neither wakes a process. A process that is absent, disabled or
/// terminally crashed answers `PLUGIN_PROCESS_UNAVAILABLE` / `PLUGIN_PROCESS_CRASHED`. Every one of
/// those is a settlement - `ok: false` with a stable code - not a transport failure, so the slot
/// component states the code; only a malformed argument or an unknown workspace is an `IpcError`.
#[tauri::command]
pub(crate) async fn engine_plugin_renderer_call(
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
    plugin_id: String,
    scope: String,
    method: String,
    params: Option<Value>,
) -> Result<EnginePluginRendererCallView, IpcError> {
    let _cwd = workspace_cwd(&state, workspace_id).await?;
    let plugin_id = sanitize_id(&plugin_id)?;
    let scope = sanitize_scope(Some(&scope))?.ok_or_else(|| {
        IpcError::new(
            INVALID_INPUT,
            "A renderer call runs in one installation, so its scope has to be named.",
        )
    })?;
    let process = Arc::clone(&state.plugin_process);
    let settlement = tauri::async_runtime::spawn_blocking(move || {
        process.call_renderer(&plugin_id, scope, &method, params.unwrap_or(Value::Null))
    })
    .await
    .map_err(|_| {
        IpcError::new(
            PLUGIN_PROCESS_CRASHED,
            "The plugin renderer call could not be run.",
        )
    })?;
    Ok(EnginePluginRendererCallView {
        ok: settlement.ok,
        value: settlement.value.unwrap_or(Value::Null),
        code: settlement.code,
        message: settlement.message,
    })
}

/// The longest command id this layer forwards (`PLUGIN_DESKTOP_COMMAND_ID`, mirrored): the host
/// bounds the same field while reading the manifest, so a longer one names nothing that exists.
const COMMAND_ID_MAX_CHARS: usize = 64;

/// The longest activation event this layer forwards.
///
/// The bound is this layer's own, not the wire's: a declared event is at most `onCommand:` plus the
/// 64-character command id (`COMMAND_ID_MAX_CHARS`), and a view event names a page entry. A longer
/// string cannot match any declaration, so it is refused before the supervisor is asked.
const ACTIVATION_EVENT_MAX_CHARS: usize = 128;

/// One activation event, bounded before it reaches the declaration check.
///
/// The *content* is judged by the supervisor against the installation's own list - that is the only
/// authority over what the package agreed to. This only refuses a value that cannot be one: empty,
/// unbounded, or carrying control characters.
fn sanitize_activation_event(value: &str) -> IpcResult<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > ACTIVATION_EVENT_MAX_CHARS {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The activation event is empty or too long.",
        ));
    }
    if value.chars().any(char::is_control) {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The activation event contains control characters.",
        ));
    }
    Ok(value.to_owned())
}

/// One command id, bounded before it becomes a frame parameter.
fn sanitize_command_id(value: &str) -> IpcResult<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > COMMAND_ID_MAX_CHARS {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The command id is empty or too long.",
        ));
    }
    if value.chars().any(char::is_control) {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The command id contains control characters.",
        ));
    }
    Ok(value.to_owned())
}
