//! The pages a plugin contributes, and the assets those pages load.
//!
//! The host decides what a `omp.desktop` block declares (spec §3.2) and the row it reports is the
//! projection this layer reads; what this module adds is everything that has to exist *in this
//! process* for such a page to be shown: an origin of its own, the entry lookup a panel window is
//! opened by, and the resolver that turns one request for a file into an answer - or a refusal.
//!
//! Two rules shape the whole module.
//!
//! **A plugin is its own origin.** A page is served from `<scheme>://<key>/<path>`, where the key is
//! derived from the installation (id + scope) rather than written down: two plugins cannot read each
//! other's files through the browser's same-origin rules, and nothing in a URL spells a package name
//! or a filesystem path that a page could turn into an address. The key is a hash rather than the id
//! itself because an id is not a host name - `@scope/pkg` and `name@marketplace` are both legal ids
//! and neither is legal in the authority component, and the platform lower-cases what it puts there.
//!
//! **Nothing is served that the manifest did not declare.** A request is answered only when the
//! plugin is enabled, the block is valid, and the file lies under a declared entry's own directory -
//! the bundle that entry's page belongs to and nothing else - or is a theme asset the manifest named
//! file by file (`services::plugins::theme_css`). On top of that the same reject table
//! the file gates use applies (spec §6.3: credential files and private directories are refused
//! wherever they are found), the resolved path is checked against the plugin root after `realpath`,
//! and the answer carries `nosniff`, no caching and a policy that allows the page its own files and
//! no network at all.
//!
//! **Owner / bound / release.** The registry is owned by this service, held in [`PluginPages`] as one
//! entry per installed plugin (`MAX_PAGES`), and released on every refresh: it is rebuilt from each
//! plugin list the desktop reads, so a plugin that was uninstalled or disabled stops being served the
//! moment the list says so - the same response that tells the page. What it never does is read a
//! plugin's manifest itself: a second parser here would be a second set of rules.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};
use tauri::Url;

use crate::models::plugins::EnginePluginRow;
use crate::services::plugins::gates;
use crate::services::plugins::net;
use crate::services::plugins::theme_css;

/// The scheme plugin pages are served under. Registered once, for every webview (spec §7.2).
pub(crate) const PLUGIN_SCHEME: &str = "omp-plugin";

/// The path a page's bridge calls arrive on: the one reserved name below a plugin's origin.
pub(crate) const BRIDGE_PATH: &str = "__bridge";

/// Ceiling on the installations this registry holds. It is rebuilt from a plugin list, so the bound
/// only keeps a pathological machine from growing it without end.
const MAX_PAGES: usize = 256;

/// Longest asset one response may carry. A plugin page is a document, its script and its styles; a
/// bundle past this is refused rather than read into memory on a renderer's word.
const MAX_ASSET_BYTES: u64 = 8 * 1024 * 1024;

/// Upper bound on a decoded request path, before it is resolved against the plugin root.
const MAX_PATH_CHARS: usize = 1_024;

/// Which list a page came from, which is also what tells a panel from a docked page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PageKind {
    Panel,
    View,
    Settings,
    Tab,
}

/// One page an installation declares, as this layer needs it: what to load and how to frame it.
#[derive(Debug, Clone)]
pub(crate) struct Page {
    pub(crate) id: String,
    pub(crate) kind: PageKind,
    /// The entry file, `/`-separated and relative to the plugin root.
    pub(crate) entry: String,
    /// The page's own title per locale, when its manifest gave one.
    pub(crate) title: Option<BTreeMap<String, String>>,
    pub(crate) width: Option<u32>,
    pub(crate) height: Option<u32>,
    pub(crate) resizable: Option<bool>,
}

/// What one installation declared that its own pages may ask this process for (spec §6.2, §6.3).
///
/// The three lists are the host's verdict carried into the registry, re-checked by this side before
/// they are stored ([`crate::models::plugins::recheck_desktop`]): the permissions the manifest
/// grants, the standing read scope, and the hosts it may reach. They live beside the pages because
/// the bridge answers by this installation's declaration, and the declaration is only as fresh as
/// the list the registry was published from - which is the same rule the pages themselves follow.
/// The three scopes one installation declared, as the gates read them (spec §3.2, §6.3).
#[derive(Debug, Clone, Default)]
pub(crate) struct FsScopes {
    pub(crate) read: Vec<String>,
    pub(crate) write: Vec<String>,
    pub(crate) delete: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct PageGrants {
    /// The permission names the manifest declared, as this build's vocabulary spells them.
    pub(crate) permissions: Vec<String>,
    /// `omp.desktop.fs.<mode>.scope`: the patterns each file mode may name without asking the user.
    pub(crate) fs_scopes: FsScopes,
    /// `omp.desktop.net.domains`: the hosts an egress may name, and the only ones - unless
    /// [`Self::net_any_host`] holds.
    pub(crate) net_domains: Vec<String>,
    /// Whether this installation may reach any host: `net.anyHost` declared **and**
    /// `omp.desktop.net.anyHost: true`. Both keys are required by the block's re-check, so this flag
    /// being set is the same fact as "the user was shown a widening they declared twice".
    pub(crate) net_any_host: bool,
    /// Whether these grants were read for the installation's **resident process** rather than for one
    /// of its documents.
    ///
    /// The two reach the bridge through the same value (`process::api::page_of` builds a page for a
    /// worker), and one capability is only meaningful for one of them: a subscription needs a channel
    /// this application can call *into*, which a plugin page does not have (`bus.subscribe`). The
    /// fact lives with the grants because that is where the two surfaces are told apart - a plugin's
    /// pages and its process share every other field.
    pub(crate) resident: bool,
}

impl PageGrants {
    /// Whether this installation declared one permission. Exact match, no trimming: a permission is
    /// a token from the manifest, and a near miss is a permission this build does not serve.
    pub(crate) fn declares(&self, permission: &str) -> bool {
        self.permissions.iter().any(|name| name == permission)
    }

    /// The egress policy this installation's calls are judged by - the one place the two keys are
    /// combined, so no bridge method can decide the range for itself.
    pub(crate) fn net_policy(&self) -> net::NetPolicy<'_> {
        net::NetPolicy {
            domains: &self.net_domains,
            // The flag alone is not the reach: the permission is the switch, exactly as it is for
            // every other capability (`rules.md#plugin-system`).
            any_host: self.net_any_host && self.declares("net.anyHost"),
        }
    }
}

/// One installation's pages: the key its origin is derived from, where its files are, and whether it
/// may be served at all.
#[derive(Debug, Clone)]
pub(crate) struct PluginPage {
    pub(crate) plugin_id: String,
    /// The plugin's display name as the list reported it, for a window title's fallback.
    pub(crate) name: String,
    pub(crate) scope: String,
    pub(crate) root: PathBuf,
    /// The engine's own enabled state for this installation, read with the list.
    pub(crate) enabled: bool,
    /// The revision of the package these pages were read from (see [`revision_from`]). It is what
    /// [`PluginPages::publish`] compares to learn that an installation changed even though its id,
    /// scope and enabled state did not - the case an upgrade is.
    pub(crate) revision: String,
    pub(crate) pages: Vec<Page>,
    /// The theme assets this installation declared and may be served, as package-relative paths in
    /// declared order ([`theme_assets_of`]).
    ///
    /// They live beside the pages because they are served from the same origin and gated the same
    /// way, and because the two are one question: what may this installation's own documents ask
    /// this process for. Their serving rule is the other half - a page loads its entry's directory,
    /// a stylesheet loads exactly the files its theme declared, and nothing else.
    pub(crate) theme_assets: Vec<String>,
    /// The slot module this installation declared, as the package-relative path the fixed slot host
    /// may serve ([`crate::services::plugins::renderer`]).
    ///
    /// It is carried here rather than re-read from a row because the protocol answers a request
    /// without a list read: the registry published from the last list is the answer, exactly as it
    /// is for the pages. `None` when the installation declares none, or when the block that declared
    /// it was refused. The path is *not* the address - the handler maps one fixed name to it.
    pub(crate) renderer_module: Option<String>,
    /// What this installation's pages may ask the bridge for (spec §6.2, §6.3).
    pub(crate) grants: PageGrants,
}

impl PluginPage {
    /// The origin this installation's pages are served from on this platform.
    ///
    /// Windows cannot load a non-standard scheme the way macOS and Linux do: the webview only ever
    /// sees the `http(s)` form its runtime rewrites a custom scheme into (`wry`'s workaround), and
    /// a page the *renderer* asks for - an iframe, a stylesheet, a relative fetch - is resolved by
    /// the renderer, which knows no `omp-plugin:` scheme. So on Windows a page is addressed as
    /// `http://omp-plugin.<key>`, which the same custom protocol answers, and elsewhere as
    /// `omp-plugin://<key>`. Either way the host of a page's URL is the installation's key, which is
    /// what keeps two plugins in two origins.
    pub(crate) fn origin(&self) -> String {
        origin(&origin_key(&self.plugin_id, &self.scope))
    }

    /// One page of this installation by its kind and id, when it declares it.
    pub(crate) fn page(&self, kind: PageKind, id: &str) -> Option<&Page> {
        self.pages
            .iter()
            .find(|page| page.kind == kind && page.id == id)
    }
}

/// The origin a key is served from on this platform (see [`PluginPage::origin`]).
pub(crate) fn origin(key: &str) -> String {
    if cfg!(any(windows, target_os = "android")) {
        format!("http://{PLUGIN_SCHEME}.{key}")
    } else {
        format!("{PLUGIN_SCHEME}://{key}")
    }
}

/// The key one installation's origin is derived from: stable, opaque, and a legal host label.
///
/// Sixteen bytes of the digest of `id \0 scope`, as lowercase hex: 32 characters, so it fits the
/// 63-character label a host name allows, and it is case-stable, which the authority component of a
/// URL is not. Nothing about the id is recoverable from it, and two installations - the same plugin
/// at two scopes included - cannot collide.
pub(crate) fn origin_key(plugin_id: &str, scope: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(plugin_id.as_bytes());
    hasher.update([0u8]);
    hasher.update(scope.as_bytes());
    let digest = hasher.finalize();
    digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The URL one page's entry is loaded from, given the origin it is served under.
///
/// The entry is checked to be a relative `/`-separated path and then encoded per segment, so a file
/// named with a space or a `#` reaches the resolver as the same name the manifest declared. `None`
/// means the entry is not one this layer will put in a URL at all - including an entry the asset
/// resolver refuses by name (`.env*`, `id_rsa*`, `*.pem`, spec §6.3): a page whose address would
/// only ever answer `403` gets no address, which is what makes `url: null` mean "not loadable".
pub(crate) fn page_url(origin: &str, entry: &str) -> Option<String> {
    if !is_safe_relative(entry) || gates::is_rejected_path(entry) {
        return None;
    }
    let encoded: Vec<String> = entry.split('/').map(percent_encode_segment).collect();
    Some(format!("{origin}/{}", encoded.join("/")))
}

/// The theme assets one installation's row declares that this layer will serve, in declared order.
///
/// Two readings are needed because the re-check rewrites the field it touches: `checked` is the block
/// this layer produced (`assets` are the served URLs, empty for a theme it refused), and `host` is the
/// row the host reported (`assets` are the package-relative paths). A theme that survived keeps the
/// paths it declared, so the whitelist is the declared list of exactly those themes - and a theme
/// whose content was refused, or a block that was refused whole, declares nothing here.
///
/// Ids are unique inside a list (the host refuses a duplicate and this side refuses the block), so a
/// theme is addressed by its own id rather than by position.
pub(crate) fn theme_assets_of(
    host: &EnginePluginRow,
    checked: Option<&crate::models::plugins::EngineDesktopBlock>,
) -> Vec<String> {
    let (Some(declared), Some(checked)) = (host.desktop.as_ref(), checked) else {
        return Vec::new();
    };
    if !checked.valid {
        return Vec::new();
    }
    let mut assets = Vec::new();
    for theme in checked
        .themes
        .iter()
        .filter(|theme| !theme.assets.is_empty())
    {
        if let Some(source) = declared.themes.iter().find(|item| item.id == theme.id) {
            assets.extend(source.assets.iter().cloned());
        }
    }
    assets
}

/// The origin one installation's pages are served from, from its id and scope.
pub(crate) fn origin_of(plugin_id: &str, scope: &str) -> String {
    origin(&origin_key(plugin_id, scope))
}

/// The URL one declared entry of one installation is served from, when it may be addressed.
pub(crate) fn entry_url(plugin_id: &str, scope: &str, entry: &str) -> Option<String> {
    page_url(&origin_of(plugin_id, scope), entry)
}

/// Whether a declared entry is a relative, `/`-separated path this layer will resolve.
///
/// The host already checked it against the filesystem (`plugins-desktop.ts`); this is the same rule
/// stated for the side that turns it into a URL and a filesystem lookup, because an entry that
/// reaches either of those unchecked would be the one hole in the scheme.
pub(crate) fn is_safe_relative(entry: &str) -> bool {
    if entry.is_empty() || entry.len() > MAX_PATH_CHARS || entry.starts_with('/') {
        return false;
    }
    if entry.contains('\\') || entry.contains('\0') || entry.contains(':') {
        return false;
    }
    if entry.chars().any(char::is_control) {
        return false;
    }
    entry
        .split('/')
        .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

/// The pages one installation declares, read from the row the host reported.
///
/// A block the host refused contributes none: [`EnginePluginRow`] carries the verdict, and this is
/// where it is honoured rather than re-derived. `None` means the installation has nothing to serve,
/// which is also the answer for a plugin with no desktop part at all.
pub(crate) fn pages_of(row: &EnginePluginRow) -> Vec<Page> {
    let Some(block) = row.desktop.as_ref().filter(|block| block.valid) else {
        return Vec::new();
    };
    let mut pages = Vec::new();
    for (kind, declared) in [
        (PageKind::Panel, &block.panels),
        (PageKind::View, &block.views),
        (PageKind::Settings, &block.settings_destinations),
        (PageKind::Tab, &block.sidebar_tabs),
    ] {
        for page in declared.iter() {
            let Some(entry) = sanitize_entry(&page.entry) else {
                continue;
            };
            pages.push(Page {
                id: page.id.clone(),
                kind,
                entry,
                title: page.title.clone(),
                width: page.width,
                height: page.height,
                resizable: page.resizable,
            });
        }
    }
    pages
}

/// The revision of one document set: what changes when the package those pages were read from
/// changes.
///
/// `sha256(version \0 sorted entries \0 renderer \0 …)`: the declared entries are sorted so a
/// manifest that lists the same pages in another order is the same revision, the version is part of
/// it so a re-import of the same entries under a new version is a new revision, and the slot
/// module's declared path is part of it because the same fixed address serves a different file when
/// the manifest moves it. It deliberately says nothing about the files' contents - whether a package
/// changed without changing its manifest is the engine's own answer (spec §3.4) - only about the
/// document set this layer would serve.
///
/// The entries come from the caller rather than being read here: a row's `omp.desktop` block is
/// parsed once ([`pages_of`]) and both the pages and this revision are derived from that one reading,
/// so a list read never pays for the same parse twice.
pub(crate) fn revision_from(version: &str, pages: &[Page], renderer: Option<&str>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(version.as_bytes());
    hasher.update([0u8]);
    let mut entries: Vec<&str> = pages.iter().map(|page| page.entry.as_str()).collect();
    entries.sort_unstable();
    for entry in entries {
        hasher.update(entry.as_bytes());
        hasher.update([0u8]);
    }
    hasher.update(renderer.unwrap_or_default().as_bytes());
    hasher.update([0u8]);
    format!("{:x}", hasher.finalize())
}

/// One declared entry as this layer stores it, or `None` when it is not a path it would resolve.
///
/// The host's own check is the authority on whether the file exists; this one is about the *shape*
/// of a path that will be joined to a directory and written into a URL, and it is deliberately the
/// same test both of those use ([`is_safe_relative`]).
fn sanitize_entry(entry: &str) -> Option<String> {
    let trimmed = entry.trim();
    if !is_safe_relative(trimmed) {
        return None;
    }
    Some(trimmed.to_owned())
}

/// The installations this process serves, keyed by their origin key.
///
/// Rebuilt from every plugin list the desktop reads ([`Self::publish`]), which is what makes
/// disabling or uninstalling a plugin effective for its pages: the same answer that reports the new
/// state replaces the entry, and the resolver below then refuses the URLs of a plugin the engine no
/// longer runs.
pub(crate) struct PluginPages {
    entries: Mutex<HashMap<String, Arc<PluginPage>>>,
}

impl PluginPages {
    pub(crate) fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Replaces the registry with the installations one plugin list reported, answering which keys
    /// changed.
    ///
    /// The whole map is replaced rather than merged: the list is the truth about what is installed,
    /// so an installation the list no longer holds - uninstalled, moved out of this workspace's
    /// view - must stop being served. The bound is applied by keeping the first `MAX_PAGES` in a
    /// deterministic order, so the same list always produces the same registry.
    ///
    /// A key is *changed* when it was not served before, or when the revision of what it serves
    /// differs from the one it served: an upgrade keeps id, scope and enabled state, so the revision
    /// is the only thing that tells the caller a window opened for the previous package has to be
    /// closed (spec §7.2).
    pub(crate) fn publish(&self, pages: Vec<PluginPage>) -> Vec<String> {
        let mut entries = HashMap::new();
        let mut changed = Vec::new();
        let mut held = self.lock();
        for page in pages.into_iter().take(MAX_PAGES) {
            let key = origin_key(&page.plugin_id, &page.scope);
            let unchanged = held
                .get(&key)
                .is_some_and(|existing| existing.revision == page.revision);
            if !unchanged {
                changed.push(key.clone());
            }
            entries.insert(key, Arc::new(page));
        }
        *held = entries;
        changed
    }

    /// The installation one origin key belongs to, when this process serves it.
    pub(crate) fn get(&self, key: &str) -> Option<Arc<PluginPage>> {
        self.lock().get(key).cloned()
    }

    /// The installation named by an id and a scope, when this process serves it.
    pub(crate) fn find(&self, plugin_id: &str, scope: &str) -> Option<Arc<PluginPage>> {
        self.get(&origin_key(plugin_id, scope))
    }

    /// How many installations the registry holds. Used by this module's own tests only, which is
    /// why it is compiled with them and not into the application.
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.lock().len()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<PluginPage>>> {
        // A poisoned lock is not a reason to take the application down: every holder mutates one map
        // and nothing that a previous holder could have left half-written.
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Why one request for a plugin asset was not answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AssetRefusal {
    /// No installation is served under that origin.
    UnknownOrigin,
    /// The installation is installed but the engine has it disabled.
    Disabled,
    /// The request asked for the bridge with a method this build does not serve.
    UnknownBridgeMethod,
    /// Nothing is served at that path: it is outside every declared entry's directory, or the
    /// resolved file is not there.
    NotFound,
    /// The path names something this application never serves (spec §6.3), or escapes the root.
    Forbidden,
}

impl AssetRefusal {
    /// The status a refusal is answered with, and the token logged beside it.
    pub(crate) fn status(self) -> u16 {
        match self {
            Self::UnknownOrigin | Self::NotFound => 404,
            Self::Disabled | Self::Forbidden | Self::UnknownBridgeMethod => 403,
        }
    }

    /// The refusal's own name, for the log: the two `404`s above are different facts, and a log
    /// line that printed the status alone would make them one.
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::UnknownOrigin => "unknown_origin",
            Self::Disabled => "disabled",
            Self::UnknownBridgeMethod => "unknown_bridge_method",
            Self::NotFound => "not_found",
            Self::Forbidden => "forbidden",
        }
    }
}

/// One request, as the resolver reads it: the origin key and the path below it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AssetRequest {
    pub(crate) key: String,
    pub(crate) path: String,
}

/// The request one incoming URI spells, or `None` when it is not one this scheme answers.
///
/// The URI arrives in the `omp-plugin://<key>/<path>` form on every platform: on Windows the runtime
/// rewrites the scheme on the way in and back on the way out (`wry`'s workaround), so the resolver
/// sees one shape and does not have to know which platform it is on. The path is percent-decoded
/// here, bounded, and checked to be relative.
pub(crate) fn parse_request(uri: &Url) -> Option<AssetRequest> {
    if uri.scheme() != PLUGIN_SCHEME {
        return None;
    }
    let key = uri.host_str()?;
    if key.is_empty() || key.len() > 64 || !key.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    let raw = uri.path();
    let trimmed = raw.strip_prefix('/').unwrap_or(raw);
    if trimmed.len() > MAX_PATH_CHARS {
        return None;
    }
    let decoded = percent_decode(trimmed)?;
    Some(AssetRequest {
        key: key.to_ascii_lowercase(),
        path: decoded,
    })
}

/// The file one request names, when this installation may serve it.
///
/// The answer is a path inside the plugin root, or a refusal. Four checks, in this order: the path
/// is a relative one, it is one of the two things this installation declared - a file under a
/// declared entry's own directory (the bundle an entry belongs to) or a theme asset its manifest
/// named file by file - the resolved file is still inside the plugin root after `realpath` - which is
/// what catches a symlink whose target is outside it - and the name is not one of the paths this
/// application never hands out (spec §6.3's reject table, applied here because a plugin's own
/// directory is still a place a credential file can sit).
///
/// A theme asset is matched exactly, never by directory: a stylesheet may paint with the files its
/// theme declared and nothing beside them, which is why a `url()` this layer rewrote can be answered
/// while a hand-written guess at a neighbouring file is refused with `403` rather than `404` - the
/// request names an asset shape the theme did not declare, and that difference is what the refusal
/// exists to say.
///
/// The reject table itself lives in [`gates`], because the bridge's read gate asks the same
/// question: a table copied for a second caller is a table that drifts.
pub(crate) fn resolve_asset(page: &PluginPage, requested: &str) -> Result<PathBuf, AssetRefusal> {
    if !page.enabled {
        return Err(AssetRefusal::Disabled);
    }
    if !is_safe_relative(requested) {
        return Err(AssetRefusal::Forbidden);
    }
    if gates::is_rejected_path(requested) {
        return Err(AssetRefusal::Forbidden);
    }
    let declared_theme_asset = page.theme_assets.iter().any(|asset| asset == requested);
    if !declared_theme_asset
        && !page
            .pages
            .iter()
            .any(|declared| lies_under_entry_directory(&declared.entry, requested))
    {
        return Err(if theme_css::is_theme_asset_path(requested) {
            AssetRefusal::Forbidden
        } else {
            AssetRefusal::NotFound
        });
    }
    let candidate = page
        .root
        .join(requested.replace('/', std::path::MAIN_SEPARATOR_STR));
    let resolved = std::fs::canonicalize(&candidate).map_err(|_| AssetRefusal::NotFound)?;
    let root = std::fs::canonicalize(&page.root).map_err(|_| AssetRefusal::NotFound)?;
    if !crate::services::paths::is_within(&root, &resolved) {
        return Err(AssetRefusal::Forbidden);
    }
    if !resolved.is_file() {
        return Err(AssetRefusal::NotFound);
    }
    // The reject table again, this time on what the request *resolved to*: a package can ship
    // `notes.md` as a link to `.env`, and a table that only read the requested name would hand the
    // credential file out under a name nobody would look for. The bridge's read gate
    // (`gates::resolve_read`) does the same, for the same reason.
    let Ok(relative) = resolved.strip_prefix(&root) else {
        return Err(AssetRefusal::Forbidden);
    };
    let relative = relative
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR_STR, "/");
    if gates::is_rejected_path(&relative) {
        return Err(AssetRefusal::Forbidden);
    }
    Ok(resolved)
}

/// Whether `requested` lies under the directory the declared `entry` sits in.
///
/// A page loads its own bundle: its document, the script and stylesheet beside it, and whatever sits
/// below. An entry at the root of the package therefore serves the whole package - which is what a
/// plugin that ships exactly one page expects - while an entry in `desktop/panel/` serves that
/// directory and nothing else.
fn lies_under_entry_directory(entry: &str, requested: &str) -> bool {
    let directory = match entry.rfind('/') {
        Some(index) => &entry[..index + 1],
        None => return true,
    };
    requested.starts_with(directory)
}

/// One page's bytes, read with a ceiling.
pub(crate) fn read_asset(path: &Path) -> Result<Vec<u8>, AssetRefusal> {
    let metadata = std::fs::metadata(path).map_err(|_| AssetRefusal::NotFound)?;
    if metadata.len() > MAX_ASSET_BYTES {
        return Err(AssetRefusal::Forbidden);
    }
    std::fs::read(path).map_err(|_| AssetRefusal::NotFound)
}

/// The content type one asset is answered with.
///
/// A closed map rather than a guess: anything outside it is served as `application/octet-stream`,
/// which with `nosniff` is inert - and a plugin whose page needs a type this list does not carry can
/// say so by naming the file's extension, which is the only vocabulary either side has.
pub(crate) fn content_type(path: &str) -> &'static str {
    let extension = path
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "txt" | "md" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/vnd.microsoft.icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// The policy every plugin page is answered with.
///
/// The page is its own origin, so `'self'` is its own bundle and nothing else: no network at all
/// (`connect-src 'self'` leaves the bridge, which the resolver answers itself, and refuses every
/// remote request the page could make), no framing of other pages, no objects, no forms, no base
/// tag. `'unsafe-inline'` is deliberate - a plugin's document is written by hand, and its inline
/// script runs in a page whose only privilege is what it ships - while `'unsafe-eval'` is not, so a
/// page cannot build code from strings.
pub(crate) fn content_security_policy() -> &'static str {
    "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; \
     img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; \
     object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"
}

/// A percent-decoded path, or `None` when the text is not one (`%` not followed by two digits, or a
/// byte sequence that is not UTF-8).
pub(crate) fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes.get(index + 1..index + 3)?;
            let text = std::str::from_utf8(hex).ok()?;
            decoded.push(u8::from_str_radix(text, 16).ok()?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

/// One path segment as it appears in a URL: everything outside the unreserved set is escaped.
fn percent_encode_segment(segment: &str) -> String {
    let mut encoded = String::with_capacity(segment.len());
    for byte in segment.as_bytes() {
        let character = *byte as char;
        if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '~') {
            encoded.push(character);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[cfg(test)]
mod tests;
