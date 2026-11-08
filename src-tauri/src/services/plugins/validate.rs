//! The checks this side runs before a plugin command reaches the host: the shape of an argument,
//! the value of one setting, and the one gate that is this application's own decision - whether a
//! plugin that runs code may be enabled.
//!
//! Everything here is a pure function of its arguments, which is what makes the rules testable
//! without a host, a store or a file. The vocabulary (`user`/`project`, the permission set) and the
//! bounds (source length, control characters) are stated once, and both the command layer and this
//! module's tests read them from the same place.
//!
//! What is deliberately *not* here: which plugins exist, what an install source resolves to
//! (marketplace name, npm spec, local path, git URL), and which settings a plugin declares. Those
//! are the engine's facts, held on the host's side; a copy of its classification rules here would
//! be a second implementation that drifts.

use serde_json::Value;

use crate::errors::{IpcError, IpcResult, INVALID_INPUT, PLUGIN_CONSENT_REQUIRED};

/// The permissions this build serves (spec §6.2): the vocabulary the desktop part of a plugin may
/// ask for. The page words its own copy of this list for the user (slice C), so this one is the
/// Rust-side record of the same set, read by the row conversion's boundary check
/// ([`validate_permission_name`]) and by the gates a later phase adds.
const DESKTOP_PERMISSIONS: &[&str] = &[
    "ui.panel",
    "ui.view",
    "ui.settings",
    // A sidebar tab is a shell-level entry of its own rather than a docked pane, so it carries its
    // own permission: a plugin reachable only from the sidebar does not have to ask for the work
    // panel as well (spec §3.2, §4.2).
    "ui.tab",
    "notify",
    "clipboard.read",
    "clipboard.write",
    "fs.read",
    // The two modes that change what is on disk (spec §6.2): their gates, scopes and questions live
    // beside the read gate (`services::plugins::bridge`, `gates`).
    "fs.write",
    "fs.delete",
    // The file half of `net.anyHost`: with it, a name reaches any path on this machine in all three
    // modes, and the roots, the reject table and the declared scope stop applying
    // (`gates::resolve_any`). One key, not two like `net.anyHost`: the permission is a token that
    // cannot be confused with "listed a scope", which is the ambiguity the network pair exists for.
    "fs.anyPath",
    // The two ways a path leaves this application (API 0.3.0). Separate names, and separate from
    // `fs.read`, because the system's default handler for an executable extension *is* the program:
    // the brakes are the same for both (`gates::is_rejected_path`, `gates::is_executable_path`) and
    // `fs.anyPath` widens neither. `fs.glob` and `fs.readRange` carry no name of their own - they are
    // the read permission's own reach (`bridge::judge_glob`, `bridge::judge_read_range`).
    "fs.openDefault",
    "fs.reveal",
    "net.fetch",
    "agent.extension",
    // A theme is declarative tokens, not a stylesheet: the plugin contributes values the
    // application applies to its own design tokens, and the user picks which one is live
    // (`src/stores/pluginThemeStore.ts`). The permission exists so a plugin that declares a theme
    // without asking for it is refused, exactly as a panel without `ui.panel` is.
    "ui.theme",
    // The stylesheet half of a theme (`rules.md#plugin-system`), deliberately separate from the
    // token half: `css`/`assets` inject reviewed *content* into this application's document, so a
    // manifest that ships them asks for this permission, and one that does not gets its desktop
    // block refused - the same answer a panel without `ui.panel` gets. Declaring it alone is not a
    // theme permission: only a theme can carry a stylesheet.
    "ui.theme.css",
    // A resident plugin process (`omp.desktop.main`, plan §6.1). The host validates only the shape
    // and the supervisor decides whether it may run (a built-in is exempt, a third-party
    // installation needs this declaration *and* the user's confirmation); the name is here so a
    // manifest that asks for a process is not refused as asking for something unknown.
    "plugin.process",
    // The plugin's right to add its own commands to the palette (`omp.desktop.contributes.commands`,
    // plan §6.1). The worker forwards each registration and the gate is this side's
    // (`services::plugins::process::api`).
    "command.register",
    // A slot module that runs in this application's own document (`omp.desktop.renderer`, plan
    // §7.1, T3). It is the highest reach the manifest vocabulary carries, so it is one name for the
    // module and both dispatch lists; naming it here is what keeps a manifest from a newer contract
    // from having its whole desktop block refused as unknown.
    "renderer.extension",
    // The session index, read-only (`rules.md#plugin-system`, API 0.2.0): list, one conversation, and its
    // messages within an explicit body budget. There is no write path behind this name, and the gate
    // (`bridge::capabilities::judge_session`) refuses anything the caller cannot express as a bounded
    // page.
    "session.read",
    // The write half of the conversation surface (API 0.3.0): one conversation renamed, one deleted.
    // Its own name because it changes what the user owns, and its gate
    // (`bridge::capabilities::judge_session_write`) keeps the reach the read above has - the ids the
    // index lists - while the writing stays the host's own frames.
    "session.write",
    // The usage accounting this application already computes from the engine's session entries.
    "usage.read",
    // One completion on the models this application is already configured with. High risk (it spends
    // the user's money), so it has its own first-use question and its own rate budget rather than
    // riding another high-risk permission.
    "agent.complete",
    // The plugin bus: publishing inside the plugin's own `plugin:<owner>/…` namespace, and
    // subscribing across plugins. Both are resident-process capabilities (a page has no push
    // channel).
    "bus.publish",
    "bus.subscribe",
    // One WebSocket through this application's client, held to `net.domains` like `net.fetch`.
    "net.websocket",
    // One address handed to the system's own browser: the machine's default handler.
    "shell.openExternal",
    // This application's own built-in browser, driven by a plugin (API 0.3.0). One name for the
    // seven verbs (`bridge::capabilities::judge_browser`): they are one page, keyed by the
    // installation, and the address rule is `net.domains`'. The raw CDP channel is not in this
    // vocabulary at all.
    "browser.use",
    // The second key beside `net.domains`: a manifest that declares this *and* sets
    // `omp.desktop.net.anyHost` reaches any host. Two keys, deliberately.
    "net.anyHost",
];

/// How long an install source may be (contract §2.1 rule 2). A source is a name, a spec or a path;
/// the bound exists so a hostile caller cannot build an oversized frame out of one argument.
const SOURCE_MAX_CHARS: usize = 512;
/// Ceiling on a plugin id forwarded to the host. Real ids are package names or
/// `name@marketplace`, so the bound only keeps the frame finite.
const ID_MAX_CHARS: usize = 256;
/// Ceiling on a plugin setting's key, mirroring the host's own bound
/// (`host/src/constants.ts` `PLUGIN_KEY_MAX`). The host refuses a longer key while reading the
/// frame, so this is the same rule applied before the runtime is asked - the two sides have to
/// refuse the same writes, and a key past the bound is one no settings page could show.
const KEY_MAX_CHARS: usize = 128;
/// Ceiling on one plugin setting's text value, secret or not, mirroring the host's own bound
/// (`host/src/constants.ts` `PLUGIN_SETTING_TEXT_MAX`): the host refuses a longer string, and a
/// value it would refuse must not travel as if it could be stored.
const SETTING_TEXT_MAX_CHARS: usize = 8192;

/// Whether `name` is one of the permissions this build serves.
///
/// The check is exact - no trimming, no case folding: a permission is a token from the plugin's own
/// manifest, and two spellings of one token are two different tokens to the engine as well.
///
/// The host checks this same set when it parses the manifest, and this one is not a second opinion
/// about wording: the host's verdict is what the page reads, while this check - applied on the row
/// conversion (`models::plugins::PluginRowView::from`) - is what keeps an out-of-set permission from
/// reaching the capability gateway of a later phase through a host that validated more loosely.
pub(crate) fn validate_permission_name(name: &str) -> bool {
    DESKTOP_PERMISSIONS.contains(&name)
}

/// The permission a slot module needs (`renderer.extension`, plan §7.1): one name for the module and
/// both dispatch lists, because the code runs in this application's own document.
pub(crate) const RENDERER_PERMISSION: &str = "renderer.extension";

/// Longest slot-module path this layer accepts (`PLUGIN_RENDERER_PATH_MAX` on the host side).
pub(crate) const RENDERER_PATH_MAX: usize = 256;
/// At most this many dispatch tokens (`PLUGIN_RENDERER_ACTIONS_MAX`).
pub(crate) const RENDERER_ACTIONS_MAX: usize = 16;
/// At most this many whitelisted call methods (`PLUGIN_RENDERER_CALL_METHODS_MAX`).
pub(crate) const RENDERER_CALL_METHODS_MAX: usize = 32;
/// Longest one call-method name may be (`PLUGIN_RENDERER_METHOD_MAX`).
pub(crate) const RENDERER_METHOD_MAX: usize = 128;

/// The dispatch vocabulary a slot module may name (`host/src/constants.ts`
/// `PLUGIN_RENDERER_ACTIONS`).
///
/// Closed on this side too: an action this build cannot perform is a request it cannot honour, and
/// the host refuses the whole block over one, so a block that reached this layer carrying a token
/// outside the list came through a host that validated more loosely.
const RENDERER_ACTIONS: &[&str] = &[
    "plugin.call",
    "composer.insertText",
    "composer.readDraft",
    "composer.replaceDraft",
    "attachments.add",
    "attachments.list",
    "attachments.remove",
];

/// Whether one action token is in the closed dispatch vocabulary.
pub(crate) fn validate_renderer_action(action: &str) -> bool {
    RENDERER_ACTIONS.contains(&action)
}

/// Whether one `rendererCallMethods` entry is a method name of the declared shape
/// (`^[A-Za-z][A-Za-z0-9._-]*$`, at most [`RENDERER_METHOD_MAX`] characters).
///
/// The shape is the host's (`PLUGIN_RENDERER_METHOD_NAME` plus the character cap); the same rule is
/// applied when a call arrives, so a method this layer would refuse as malformed can never have been
/// declared either.
pub(crate) fn validate_renderer_method(method: &str) -> bool {
    let mut characters = method.chars();
    match characters.next() {
        Some(first) if first.is_ascii_alphabetic() => {}
        _ => return false,
    }
    method.len() <= RENDERER_METHOD_MAX
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
}

/// Whether one declared module path is a shape this layer would serve: a relative `/`-separated
/// `.js` / `.mjs` file, bounded, and not inside a `node_modules` directory (a package's dependencies
/// are not the plugin's code to run here).
///
/// This is the host's lexical rule (`plugins-desktop-renderer.ts`) applied on this side, because the
/// path becomes a filename below the plugin root; the realpath check below the root is what stops a
/// symlink from relocating it.
pub(crate) fn validate_renderer_path(path: &str) -> bool {
    if path.is_empty() || path.len() > RENDERER_PATH_MAX {
        return false;
    }
    if path.starts_with('/') || path.contains('\\') || path.contains('\0') || path.contains(':') {
        return false;
    }
    if path.chars().any(char::is_control) {
        return false;
    }
    let lowered = path.to_ascii_lowercase();
    if !(lowered.ends_with(".js") || lowered.ends_with(".mjs")) {
        return false;
    }
    if path
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return false;
    }
    !path
        .split('/')
        .any(|segment| segment.eq_ignore_ascii_case("node_modules"))
}

/// One theme token name is a property this application declares.
///
/// Three prefixed families (`--dsw-*` design tokens, `--omp-*` this application's chrome,
/// `--sidebar-*` the rail's palette) plus the bare names the same stylesheet declares in `:root`
/// (`--background`, `--card`, `--primary`, … `--radius`, `--chart-1`..`--chart-5`). It is still a
/// closed list of names this build publishes, so a theme cannot introduce a property of its own -
/// but it covers the surfaces a theme is expected to repaint. Until 2026-10-27 only the two prefixed
/// families were reachable, so a theme could tint the window frame and the composer's field and not
/// the conversation or the sidebar: a palette that looked half-applied.
///
/// The host validates the same list (`host/src/constants.ts::PLUGIN_THEME_TOKEN_NAME`); the bare
/// names are duplicated here because this side cannot read the front end's stylesheet at run time.
pub(crate) fn validate_theme_token(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("--") else {
        return false;
    };
    if BARE_THEME_TOKENS.contains(&rest) {
        return true;
    }
    let mut families = rest.splitn(2, '-');
    let family = families.next().unwrap_or_default();
    let tail = families.next().unwrap_or_default();
    matches!(family, "dsw" | "omp" | "sidebar")
        && !tail.is_empty()
        && tail.len() <= 64
        && tail.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
}

/// The unprefixed palette names `src/src/index.css` declares in `:root` (and `.dark`): the content
/// palette a theme may repaint. `--radius` and `--chart-1`..`--chart-5` are tokens too - they are
/// geometry and chart colours, not layout of their own.
const BARE_THEME_TOKENS: [&str; 25] = [
    "background",
    "foreground",
    "card",
    "card-foreground",
    "popover",
    "popover-foreground",
    "primary",
    "primary-foreground",
    "secondary",
    "secondary-foreground",
    "muted",
    "muted-foreground",
    "accent",
    "accent-foreground",
    "destructive",
    "border",
    "input",
    "ring",
    "radius",
    "chart-1",
    "chart-2",
    "chart-3",
    "chart-4",
    "chart-5",
    "sidebar",
];

/// The longest theme token value this layer carries, mirroring the host's own bound.
const THEME_VALUE_MAX: usize = 64;

/// Whether one theme token value is a value this application could hold.
///
/// The host checks the same thing while parsing the manifest, and this is the boundary's own pass
/// for the same reason the token names get one: a value from a host that validated less strictly
/// must not reach the renderer. The rule is the conservative half of the host's own shape
/// allow-list - bounded, printable, no declaration separators, and nothing naming a resource to
/// fetch - so an ordinary colour, length or font stack passes and a payload does not.
pub(crate) fn validate_theme_value(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > THEME_VALUE_MAX {
        return false;
    }
    if trimmed.chars().any(|character| character.is_control()) {
        return false;
    }
    if trimmed.contains([';', '{', '}', '@', '\\', '<', '>']) {
        return false;
    }
    let lowered = trimmed.to_ascii_lowercase();
    if [
        "url(",
        "image(",
        "image-set(",
        "src(",
        "element(",
        "paint(",
        "expression(",
    ]
    .iter()
    .any(|forbidden| lowered.contains(forbidden))
    {
        return false;
    }
    // A function call is allowed only when it is one the token sheet itself uses (a colour function,
    // or `var()` for a token built from another); anything else is a shape this layer cannot vouch
    // for, and the renderer would apply whatever it turned out to mean.
    if let Some(open) = trimmed.find('(') {
        let head = &trimmed[..open];
        let name = head
            .rsplit(|character: char| !(character.is_ascii_alphanumeric() || character == '-'))
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !matches!(
            name.as_str(),
            "rgb"
                | "rgba"
                | "hsl"
                | "hsla"
                | "oklab"
                | "oklch"
                | "color"
                | "color-mix"
                | "lab"
                | "lch"
                | "var"
        ) {
            return false;
        }
    }
    true
}

/// One install source, trimmed and bounded: what the user pasted, once this layer is sure it is
/// something the host can be asked about.
///
/// What a source *means* - a marketplace entry, an npm spec, a local directory, a git URL - is the
/// engine's classification, and re-deciding it here would be a second copy of that rule. So this
/// checks only what is this layer's to know: the text is non-empty, bounded, and carries no control
/// character (which is also what keeps a NUL out of the frame).
pub(crate) fn sanitize_source(spec: &str) -> IpcResult<String> {
    sanitize_token(spec, "plugin source", SOURCE_MAX_CHARS)
}

/// One plugin id, trimmed and bounded: a package name, or `name@marketplace`.
pub(crate) fn sanitize_id(id: &str) -> IpcResult<String> {
    sanitize_token(id, "plugin id", ID_MAX_CHARS)
}

/// One marketplace name, bounded the way an id is: it is the registry's own key, a short token
/// rather than free text.
pub(crate) fn sanitize_name(name: &str) -> IpcResult<String> {
    sanitize_token(name, "marketplace name", ID_MAX_CHARS)
}

/// Ceiling on a marketplace name this layer forwards where the host's own bound is the one that
/// decides: `PLUGIN_KEY_MAX` in `host/src/constants.ts`, which is the bound `marketplaces_remove`
/// and the store's catalogue read apply to the same field.
///
/// Stated apart from [`sanitize_name`] rather than tightening it, because the two answer different
/// questions: a name a *write* addresses may be longer than one the store's read accepts, and a
/// caller has to be refused with the rule its own command runs.
const MARKETPLACE_KEY_MAX_CHARS: usize = 128;

/// One marketplace name, bounded by the host's own ceiling for the field.
pub(crate) fn sanitize_marketplace_key(name: &str) -> IpcResult<String> {
    sanitize_token(name, "marketplace name", MARKETPLACE_KEY_MAX_CHARS)
}

/// One package digest as a URL install requires it: exactly 64 hex digits, lowercase by the time it
/// leaves this layer.
///
/// A URL source is the one install route that cannot fall back on a local `checksums.json`, so the
/// digest is not optional there and a value that is not a sha256 is refused as the argument it is -
/// before any byte of the download is read (spec §2.2, R3 §2.2).
pub(crate) fn sanitize_sha256(value: &str) -> IpcResult<String> {
    let digest = value.trim();
    if digest.len() != 64
        || !digest
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The checksum must be the 64 hexadecimal digits of a sha256 digest.",
        ));
    }
    Ok(digest.to_ascii_lowercase())
}

/// The shape every name this layer forwards has to have: trimmed, non-empty, bounded, and free of
/// control characters. `what` names the argument in the refusal, so the message says which field the
/// caller has to fix.
fn sanitize_token(value: &str, what: &'static str, limit: usize) -> IpcResult<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(IpcError::from_message(
            INVALID_INPUT,
            format!("The {what} is empty."),
        ));
    }
    if value.chars().count() > limit {
        return Err(IpcError::from_message(
            INVALID_INPUT,
            format!("The {what} is too long."),
        ));
    }
    if value.chars().any(char::is_control) {
        return Err(IpcError::from_message(
            INVALID_INPUT,
            format!("The {what} contains control characters."),
        ));
    }
    Ok(value.to_owned())
}

/// The scope a plugin write addresses: the engine's own two words, or nothing at all.
///
/// The answer is a `'static` token because the vocabulary is closed: what travels on is one of
/// three fixed strings, never the caller's text. An empty string is refused rather than read as
/// "no scope" - a caller with no scope omits the argument, and a caller that sends one blank is
/// addressing something this layer cannot name.
pub(crate) fn sanitize_scope(scope: Option<&str>) -> IpcResult<Option<&'static str>> {
    match scope {
        None => Ok(None),
        Some(value) => match value.trim() {
            "user" => Ok(Some("user")),
            "project" => Ok(Some("project")),
            _ => Err(IpcError::new(
                INVALID_INPUT,
                "The plugin scope must be user or project.",
            )),
        },
    }
}

/// The one gate this application owns: a plugin that can run code inside the agent process may be
/// enabled only once the user has confirmed it.
///
/// `consent_required` is the host's factual reading of the plugin, `granted` is this application's
/// record of the user's answer, and `enabling` says which direction the call goes. Disabling is
/// always allowed: refusing it would leave a plugin the user wants off running, which is the
/// opposite of what the gate is for.
///
/// This is the only place the decision is made, so the enable switch on the page and any later
/// caller of the same command are answered by one rule.
pub(crate) fn consent_block(
    consent_required: bool,
    granted: bool,
    enabling: bool,
) -> IpcResult<()> {
    if enabling && consent_required && !granted {
        return Err(IpcError::new(
            PLUGIN_CONSENT_REQUIRED,
            "This plugin runs code in the agent process and has not been confirmed.",
        ));
    }
    Ok(())
}

/// One plugin setting's key, checked against the host's own length ceiling before a call that names
/// it reaches the runtime.
///
/// The bound is the host's (`PLUGIN_KEY_MAX` in `host/src/constants.ts`), stated here so a key the
/// host would refuse on its way to the settings store is refused with the argument it belongs to:
/// a key that is merely unknown and a key that is too long to be one are different answers to the
/// caller, and this layer knows which it is holding.
pub(crate) fn validate_setting_key_length(key: &str) -> IpcResult<()> {
    if key.chars().count() > KEY_MAX_CHARS {
        return Err(IpcError::from_message(
            INVALID_INPUT,
            format!("The plugin setting key is longer than {KEY_MAX_CHARS} characters."),
        ));
    }
    Ok(())
}

/// One plugin setting's value, checked against that key's own schema before the host is asked to
/// store it.
///
/// The host validates the same write against the same manifest; this is the boundary copy, and it
/// exists because a settings write is the one place a value chosen on this side becomes engine
/// state: a value stored with the wrong type - or outside the range its author declared - is a
/// plugin running with something the user did not choose.
///
/// `schema` is the key's own entry (`{type, min, max, values, ...}`), `value` what the caller wants
/// stored. A type this build does not know is refused rather than forwarded: the page can render
/// the four this layer understands, and the plugin's schema is the authority on which one a key is.
pub(crate) fn validate_setting_value(schema: &Value, value: &Value) -> IpcResult<()> {
    let Some(entry) = schema.as_object() else {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The plugin setting has no schema.",
        ));
    };
    let Some(kind) = entry.get("type").and_then(Value::as_str) else {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The plugin setting declares no type.",
        ));
    };
    match kind {
        "string" => {
            let Some(text) = value.as_str() else {
                return Err(IpcError::new(
                    INVALID_INPUT,
                    "The plugin setting expects text.",
                ));
            };
            // `secret` is a flag on a string setting rather than a type of its own, so this bound
            // covers a stored secret exactly as it covers any other text. The count is in
            // characters, the same unit the host's own check uses.
            if text.chars().count() > SETTING_TEXT_MAX_CHARS {
                return Err(IpcError::new(
                    INVALID_INPUT,
                    "The plugin setting's text is longer than the host stores.",
                ));
            }
            Ok(())
        }
        "number" => {
            let Some(number) = value.as_f64() else {
                return Err(IpcError::new(
                    INVALID_INPUT,
                    "The plugin setting expects a number.",
                ));
            };
            // A declared bound is checked only when it is a number: a bound of another type is a
            // schema this layer cannot read, and guessing at it would let a value through the
            // engine's own check anyway.
            if let Some(min) = entry.get("min").and_then(Value::as_f64) {
                if number < min {
                    return Err(IpcError::new(
                        INVALID_INPUT,
                        "The plugin setting is below its minimum.",
                    ));
                }
            }
            if let Some(max) = entry.get("max").and_then(Value::as_f64) {
                if number > max {
                    return Err(IpcError::new(
                        INVALID_INPUT,
                        "The plugin setting is above its maximum.",
                    ));
                }
            }
            Ok(())
        }
        "boolean" => {
            if value.is_boolean() {
                Ok(())
            } else {
                Err(IpcError::new(
                    INVALID_INPUT,
                    "The plugin setting expects a boolean.",
                ))
            }
        }
        "enum" => {
            // The engine's own check is `values.includes(String(value))` over a list of declared
            // names (`@oh-my-pi/pi-coding-agent` `validateSetting`), so a choice is a *name* - text -
            // and the list is the set of names. This side takes that reading and accepts only an
            // actual string: a JSON number that happens to coerce onto a declared name (`1` onto
            // `"1"`) is refused here rather than forwarded, because the value the user chose is what
            // the plugin receives and "1" is not 1.
            let Some(choice) = value.as_str() else {
                return Err(IpcError::new(
                    INVALID_INPUT,
                    "The plugin setting expects one of its declared values.",
                ));
            };
            let Some(values) = entry.get("values").and_then(Value::as_array) else {
                // An enum without its list is a schema nothing can check, and "no list" cannot be
                // read as "anything goes": the write is refused instead.
                return Err(IpcError::new(
                    INVALID_INPUT,
                    "The plugin setting declares no values.",
                ));
            };
            // Only declared names count: an entry of another type is not a name any choice could
            // equal, so it cannot admit anything.
            if values
                .iter()
                .any(|declared| declared.as_str() == Some(choice))
            {
                Ok(())
            } else {
                Err(IpcError::new(
                    INVALID_INPUT,
                    "The plugin setting is not one of its declared values.",
                ))
            }
        }
        _ => Err(IpcError::new(
            INVALID_INPUT,
            "The plugin setting has a type this build does not serve.",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The consent gate is the one rule this application owns, so all four combinations are pinned:
    /// only turning a plugin on, when it needs consent and none was given, is refused.
    #[test]
    fn only_enabling_an_unconfirmed_code_plugin_is_refused() {
        let refused = consent_block(true, false, true).expect_err("needs confirmation");
        assert_eq!(refused.code.as_ref(), PLUGIN_CONSENT_REQUIRED);

        assert!(consent_block(true, true, true).is_ok(), "already confirmed");
        assert!(consent_block(false, false, true).is_ok(), "needs none");
        assert!(
            consent_block(true, false, false).is_ok(),
            "disabling is never gated"
        );
    }

    /// A theme may repaint the palette the document publishes - the rail and the conversation
    /// included - and nothing else: the name has to be one this build declares, so a theme cannot
    /// introduce a property of its own.
    #[test]
    fn theme_tokens_are_the_published_palette() {
        for name in [
            "--omp-pane",
            "--omp-titlebar-ink",
            "--dsw-alias-bg-base",
            "--sidebar",
            "--sidebar-foreground",
            "--background",
            "--card-foreground",
            "--muted",
            "--radius",
            "--chart-3",
        ] {
            assert!(validate_theme_token(name), "{name} is a published token");
        }
        for name in [
            "--window-frame",
            "--sidebarish",
            "--sidebar-",
            "--radius-x",
            "--chart-6",
            "--background-2",
            "--omp",
            "background",
            "--OMP-pane",
        ] {
            assert!(!validate_theme_token(name), "{name} is not");
        }
    }

    /// `fs.anyPath` is one of the names this build serves, and a near miss is not: the row conversion
    /// drops an out-of-set permission, so a misspelling has to be a token this side refuses rather
    /// than one it quietly keeps.
    #[test]
    fn the_unrestricted_file_permission_is_known_and_a_near_miss_is_not() {
        assert!(validate_permission_name("fs.anyPath"));
        for name in ["fs.anypath", "fs.any", "fs.anyPath.read", "fs.anyPath "] {
            assert!(!validate_permission_name(name), "{name}");
        }
    }

    /// Every allowed permission is accepted exactly as the spec spells it, and anything else - a
    /// near miss, a different case, a token from a later spec - is not.
    #[test]
    fn only_the_served_permissions_are_known() {
        for name in DESKTOP_PERMISSIONS {
            assert!(
                validate_permission_name(name),
                "{name} is served by this build"
            );
        }
        assert!(!validate_permission_name("ui.panel "));
        assert!(
            validate_permission_name("ui.theme.css"),
            "the stylesheet half of a theme is a permission this build serves"
        );
        assert!(validate_permission_name("ui.theme"));
        assert!(!validate_permission_name("UI.PANEL"));
        assert!(
            !validate_permission_name("fs.exec"),
            "a name outside the set is not a permission"
        );
        assert!(
            !validate_permission_name("clipboard.read.extra"),
            "a name outside the set is not a permission"
        );
        assert!(!validate_permission_name(""));
        assert!(!validate_permission_name("agent"));
    }

    /// A source is forwarded trimmed, and refused when it is empty, over-long or carries a control
    /// character - the three shapes that would otherwise travel into a frame.
    #[test]
    fn sources_are_trimmed_and_bounded() {
        assert_eq!(
            sanitize_source("  hello@official  ").expect("a marketplace source"),
            "hello@official"
        );
        assert_eq!(
            sanitize_source("@scope/pkg@1.2.3").expect("an npm spec"),
            "@scope/pkg@1.2.3"
        );

        assert!(sanitize_source("").is_err());
        assert!(sanitize_source("   ").is_err());
        assert!(sanitize_source(&"a".repeat(SOURCE_MAX_CHARS + 1)).is_err());
        assert!(sanitize_source("hello\u{0}world").is_err());
        assert!(sanitize_source("hello\nworld").is_err());
        assert_eq!(
            sanitize_source(&"a".repeat(SOURCE_MAX_CHARS)).expect("the limit"),
            "a".repeat(SOURCE_MAX_CHARS)
        );
    }

    /// Ids are bounded the same way, at their own length.
    #[test]
    fn ids_are_trimmed_and_bounded() {
        assert_eq!(
            sanitize_id(" hello@official ").expect("a marketplace id"),
            "hello@official"
        );
        assert!(sanitize_id("").is_err());
        assert!(sanitize_id("  ").is_err());
        assert!(sanitize_id(&"a".repeat(ID_MAX_CHARS + 1)).is_err());
        assert!(sanitize_id("hello\u{7}").is_err());
        assert_eq!(
            sanitize_id(&"a".repeat(ID_MAX_CHARS)).expect("the limit"),
            "a".repeat(ID_MAX_CHARS)
        );
    }

    /// Marketplace names are bounded like ids, and what travels on is the trimmed name.
    #[test]
    fn marketplace_names_are_trimmed_and_bounded() {
        assert_eq!(sanitize_name(" official ").expect("a name"), "official");
        assert_eq!(
            sanitize_name("owner/repo").expect("a source-shaped name"),
            "owner/repo"
        );

        assert!(sanitize_name("").is_err());
        assert!(sanitize_name("   ").is_err());
        assert!(sanitize_name(&"a".repeat(ID_MAX_CHARS + 1)).is_err());
        assert!(sanitize_name("off\u{1}icial").is_err());
    }

    /// The scope vocabulary is the engine's own two words; nothing means `None`, and everything
    /// else - including a blank string - is refused rather than interpreted.
    #[test]
    fn scopes_are_the_engine_vocabulary_or_absent() {
        assert_eq!(sanitize_scope(None).expect("no scope"), None);
        assert_eq!(sanitize_scope(Some("user")).expect("user"), Some("user"));
        assert_eq!(
            sanitize_scope(Some(" project ")).expect("project"),
            Some("project")
        );

        assert!(sanitize_scope(Some("")).is_err());
        assert!(sanitize_scope(Some("  ")).is_err());
        assert!(sanitize_scope(Some("workspace")).is_err());
        assert!(sanitize_scope(Some("User")).is_err());
    }

    /// A setting's value has to fit the schema its own key declares: all four types accepted, and
    /// each of the six ways a write can be wrong refused.
    #[test]
    fn setting_values_are_checked_against_their_schema() {
        // Accepted shapes.
        assert!(validate_setting_value(&json!({"type": "string"}), &json!("https://x")).is_ok());
        assert!(validate_setting_value(&json!({"type": "number"}), &json!(3)).is_ok());
        assert!(validate_setting_value(&json!({"type": "number"}), &json!(2.5)).is_ok());
        assert!(validate_setting_value(&json!({"type": "boolean"}), &json!(true)).is_ok());
        assert!(validate_setting_value(
            &json!({"type": "enum", "values": ["safe", "fast"]}),
            &json!("fast")
        )
        .is_ok());

        // 1. The key's type is not a type this build serves, or is not declared at all.
        assert!(validate_setting_value(&json!({"type": "object"}), &json!({})).is_err());
        assert!(validate_setting_value(&json!({"description": "x"}), &json!("x")).is_err());
        assert!(validate_setting_value(&json!("string"), &json!("x")).is_err());

        // 2. The value is not of the declared type.
        assert!(validate_setting_value(&json!({"type": "string"}), &json!(7)).is_err());
        assert!(validate_setting_value(&json!({"type": "number"}), &json!("7")).is_err());
        assert!(validate_setting_value(&json!({"type": "boolean"}), &json!("true")).is_err());
        assert!(validate_setting_value(&json!({"type": "boolean"}), &json!(null)).is_err());

        // 3. A number outside its declared bounds.
        let bounded = json!({"type": "number", "min": 0, "max": 10});
        assert!(validate_setting_value(&bounded, &json!(0)).is_ok());
        assert!(validate_setting_value(&bounded, &json!(10)).is_ok());
        assert!(validate_setting_value(&bounded, &json!(-1)).is_err());
        assert!(validate_setting_value(&bounded, &json!(99)).is_err());

        // 4. A choice outside the declared values.
        let enumerated = json!({"type": "enum", "values": ["safe", "fast"]});
        assert!(validate_setting_value(&enumerated, &json!("safe")).is_ok());
        assert!(validate_setting_value(&enumerated, &json!("turbo")).is_err());
        assert!(validate_setting_value(&enumerated, &json!(1)).is_err());
        // A choice is a declared *name*, which is what the engine stores: a number that would
        // coerce onto one ("1" onto 1) is refused here rather than forwarded as that name.
        let numeric = json!({"type": "enum", "values": [1, 2]});
        assert!(validate_setting_value(&numeric, &json!(2)).is_err());
        assert!(validate_setting_value(&numeric, &json!("2")).is_err());
        let names = json!({"type": "enum", "values": ["1", "2"]});
        assert!(validate_setting_value(&names, &json!("2")).is_ok());
        assert!(validate_setting_value(&names, &json!(2)).is_err());

        // 5. An enum whose list is missing cannot be checked, so nothing is stored through it.
        assert!(validate_setting_value(&json!({"type": "enum"}), &json!("safe")).is_err());

        // 6. Text is bounded at the host's own ceiling: the limit itself passes, one character past
        // it does not (the same value would be refused on the far side of the pipe).
        assert!(validate_setting_value(
            &json!({"type": "string"}),
            &json!("a".repeat(SETTING_TEXT_MAX_CHARS))
        )
        .is_ok());
        assert!(validate_setting_value(
            &json!({"type": "string"}),
            &json!("a".repeat(SETTING_TEXT_MAX_CHARS + 1))
        )
        .is_err());
        // The bound is on characters, not bytes: a multi-byte text of legal length still passes.
        assert!(validate_setting_value(
            &json!({"type": "string"}),
            &json!("é".repeat(SETTING_TEXT_MAX_CHARS))
        )
        .is_ok());
    }

    /// A setting key is bounded at the host's ceiling (`PLUGIN_KEY_MAX`): the limit passes, one
    /// character past it is refused. Emptiness is deliberately not this check's business - a key
    /// that names nothing is answered by the schema lookup itself.
    #[test]
    fn setting_keys_are_bounded_at_the_hosts_ceiling() {
        assert!(validate_setting_key_length("apiKey").is_ok());
        assert!(validate_setting_key_length(&"k".repeat(KEY_MAX_CHARS)).is_ok());
        assert!(validate_setting_key_length(&"k".repeat(KEY_MAX_CHARS + 1)).is_err());
        assert!(validate_setting_key_length("").is_ok());
    }

    /// A marketplace name the store's read addresses is bounded by the host's own ceiling for the
    /// field, which is the bound that read applies on the far side of the pipe.
    #[test]
    fn marketplace_names_are_bounded_at_the_hosts_key_ceiling() {
        assert!(sanitize_marketplace_key("omp-desktop-builtin").is_ok());
        assert!(sanitize_marketplace_key(&"m".repeat(MARKETPLACE_KEY_MAX_CHARS)).is_ok());
        assert!(sanitize_marketplace_key(&"m".repeat(MARKETPLACE_KEY_MAX_CHARS + 1)).is_err());
        assert!(sanitize_marketplace_key("  ").is_err());
        assert!(sanitize_marketplace_key("bad\u{0}name").is_err());
    }

    /// A URL install's checksum is a sha256 and nothing else: the length and the alphabet are the
    /// whole rule, and the digest leaves this layer lowercase so two spellings of one digest are one
    /// value to the comparison that follows the download.
    #[test]
    fn a_url_installs_checksum_is_a_sha256() {
        let digest = "A".repeat(64);
        assert_eq!(
            sanitize_sha256(&digest).expect("64 hex digits"),
            "a".repeat(64)
        );
        assert_eq!(
            sanitize_sha256(&format!("  {}  ", "0".repeat(64))).expect("trimmed"),
            "0".repeat(64)
        );
        for refused in [
            String::new(),
            "0".repeat(63),
            "0".repeat(65),
            format!("{}z", "0".repeat(63)),
            "not a digest".to_owned(),
        ] {
            assert!(sanitize_sha256(&refused).is_err(), "{refused}");
        }
    }
}
