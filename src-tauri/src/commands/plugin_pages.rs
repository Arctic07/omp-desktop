//! The commands that put a plugin's own pages on screen: the registry every list read publishes,
//! and the one command that opens a panel as a window of its own.
//!
//! They live apart from the rest of the plugin commands because they answer a different question.
//! `commands::plugins` is about *what is installed* - the engine's registries, the writes that change
//! them, the consent chain - while everything here is about the files a plugin ships and the surfaces
//! this application gives them: the asset registry the custom protocol reads
//! (`services::plugins::pages`) and the panel windows (`services::plugins::panels`).
//!
//! The two are tied together by [`publish_pages`], which every plugin-list read calls before its
//! answer goes out: the list is the only thing this process knows about the installed plugins, so
//! publishing it here is what makes the pages of a plugin that was just disabled stop loading in the
//! same answer the page renders.

use std::collections::{BTreeSet, HashSet};
use std::path::PathBuf;

use tauri::State;

use crate::errors::{IpcError, INVALID_INPUT, PLUGIN_PAGE_UNAVAILABLE};
use crate::models::plugins::{
    identity, recheck_desktop, EngineDesktopBlock, EnginePluginRow, EnginePluginsView,
};
use crate::services::log;
use crate::services::plugins::audit;
use crate::services::plugins::builtin;
use crate::services::plugins::consent;
use crate::services::plugins::pages::{self, PageKind, PluginPage};
use crate::services::plugins::panels::panel_title;
use crate::services::plugins::process;
use crate::services::plugins::prompt::PromptAnswer;
use crate::services::plugins::validate::{sanitize_id, sanitize_scope};
use crate::state::AppState;

/// Hands one freshly read plugin list to the page registry, and closes what it no longer serves.
///
/// The list is also the only thing this process knows about the installed plugins: what each one's
/// `omp.desktop` block declares, where its files are, and whether the engine is running it. So the
/// same read is published to the custom protocol (`services::plugins::pages`), which is what makes a
/// plugin that was just disabled stop being served in the very answer the page renders, and closes
/// the windows of any installation the new list no longer serves - or whose package changed under
/// them (an upgrade), because a window opened for the previous package would otherwise keep loading
/// the new one's files (spec §7.2).
pub(crate) async fn publish_pages(
    app: &tauri::AppHandle,
    state: &AppState,
    view: &mut EnginePluginsView,
    workspace: Option<&str>,
    workspace_key: Option<&str>,
) {
    // The one place this side's own fact is written onto a host list, before anything reads it: the
    // reserved installation is marked built-in only when the marketplace it came from has been
    // verified to be the bundle this application shipped with. Every list the page receives - a read,
    // an install, a switch - passes through here, so a later answer cannot lose the mark.
    builtin::apply_trust(view, state.builtin_sync.trusted());
    // The confirmations the named workspace can see, read once: a process block's availability is
    // the user's recorded answer for *that installation*, and asking the store per row would be one
    // query per plugin. A store that cannot answer is read as no confirmations - the fail-closed
    // direction, because the only thing this decides is whether code may run.
    let grants = match state.store.plugin_grants(workspace_key).await {
        Ok(grants) => grants,
        Err(error) => {
            log::warn(&format!(
                "the plugin confirmations could not be read, so no process is available: {}",
                error.message
            ));
            Vec::new()
        }
    };
    let workspace_path = workspace.map(PathBuf::from);
    let mut served: Vec<PluginPage> = Vec::new();
    let mut installs: Vec<crate::services::plugins::process::ProcessInstall> = Vec::new();
    for row in view.plugins.iter_mut() {
        // One reading of the block per row, shared by the pages it declares, the verdict on its
        // process block and the descriptor a worker is started from: three readers of one parse.
        let checked = recheck_desktop(row);
        if let Some(page) = rechecked_page(row, checked.as_ref()) {
            served.push(page);
        }
        let plugin_id = identity::plugin_id(row).into_owned();
        let declared = checked.as_ref().is_some_and(|block| {
            block.valid
                && block
                    .permissions
                    .iter()
                    .any(|name| name == process::PROCESS_PERMISSION)
        });
        let granted = consent::is_granted(&grants, &plugin_id, &row.scope);
        let verdict = process::availability(row.builtin, &plugin_id, declared, granted);
        // The verdict travels on the row, in the block the page reads: a page must not decide for
        // itself whether an installation may run a process (plan D3), and the two tokens are its
        // only wording.
        if let Some(declared_process) = row
            .desktop
            .as_mut()
            .and_then(|block| block.process.as_mut())
        {
            declared_process.available = verdict.is_ok();
            declared_process.reason = verdict.err().map(str::to_owned);
        }
        if let Some(install) =
            process::install_of(row, checked.as_ref(), granted, workspace_path.as_deref())
        {
            installs.push(install);
        }
    }
    let live: HashSet<String> = served
        .iter()
        .filter(|page| page.enabled)
        .map(|page| pages::origin_key(&page.plugin_id, &page.scope))
        .collect();
    let changed = state.pages.publish(served);
    let open = state.panels.keys();
    for key in keys_to_close(&live, &changed, &open) {
        state.panels.close_all_for_key(app, &key);
        // The installation's own browser page goes with the window, for the same reason and by the
        // same key: it is keyed by this installation key, nothing draws it (a plugin's page is
        // `headless`), and an installation that is gone or whose package changed must not keep a
        // hosted WebView2 guest running - the plugin gets a new page on its next `browser.*` call.
        // Closing a webview is main-thread work, so it is dispatched.
        if let Some(browser) = state.browser.clone() {
            let owner = key.clone();
            let _ = app.run_on_main_thread(move || browser.close_session(&owner));
        }
        // A window that closes here is one whose package may have changed under it (an upgrade) or
        // whose installation is gone: either way the answers the user gave for that installation are
        // answers about a package that is no longer the one running, so they go with it
        // (spec §6.3-4: a session grant is memory-only, and this is what ends it).
        state.session_grants.forget(&key);
        // A question asked about the package that just changed has no answer worth having: it is
        // dropped, and the call parked on it reads the closed channel as a denial. The delete brake
        // goes with it: it counts what *this* package did.
        state.prompts.clear(&key);
        state.delete_budget.forget(&key);
    }
    // The same list is the process supervisor's: an installation that is gone loses its row, one
    // whose package changed is stopped, one the engine no longer runs is stopped, and a new one is
    // recorded for the first call to wake (plan §6.4). The `onStartup` half of `activationEvents`
    // then fires here, on the supervisor's own thread: a list read is where an installation first
    // becomes known, and this answer must not wait for - or fail with - a child's handshake.
    state.plugin_process.sync(installs);
    state.plugin_process.start_on_startup();
}

/// Which installations' panel windows the new list closes.
///
/// Two reasons to close: the installation changed (`changed`, from [`pages::PluginPages::publish`]) -
/// an upgraded package means an open window runs the previous version's document against the new
/// one's files - or it is no longer served live (`open` minus `live`) - disabled or uninstalled. The
/// answer is deduplicated and ordered, so a key is closed once and the same list always produces the
/// same closes. Closing a key with no open window is a no-op in
/// [`crate::services::plugins::panels::PluginPanels::close_all_for_key`], so a changed key is passed
/// even when it has none.
pub(crate) fn keys_to_close(
    live: &HashSet<String>,
    changed: &[String],
    open: &HashSet<String>,
) -> Vec<String> {
    let mut keys: BTreeSet<String> = BTreeSet::new();
    keys.extend(changed.iter().cloned());
    for key in open {
        if !live.contains(key) {
            keys.insert(key.clone());
        }
    }
    keys.into_iter().collect()
}

/// One host row as this process serves it: the block re-checked here, then projected.
///
/// The re-check happens once, before anything is published, because both answers this function hands
/// out - the pages the asset protocol serves and the gates the bridge judges by - are answers to "may
/// this installation do that", and a block this side refuses must contribute neither. Leaving it to
/// the page-facing conversion (`models::plugins::PluginRowView::from`) would let the UI report
/// "refused" while the protocol still served the pages and the gates still honoured its scope.
///
/// `checked` is the caller's one reading of the block (`recheck_desktop`), shared with the process
/// verdict on the same row: a list read parses each block once for all three readers.
fn rechecked_page(
    row: &EnginePluginRow,
    checked: Option<&EngineDesktopBlock>,
) -> Option<PluginPage> {
    let assets = pages::theme_assets_of(row, checked);
    let mut rechecked = row.clone();
    rechecked.desktop = checked.cloned();
    let page = page_of_row(&rechecked, assets)?;
    audit_theme_css(row, &page, checked);
    Some(page)
}

/// Records the one line a theme's stylesheet leaves in the trail, once per package revision.
///
/// "Applied" is what this process can actually observe: a sanitised stylesheet was produced for an
/// installation the engine is running, so the row the page paints from carries text it can inject.
/// The judgement about which theme the user then picks is the page's, and it is not a fact this side
/// has. The dedupe key is the installation, the revision of the package those themes were read from
/// and the theme itself (`services::plugins::audit::theme_css_applied`), because a plugin list is
/// read again on every settings visit and the trail is about the content, not about the reads.
fn audit_theme_css(
    row: &EnginePluginRow,
    page: &PluginPage,
    desktop: Option<&crate::models::plugins::EngineDesktopBlock>,
) {
    if !page.enabled {
        return;
    }
    let Some(desktop) = desktop.filter(|block| block.valid) else {
        return;
    };
    let install = row.install_id.as_deref().unwrap_or(&row.id);
    for theme in desktop
        .themes
        .iter()
        .filter(|theme| theme.css.as_deref().is_some_and(|css| !css.is_empty()))
    {
        audit::theme_css_applied(&row.id, &row.scope, install, &page.revision, &theme.id);
    }
}

/// One host row as the registry holds it, or `None` when the row serves nothing.
///
/// A row without a root path (`rootPath` is host material, and a row that never had one could not be
/// read) contributes nothing; a row that declares pages or theme assets is published whether or not
/// the engine runs it, because "installed but disabled" is a state the resolver answers with `403` -
/// which is a different fact than an origin nobody serves.
///
/// The row's `omp.desktop` block is read exactly once: the revision is derived from the pages that
/// same reading produced ([`pages::revision_from`]), so a list read never parses a row twice.
fn page_of_row(row: &EnginePluginRow, theme_assets: Vec<String>) -> Option<PluginPage> {
    let root = row.root_path.as_ref()?.trim();
    if root.is_empty() {
        return None;
    }
    let declared = pages::pages_of(row);
    // The slot module is carried only from a block both readers accept: a refused block serves
    // nothing, and the module is the most reach this boundary can serve (plan D2). It counts as a
    // contribution of its own: a plugin whose only desktop part is a slot module still has to be
    // published, or the fixed slot host would answer `404` for a module the row just offered a URL
    // for.
    let renderer_module = row
        .desktop
        .as_ref()
        .filter(|block| block.valid)
        .and_then(|block| block.renderer.as_ref())
        .and_then(|renderer| renderer.path.clone());
    if declared.is_empty() && theme_assets.is_empty() && renderer_module.is_none() {
        return None;
    }
    Some(PluginPage {
        plugin_id: row.id.clone(),
        name: row.name.clone(),
        scope: row.scope.clone(),
        root: PathBuf::from(root),
        enabled: row.enabled,
        revision: pages::revision_from(
            row.version.as_deref().unwrap_or_default(),
            &declared,
            renderer_module.as_deref(),
        ),
        pages: declared,
        theme_assets,
        renderer_module,
        grants: grants_of_row(row),
    })
}

/// The declaration one installation's pages are judged by.
///
/// A block the host refused contributes nothing, which is also how a refused block behaves
/// everywhere else (spec §3.3): its permissions are *carried* on the row - the consent gate needs
/// those facts - but nothing about it may load, so nothing about it may authorize a bridge call
/// either. That is why the list here is taken from a valid block only. The row this reads is the one
/// [`rechecked_page`] already put through this side's own re-check, so "valid" here means "valid by
/// both readers".
fn grants_of_row(row: &EnginePluginRow) -> pages::PageGrants {
    let Some(block) = row.desktop.as_ref().filter(|block| block.valid) else {
        return pages::PageGrants::default();
    };
    pages::PageGrants {
        permissions: block.permissions.clone(),
        fs_scopes: pages::FsScopes {
            read: block.fs_scopes.read.clone(),
            write: block.fs_scopes.write.clone(),
            delete: block.fs_scopes.delete.clone(),
        },
        net_domains: block.net_domains.clone(),
        // The flag is the block's; whether it is a *reach* is `PageGrants::net_policy`'s answer,
        // which also reads the permission (so a row that declared the flag alone reaches nothing).
        net_any_host: block.net_any_host,
        // These are a page's grants: the resident-process-only capabilities (`bus.subscribe`) are
        // refused for them by the gate itself.
        resident: false,
    }
}

/// Opens one panel a plugin declares as a window of its own.
///
/// The name that arrives is the plugin's and the panel's, never a URL: what is loaded is built here
/// from the manifest the host validated and this process re-checked
/// (`services::plugins::pages`), so a caller cannot address a page the plugin did not declare, a
/// file outside its entry's bundle, or an origin it does not own. What the panel asked for is
/// honoured too - its size, whether it may be resized, and the title the page would have drawn - and
/// the window carries no capability at all, because this application's capabilities name the `main`
/// window (`capabilities/default.json`), which is the second half of the sandbox on top of the page
/// having no IPC injected into it.
///
/// The installation has to be one this process is serving: an id that was never published, a scope
/// the address does not hold, or a plugin the engine is not running is refused rather than opened.
#[tauri::command]
pub(crate) async fn engine_plugin_panel_open(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    plugin_id: String,
    scope: String,
    panel_id: String,
    title: Option<String>,
) -> Result<(), IpcError> {
    let plugin_id = sanitize_id(&plugin_id)?;
    let scope = sanitize_scope(Some(&scope))?.ok_or_else(|| {
        IpcError::new(
            PLUGIN_PAGE_UNAVAILABLE,
            "A panel is opened for one installation, so its scope has to be named.",
        )
    })?;
    let panel_id = panel_id.trim();
    if panel_id.is_empty() || panel_id.len() > 64 {
        return Err(IpcError::new(
            PLUGIN_PAGE_UNAVAILABLE,
            "That is not a panel this plugin declares.",
        ));
    }
    let page = state.pages.find(&plugin_id, scope).ok_or_else(|| {
        IpcError::new(
            PLUGIN_PAGE_UNAVAILABLE,
            "This plugin's pages are not loaded; refresh the plugin list and try again.",
        )
    })?;
    // The title the page would have drawn comes from the page itself (it is the one that resolved
    // the manifest's titles for its language); the manifest's own titles are the fallback.
    let title = panel_title(
        title.as_deref(),
        page.page(PageKind::Panel, panel_id)
            .and_then(|panel| panel.title.as_ref()),
        &page.name,
        &page.plugin_id,
    );
    // The workspace this window is opened from travels with it: the panel belongs to the workspace
    // the user was looking at, and reads that one's files for as long as it is open.
    let workspace = state.plugin_workspace();
    let label = state.panels.open(&app, &page, panel_id, title, workspace)?;
    log::info(&format!(
        "plugin panel opened: plugin={plugin_id} panel={panel_id} label={label}"
    ));
    Ok(())
}

/// Answers one question a plugin page's bridge call raised (spec §6.3-4).
///
/// The call that asked is parked on this answer, so the command is what unblocks it; `false` says
/// the question was no longer open - the caller's wait timed out, the installation was re-published,
/// or the same card was answered twice. That is an ordinary outcome rather than an error: the call
/// was denied, the user's click simply arrived after the fact, and reporting it lets the page drop
/// the card instead of showing one that addresses nothing.
#[tauri::command]
pub(crate) async fn plugin_prompt_answer(
    state: State<'_, AppState>,
    id: u64,
    answer: String,
) -> Result<bool, IpcError> {
    let Some(answer) = PromptAnswer::parse(&answer) else {
        return Err(IpcError::new(
            INVALID_INPUT,
            "That is not an answer this build accepts.",
        ));
    };
    Ok(state.prompts.answer(id, answer))
}

/// Tells this process which workspace the shell is showing.
///
/// The file gates resolve a plugin page's paths against that workspace first (spec §6.3): a plugin
/// that reads the user's project is reading what the user opened, and the shell is the only thing
/// that knows which project that is. `null` is a shell with no workspace, which leaves the gates with
/// the installation's own package rather than with a guess.
#[tauri::command]
pub(crate) async fn engine_plugin_workspace_set(
    state: State<'_, AppState>,
    workspace_id: Option<i64>,
) -> Result<(), IpcError> {
    let root = match workspace_id {
        None => None,
        Some(id) => Some(PathBuf::from(state.store.get_project(id).await?.root_path)),
    };
    state.set_plugin_workspace(root);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(items: &[&str]) -> HashSet<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    /// The closes a new list asks for: an installation that changed (a new key, or a moved revision)
    /// and one whose windows are open but which the new list no longer serves live. An unchanged,
    /// still-live installation is never closed.
    #[test]
    fn the_new_list_closes_changed_and_no_longer_live_installations() {
        // `gone` is open but no longer served live, which is the other reason a key is closed; it
        // must not be in `live`, or the assertion below would contradict itself.
        let live = keys(&["kept"]);
        let changed = vec!["upgraded".to_owned()];
        let open = keys(&["upgraded", "gone", "kept"]);

        let closed = keys_to_close(&live, &changed, &open);
        assert!(
            closed.contains(&"upgraded".to_owned()),
            "a changed key is closed: {closed:?}"
        );
        assert!(
            closed.contains(&"gone".to_owned()),
            "an unserved open key is closed: {closed:?}"
        );
        assert!(
            !closed.contains(&"kept".to_owned()),
            "a live, unchanged key is left alone: {closed:?}"
        );
        assert_eq!(closed.len(), 2, "each key is closed once: {closed:?}");

        // A changed key with no open window is still answered: closing it is a no-op.
        assert_eq!(
            keys_to_close(&keys(&["a"]), &["b".to_owned()], &keys(&[])),
            vec!["b".to_owned()]
        );
        // Nothing changed and everything open is live: nothing to close.
        assert!(keys_to_close(&keys(&["a"]), &[], &keys(&["a"])).is_empty());
        // A changed key that is also live and open is closed once, not twice.
        assert_eq!(
            keys_to_close(&keys(&["a"]), &["a".to_owned()], &keys(&["a"])),
            vec!["a".to_owned()]
        );
    }
}
