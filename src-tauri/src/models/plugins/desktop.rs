//! The desktop block's own re-check: what this layer does with `omp.desktop` after the host has
//! read it (`rules.md#single-file-line-limit` split).
//!
//! The host parses the manifest and decides what the page reads; this side independently refuses a
//! block that declares a permission, an entry, a title, a token, a scope, a theme content
//! permission or a slot-module shape this build does not serve, prepares each theme's declared
//! stylesheet and assets (`services::plugins::theme_css`), and attaches the URL every page is loaded
//! from. It is the one place a page's address is derived, so nothing outside this process can spell
//! an origin, and a disabled installation keeps its declared pages without an address - the same
//! answer a load would have got. The slot module's own address and verdict (plan §7.1, D2) are
//! finalized here in the same pass (`services::plugins::renderer`).
//!
//! Nothing here decides what a plugin is: the fields are the contract's, and the rules are the
//! ones `rules.md#plugin-system` states for both sides.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use crate::errors::PLUGIN_THEME_CSS_INVALID;
use crate::services::log;
use crate::services::plugins::gates;
use crate::services::plugins::pages;
use crate::services::plugins::renderer;
use crate::services::plugins::theme_css;
use crate::services::plugins::validate::{
    validate_permission_name, validate_renderer_action, validate_renderer_method,
    validate_renderer_path, validate_theme_token, validate_theme_value, RENDERER_ACTIONS_MAX,
    RENDERER_CALL_METHODS_MAX, RENDERER_PERMISSION,
};

use super::{
    EngineDesktopBlock, EngineDesktopPage, EnginePluginRenderer, EnginePluginRow,
    EngineWorkPanelTab, ENGINES_RANGE_MAX,
};

/// Refuses one desktop block: nothing it declares loads, so its four page lists are emptied and the
/// reason is recorded for the diagnostics.
///
/// The contract states the two together (`valid = false` implies four empty lists, spec §9.1), and
/// this is where that invariant is constructed rather than re-checked by every reader: a consumer
/// that reads `desktop.panels` without looking at `valid` must not be handed a page the block was
/// refused for.
fn refuse_desktop(desktop: &mut EngineDesktopBlock, reason: String) {
    desktop.panels.clear();
    desktop.views.clear();
    desktop.settings_destinations.clear();
    desktop.sidebar_tabs.clear();
    desktop.work_panel_tabs.clear();
    desktop.valid = false;
    desktop.reason = Some(reason);
}

/// The desktop block as the page receives it: the block's own checks, then the slot module's
/// verdict and address.
///
/// Split in two so the second half runs on every path the first can leave by (`rules.md#single-file-line-limit`): the
/// block checks are the host's reading re-read here, and they refuse the block whole on the first
/// failure; the renderer finalisation then decides whether the module may be loaded and where from,
/// including for a block that was just refused. A page reads one row, and a row that skipped the
/// second half would hand the frontend `available: false` on a module it could have loaded, or a
/// `url` on one this process will not serve.
pub(crate) fn recheck_desktop(row: &EnginePluginRow) -> Option<EngineDesktopBlock> {
    let mut desktop = recheck_block(row)?;
    finalize_renderer(row, &mut desktop);
    Some(desktop)
}

/// The page lists, themes, permissions and scopes of a block the host read, re-checked on this
/// side, and the URL every page is loaded from attached.
///
/// The row, rather than the block, is what this reads: three of the four facts the re-check needs
/// are the row's, not the block's - the installation's identity (the origin every URL is derived
/// from), whether the engine is running it, and the directory its files are read from (`rootPath`,
/// host material that never reaches the page). `None` means the row declares no desktop block.
fn recheck_block(row: &EnginePluginRow) -> Option<EngineDesktopBlock> {
    let mut desktop = row.desktop.clone()?;
    if !desktop.valid {
        clear_theme_content(&mut desktop);
        return Some(desktop);
    }
    // The themes are read first, before any of the checks that can still refuse the block: the two
    // fields that carry content are paths as the host reports them and text/URLs as the page reads
    // them, so every return path below this point has to be able to hand back the second shape.
    recheck_themes(row, &mut desktop);
    if let Some(unknown) = desktop
        .permissions
        .iter()
        .find(|name| !validate_permission_name(name))
        .cloned()
    {
        desktop.valid = false;
        desktop.reason = Some(format!("unknown_permission:{unknown}"));
        return Some(desktop);
    }
    // The slot module is the most reach a manifest can ask for - code in this application's own
    // document (plan D2) - so its three shapes and its one permission are re-read here, before
    // anything else about the block is honoured. The host refuses the same three shapes
    // (`plugins-desktop-renderer.ts`); this is the boundary copy, and the reason tokens are its
    // vocabulary, so a host that validated more loosely cannot reach the renderer with a path this
    // layer would resolve, an action this build cannot perform, or a method name of another shape.
    if let Some(reason) = recheck_renderer(&desktop) {
        refuse_desktop(&mut desktop, reason);
        return Some(desktop);
    }
    // A theme list needs the permission its own list declares, and declared content needs the content
    // permission, re-read here for the same reason the page lists' are (spec §3.3): a manifest that
    // contributes a token or a stylesheet has to have asked for it, and a host that validated more
    // loosely must not be able to add one on the plugin's behalf. The content question is asked of
    // the host's row, because a theme whose content was refused above no longer carries it.
    if !desktop.themes.is_empty() && !declares(&desktop.permissions, "ui.theme") {
        refuse_desktop(&mut desktop, "entry_permission_missing:ui.theme".to_owned());
        return Some(desktop);
    }
    let declared_content = row.desktop.as_ref().is_some_and(|host| {
        host.themes
            .iter()
            .any(|theme| theme.css.is_some() || !theme.assets.is_empty())
    });
    if declared_content && !declares(&desktop.permissions, "ui.theme.css") {
        refuse_desktop(
            &mut desktop,
            "entry_permission_missing:ui.theme.css".to_owned(),
        );
        return Some(desktop);
    }
    // The scopes are re-read with the rule the host applied (spec §3.3): a pattern whose meaning two
    // implementations would have to agree about by convention is one this side refuses to honour, and
    // a scope it cannot read is a reach nobody can bound - so the block goes, whole. A write or delete
    // scope that names a whole tree is refused for the same reason the host refuses it (spec §3.2):
    // changing or removing everything is not a range.
    let mut scope_refusal: Option<&'static str> = None;
    for (mode, scope) in [
        ("read", &desktop.fs_scopes.read),
        ("write", &desktop.fs_scopes.write),
        ("delete", &desktop.fs_scopes.delete),
    ] {
        if !gates::validate_scope_list(scope) {
            scope_refusal = Some("invalid_fs_scope");
            break;
        }
        if mode != "read"
            && scope
                .iter()
                .any(|pattern| gates::is_whole_tree_scope(pattern))
        {
            scope_refusal = Some("whole_tree_fs_scope");
            break;
        }
    }
    if let Some(reason) = scope_refusal {
        desktop.valid = false;
        desktop.reason = Some(reason.to_owned());
        return Some(desktop);
    }
    // The domain list is re-read for the same reason and answered the other way round: an entry this
    // side cannot read as a host name is *dropped* rather than refusing the block, because a list
    // that loses an entry loses reach. A malformed name is not a declaration to honour, and the
    // remaining names are exactly the hosts the manifest could have meant.
    desktop
        .net_domains
        .retain(|domain| gates::is_host_name(domain));
    // The second key is re-checked as the pair it is (API 0.2.0): the block's flag without the
    // permission is refused whole, exactly as the host refuses it. A widening that reached egress on
    // one boolean would be a reach the consent gate never saw, which is the one thing this check
    // exists to prevent.
    if desktop.net_any_host && !declares(&desktop.permissions, "net.anyHost") {
        refuse_desktop(
            &mut desktop,
            "entry_permission_missing:net.anyHost".to_owned(),
        );
        return Some(desktop);
    }
    // The declared desktop range is metadata, so an unusable one drops the value rather than the
    // block: the page shows a range a reader can act on, and a string this layer would have to
    // truncate is one it should not publish at all.
    desktop.engines_omp_desktop = desktop
        .engines_omp_desktop
        .take()
        .map(|range| range.trim().to_owned())
        .filter(|range| {
            !range.is_empty()
                && range.len() <= ENGINES_RANGE_MAX
                && !range.chars().any(char::is_control)
        });
    // The page lists are the one part of the block that becomes a filesystem lookup and a URL, so
    // every field is re-checked here rather than trusted: the host's own check is about the plugin
    // directory, and this one is about what this process would do with the value.
    let mut refusal: Option<String> = None;
    for (permission, list) in [
        ("ui.panel", &desktop.panels),
        ("ui.view", &desktop.views),
        ("ui.settings", &desktop.settings_destinations),
        ("ui.tab", &desktop.sidebar_tabs),
    ] {
        if list.is_empty() {
            continue;
        }
        if !desktop.permissions.iter().any(|name| name == permission) {
            refusal = Some(format!("entry_permission_missing:{permission}"));
            break;
        }
        if let Some(bad) = list.iter().find(|page| !page_shape_is_valid(page)) {
            refusal = Some(format!("invalid_entry_field:{}", bad.id));
            break;
        }
    }
    if let Some(reason) = refusal {
        refuse_desktop(&mut desktop, reason);
        return Some(desktop);
    }
    // The work-panel tabs are not pages - nothing here becomes a URL or a filesystem lookup - but
    // they are still a contribution this process publishes for the shell to draw, so the same two
    // facts are re-read: the permission the list needs, and the shape of every field. The
    // permission is `ui.view`, the work panel's own (spec §3.2).
    if !desktop.work_panel_tabs.is_empty() {
        if !desktop.permissions.iter().any(|name| name == "ui.view") {
            refuse_desktop(&mut desktop, "entry_permission_missing:ui.view".to_owned());
            return Some(desktop);
        }
        if let Some(bad) = desktop
            .work_panel_tabs
            .iter()
            .find(|tab| !work_panel_tab_is_valid(tab))
        {
            let id = bad.id.clone();
            refuse_desktop(&mut desktop, format!("invalid_entry_field:{id}"));
            return Some(desktop);
        }
    }
    // An id names one page inside one plugin, across all four lists: a duplicate would make two
    // pages indistinguishable to every later message that addresses one of them.
    let mut ids: Vec<&str> = Vec::new();
    for list in [
        &desktop.panels,
        &desktop.views,
        &desktop.settings_destinations,
        &desktop.sidebar_tabs,
    ] {
        ids.extend(list.iter().map(|page| page.id.as_str()));
    }
    ids.extend(desktop.work_panel_tabs.iter().map(|tab| tab.id.as_str()));
    if ids.len() != ids.iter().collect::<HashSet<_>>().len() {
        refuse_desktop(&mut desktop, "duplicate_entry_id".to_owned());
        return Some(desktop);
    }
    if row.enabled {
        for list in [
            &mut desktop.panels,
            &mut desktop.views,
            &mut desktop.settings_destinations,
            &mut desktop.sidebar_tabs,
        ] {
            for page in list.iter_mut() {
                page.url = pages::entry_url(&row.id, &row.scope, &page.entry);
            }
        }
    }
    Some(desktop)
}

/// The renderer block's three reasons (`plugins-desktop-renderer.ts` spells the same tokens): the
/// declarations are refused whole, because half a dispatch table is not the reach its author wrote.
const INVALID_RENDERER_PATH: &str = "invalid_renderer_path";
const INVALID_RENDERER_ACTIONS: &str = "invalid_renderer_actions";
const INVALID_RENDERER_CALL_METHODS: &str = "invalid_renderer_call_methods";

/// Whether one string list has no duplicate entries.
///
/// A whitelist with two spellings of one entry is not the list its author wrote (the host refuses it
/// for the same reason), and deduplicating it here would silently widen what a caller may name.
fn unique(items: &[String]) -> bool {
    items.len() == items.iter().collect::<HashSet<_>>().len()
}

/// Re-reads the slot module's declaration, answering the reason the block is refused or `None`.
///
/// Three shapes and one permission, in the order an author can act on: the module path has to be a
/// bounded relative `.js`/`.mjs` outside `node_modules`; the action list at most
/// [`RENDERER_ACTIONS_MAX`] unique tokens from the closed vocabulary; and the call-method list at
/// most [`RENDERER_CALL_METHODS_MAX`] unique method names. A block that declares any of the three
/// without `renderer.extension` is refused as a missing permission - the same answer a panel without
/// `ui.panel` gets, because the module and both lists are one reach.
fn recheck_renderer(desktop: &EngineDesktopBlock) -> Option<String> {
    let renderer = desktop.renderer.as_ref()?;
    if let Some(path) = renderer.path.as_deref() {
        if !validate_renderer_path(path) {
            return Some(INVALID_RENDERER_PATH.to_owned());
        }
    }
    if renderer.actions.len() > RENDERER_ACTIONS_MAX
        || !unique(&renderer.actions)
        || !renderer
            .actions
            .iter()
            .all(|action| validate_renderer_action(action))
    {
        return Some(INVALID_RENDERER_ACTIONS.to_owned());
    }
    if renderer.call_methods.len() > RENDERER_CALL_METHODS_MAX
        || !unique(&renderer.call_methods)
        || !renderer
            .call_methods
            .iter()
            .all(|method| validate_renderer_method(method))
    {
        return Some(INVALID_RENDERER_CALL_METHODS.to_owned());
    }
    let declares_anything = renderer.path.is_some()
        || !renderer.actions.is_empty()
        || !renderer.call_methods.is_empty();
    if declares_anything && !declares(&desktop.permissions, RENDERER_PERMISSION) {
        return Some(format!("entry_permission_missing:{RENDERER_PERMISSION}"));
    }
    None
}

/// The slot module's verdict and address, written onto the row whatever the block's own verdict is.
///
/// `available` is the conjunction the contract states - the engine runs the installation, the block
/// survived both readers, `renderer.extension` is declared, and the declared file is a real file
/// inside the plugin root - and `url` exists only when it holds, so a page never fetches an address
/// that would answer `404`. When it does not hold, the reason token says which half failed:
/// `renderer_module_unavailable` for a state the user chose (disabled, refused, unpermitted) and
/// `renderer_module_missing` for a declared file that is not there.
///
/// The URL is derived here, from the installation's identity, and never from the declared path: the
/// fixed slot host serves one name per installation (`services::plugins::renderer`), which is what
/// lets one CSP source cover every plugin.
fn finalize_renderer(row: &EnginePluginRow, desktop: &mut EngineDesktopBlock) {
    fn unavailable(renderer: &mut EnginePluginRenderer, reason: &str) {
        renderer.available = false;
        renderer.reason = Some(reason.to_owned());
    }
    // Read before the mutable borrow below: the block's own verdict and its permissions are the two
    // facts that decide whether the declaration is even honour-able.
    let valid = desktop.valid;
    let permitted = declares(&desktop.permissions, RENDERER_PERMISSION);
    let Some(renderer) = desktop.renderer.as_mut() else {
        return;
    };
    renderer.url = None;
    if !row.enabled || !valid || !permitted {
        unavailable(renderer, renderer::REASON_MODULE_UNAVAILABLE);
        return;
    }
    let root = row
        .root_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty());
    let (Some(root), Some(path)) = (root, renderer.path.as_deref()) else {
        unavailable(renderer, renderer::REASON_MODULE_MISSING);
        return;
    };
    if !renderer::module_exists(Path::new(root), path) {
        unavailable(renderer, renderer::REASON_MODULE_MISSING);
        return;
    }
    renderer.available = true;
    renderer.reason = None;
    renderer.url = Some(renderer::module_url(&row.id, &row.scope));
}

/// Reads, bounds and prepares what every theme declared: the tokens it may set, and the stylesheet
/// and assets it may paint with.
///
/// The token names *and values* are re-checked the way the permissions are, and for the same reason:
/// a name this application does not declare would be a property the renderer applies on a plugin's
/// word alone, and a value this layer cannot vouch for would be one it publishes for the renderer to
/// apply. A theme with either goes, whole: half of a theme is not the theme its author wrote, and the
/// rest of the block is unaffected.
///
/// The content half is refused per theme rather than per block (`rules.md#plugin-system`): a
/// stylesheet this layer could not read, bound or sanitise costs that theme its stylesheet - its
/// tokens stay usable, and the row carries `cssError` - because a CSS typo is not a reason to take a
/// plugin's pages down. The two facts are on the row instead of the log alone, so an author can see
/// that what they declared did not apply.
fn recheck_themes(row: &EnginePluginRow, desktop: &mut EngineDesktopBlock) {
    let before = desktop.themes.len();
    desktop.themes.retain(|theme| {
        validate_page_id(&theme.id)
            && theme
                .tokens
                .iter()
                .all(|(name, value)| validate_theme_token(name) && validate_theme_value(value))
    });
    if desktop.themes.len() != before {
        // Dropping a theme is a refusal of what a plugin contributed, so it is said out loud rather
        // than left as a theme whose author cannot explain the absence of.
        log::warn(
            "a plugin theme was dropped at the desktop boundary: its id, a token name or a token value is not one this build declares",
        );
    }
    if desktop.themes.is_empty() {
        return;
    }
    let root = row
        .root_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty());
    let origin = pages::origin_of(&row.id, &row.scope);
    for theme in desktop.themes.iter_mut() {
        let declared_css = theme.css.take();
        let declared_assets = std::mem::take(&mut theme.assets);
        theme.css = None;
        theme.assets.clear();
        theme.css_error = None;
        if declared_css.is_none() && declared_assets.is_empty() {
            continue;
        }
        // Nothing is read for an installation the engine is not running: the row carries no
        // stylesheet to inject and no URL to fetch, which is the same answer a fetch would get. The
        // content was not *refused*, so `cssError` stays null - the row's own `enabled` says why.
        if !row.enabled {
            continue;
        }
        let prepared = match root {
            Some(root) => theme_css::prepare(
                Path::new(root),
                &origin,
                declared_css.as_deref(),
                &declared_assets,
            ),
            // A row without a root path has no directory to read from: a declared stylesheet that
            // cannot even be looked for is a declared stylesheet that did not apply.
            None => Err(theme_css::CssRefusal::MissingFile),
        };
        match prepared {
            Ok(prepared) => {
                theme.css = prepared.css;
                theme.assets = prepared.assets;
            }
            Err(refusal) => {
                theme.css_error = Some(theme_css::REFUSAL_REASON.to_owned());
                log::warn(&format!(
                    "a plugin theme's declared content was refused: plugin={} theme={} code={} reason={}",
                    row.id,
                    theme.id,
                    PLUGIN_THEME_CSS_INVALID,
                    refusal.code()
                ));
            }
        }
    }
}

/// Clears the two theme fields that only ever hold *made* content - the sanitised text and the
/// served URLs - for a block that did not survive as a whole.
///
/// The host reports a declared stylesheet as a path and this layer's contract says the field holds
/// text, so a refused block must not hand the page a path it would inject as CSS. The host empties
/// the theme list itself when it refuses, so this states the invariant rather than covering a case
/// that arrives today.
fn clear_theme_content(desktop: &mut EngineDesktopBlock) {
    for theme in desktop.themes.iter_mut() {
        theme.css = None;
        theme.assets.clear();
        theme.css_error = None;
    }
}

/// Whether one block declares a permission. Exact match, for the reason the host's own check is
/// exact: a permission is a token, and two spellings of one token are two tokens.
fn declares(permissions: &[String], name: &str) -> bool {
    permissions.iter().any(|declared| declared == name)
}

/// Whether one declared page is the shape this layer will serve: a bounded id, a relative entry,
/// localised titles this process can put in a payload, and an icon token of the declared shape.
fn page_shape_is_valid(page: &EngineDesktopPage) -> bool {
    validate_page_id(&page.id)
        && pages::is_safe_relative(page.entry.trim())
        && titles_are_safe(page.title.as_ref())
        && page.icon.as_deref().is_none_or(validate_icon_token)
}

/// Whether one contributed tab is the shape this layer will carry: a bounded id, localised titles
/// this process can put in a payload, an icon token and a renderer token of the declared shape.
fn work_panel_tab_is_valid(tab: &EngineWorkPanelTab) -> bool {
    validate_page_id(&tab.id)
        && titles_are_safe(tab.title.as_ref())
        && tab.icon.as_deref().is_none_or(validate_icon_token)
        && validate_icon_token(&tab.renderer)
}

/// Whether one entry's titles are display text this layer publishes as the manifest wrote it.
fn titles_are_safe(titles: Option<&BTreeMap<String, String>>) -> bool {
    let Some(titles) = titles else {
        return true;
    };
    titles.len() <= TITLES_MAX
        && titles.iter().all(|(locale, text)| {
            !locale.is_empty()
                && locale.len() <= LOCALE_MAX
                && !locale.chars().any(char::is_control)
                && !text.trim().is_empty()
                && text.chars().count() <= TITLE_MAX
                && !text.chars().any(char::is_control)
        })
}

/// Longest page id this layer accepts, mirroring the manifest's own shape rule.
const PAGE_ID_MAX: usize = 64;
/// Longest page icon token this layer accepts, mirroring the manifest's own shape rule.
const ICON_TOKEN_MAX: usize = 32;
/// Longest localised page title, its locale key, and how many locales one page may carry.
const TITLE_MAX: usize = 512;
const LOCALE_MAX: usize = 32;
const TITLES_MAX: usize = 16;

/// Whether `id` is a page id of the declared shape (`^[a-zA-Z][a-zA-Z0-9_-]{0,63}$`).
fn validate_page_id(id: &str) -> bool {
    let mut characters = id.chars();
    match characters.next() {
        Some(first) if first.is_ascii_alphabetic() => {}
        _ => return false,
    }
    if id.len() > PAGE_ID_MAX {
        return false;
    }
    characters.all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
}

/// Whether `icon` is an icon token of the declared shape (`^[a-z][a-z0-9-]{0,31}$`).
///
/// Only the shape is checked, never the name it stands for: the token is resolved against the page's
/// own icon table, so a name this build has never heard of still travels and degrades to that entry's
/// default icon there. This is the same shape the host refuses a block over
/// (`host/src/constants.ts` `PLUGIN_DESKTOP_ICON_TOKEN`), so a manifest this side accepts is one the
/// host accepted too. A work-panel tab's `renderer` is the same shape
/// (`PLUGIN_DESKTOP_RENDERER_TOKEN`) and is checked with this same rule, for the same reason.
fn validate_icon_token(icon: &str) -> bool {
    let mut characters = icon.chars();
    match characters.next() {
        Some(first) if first.is_ascii_lowercase() => {}
        _ => return false,
    }
    icon.len() <= ICON_TOKEN_MAX
        && characters.all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
}
