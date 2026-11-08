//! The marketplace commands: the registry the engine knows, the catalogue entries it holds, and the
//! refresh that keeps both current.
//!
//! Split from `commands::plugins` (`rules.md#single-file-line-limit`) along the seam the surfaces already have: this
//! module is the *store's* half of the plugin domain - what can be installed from where - while
//! `commands::plugins` is the installed set and the writes that change it. Nothing about the split is
//! visible outside it: the commands keep their names, their arguments and their answers, and
//! `lib.rs` registers them from here.
//!
//! Every command is the thin half of its pair, like the ones beside it: this layer bounds the
//! argument and converts the answer, and the engine's own manager does the work
//! (`services::runtime::host::plugins`). One of them is not a straight pass-through - the refresh
//! carries the process's throttle (`state::AppState::marketplace_refresh_due`) and reports honestly
//! whether it fetched or answered from what it already had.

use tauri::State;

use crate::errors::IpcError;
use crate::models::plugins::{
    EngineMarketplacePluginsView, EngineMarketplacesView, MarketplacesRefreshView,
};
use crate::services::plugins::builtin;
use crate::services::plugins::imports;
use crate::services::plugins::validate::{
    sanitize_marketplace_key, sanitize_name, sanitize_source,
};
use crate::state::AppState;

/// The marketplaces the engine's registry knows, and what each was added by.
#[tauri::command]
pub(crate) async fn engine_marketplaces(
    state: State<'_, AppState>,
) -> Result<EngineMarketplacesView, IpcError> {
    state.runtime.marketplaces().await
}

/// Adds one marketplace and answers with the registry as it stands after the write.
#[tauri::command]
pub(crate) async fn engine_marketplace_add(
    state: State<'_, AppState>,
    source: String,
) -> Result<EngineMarketplacesView, IpcError> {
    let source = sanitize_source(&source)?;
    state.runtime.marketplace_add(&source).await
}

/// The catalogue entries the plugin store lists: one marketplace's, or every registered
/// marketplace's when none is named.
///
/// The engine's own cached catalogues are the source (`marketplace_plugins`), so this read costs one
/// file per marketplace and never fetches - refreshing a catalogue is `engine_marketplace_update`'s
/// work. The name is bounded by the host's own ceiling for the field before the frame is built, so a
/// caller that named something no marketplace could be called is refused with its own argument
/// rather than by the host.
#[tauri::command]
pub(crate) async fn engine_marketplace_plugins(
    state: State<'_, AppState>,
    marketplace: Option<String>,
) -> Result<EngineMarketplacePluginsView, IpcError> {
    let marketplace = match marketplace
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(name) => Some(sanitize_marketplace_key(name)?),
        None => None,
    };
    state
        .runtime
        .marketplace_plugins(marketplace.as_deref())
        .await
}

/// Removes one marketplace, by name.
///
/// A marketplace this application added for an imported package is a directory under its own data
/// root, and forgetting the registry row alone would leave that directory behind with nothing
/// referring to it. So the row's source is read before the engine forgets it, and when it is one of
/// this application's imports that directory goes too
/// (`services::plugins::imports::remove_source_directory`, the guard and the removal shared with the
/// uninstall that empties an import). An installation that came from it keeps working — its files
/// are the engine's own cached copy — it simply has no source to upgrade from any more, which is
/// what removing a marketplace means for every plugin installed from it.
#[tauri::command]
pub(crate) async fn engine_marketplace_remove(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<EngineMarketplacesView, IpcError> {
    let name = sanitize_name(&name)?;
    let before = state.runtime.marketplaces().await?;
    let source = before
        .marketplaces
        .iter()
        .find(|row| row.name == name)
        .map(|row| row.source_uri.clone());
    // The marketplace the built-in plugins are published from is this application's own, and
    // removing it would leave the installation with no source to be upgraded from - but only a row
    // that actually points at the bundle this application shipped with is. A row holding the
    // reserved name against somebody else's source is the conflict the seed fails closed on, and
    // removing it is the one path out of that state (`services::plugins::builtin`).
    if let Some(refusal) = builtin::marketplace_removal_refusal(
        &name,
        source.as_deref(),
        state.builtin_sync.bundle_root(&app).as_deref(),
    ) {
        return Err(refusal);
    }
    let answer = state.runtime.marketplace_remove(&name).await?;
    if let Some(source) = source {
        imports::remove_source_directory(&state.paths.plugin_imports, &source).await;
    }
    Ok(answer)
}

/// Refreshes one marketplace's metadata, or every marketplace when none is named.
#[tauri::command]
pub(crate) async fn engine_marketplace_update(
    state: State<'_, AppState>,
    name: Option<String>,
) -> Result<EngineMarketplacesView, IpcError> {
    let name = match name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(name) => Some(sanitize_name(name)?),
        None => None,
    };
    state.runtime.marketplace_update(name.as_deref()).await
}

/// Refreshes every registered marketplace, unless this process refreshed them a moment ago.
///
/// The store calls this once when it opens, and a refresh fetches every registered catalogue: the
/// throttle (`state::AppState::marketplace_refresh_due`) is what keeps a second visit inside ten
/// minutes from fetching them all again. A throttled call is not an error and not a silent no-op: it
/// answers with the registry this process already has and says `throttled: true`, which is the
/// honest half of "nothing was fetched". Only a *successful* refresh records the time, so a failure
/// leaves the next visit free to try again.
///
/// The manual refresh (`engine_marketplace_update`) is deliberately not throttled: a user who
/// presses refresh is asking for a fetch.
#[tauri::command]
pub(crate) async fn engine_marketplaces_refresh(
    state: State<'_, AppState>,
) -> Result<MarketplacesRefreshView, IpcError> {
    if !state.marketplace_refresh_due() {
        let marketplaces = state.runtime.marketplaces().await?;
        return Ok(MarketplacesRefreshView {
            marketplaces: marketplaces.marketplaces,
            throttled: true,
        });
    }
    let refreshed = state.runtime.marketplace_update(None).await?;
    state.remember_marketplace_refresh();
    Ok(MarketplacesRefreshView {
        marketplaces: refreshed.marketplaces,
        throttled: false,
    })
}
