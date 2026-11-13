//! The built-in plugins' identity and guard rules, read without an engine or a window.
//!
//! Split from the module itself (`rules.md#single-file-line-limit`): the reserved identity and the trust mark, and the
//! removals this application refuses. What is pinned here is what a caller can observe - a refusal
//! code, a trust answer - never the source's own shape. The seeding decision (`plan`) and its
//! process-level cache are tested beside the code that holds them (`super::sync`).

use super::test_support::*;
use super::*;

/// The definition table is the single source of the identities this module and `builtin::sync` act
/// on, and this build ships two plugins: the terminal, whose work-panel tab the application draws
/// itself, and the auto-continue extension, whose switch the user may turn off. Every entry, the
/// constants the rest of the crate spells and the directory each package lives in have to agree, or
/// a build would seed a package its own catalogue does not list.
#[test]
fn the_definition_table_names_the_plugins_this_build_ships() {
    assert_eq!(BUILTIN_DEFINITIONS.len(), 2);
    for def in BUILTIN_DEFINITIONS {
        // The literals the rest of the crate spells, spelled once more here so a rename cannot slip
        // past: the package name (which *is* the plugin id, plan D0), the reserved marketplace, and
        // the engine's own `name@marketplace` derivation of the installation handle.
        assert_eq!(BUILTIN_MARKETPLACE_NAME, "omp-desktop-builtin");
        assert_eq!(
            format!("{}@{}", def.name, BUILTIN_MARKETPLACE_NAME),
            def.install_id
        );
        assert_eq!(def.package_dir, def.name);
        // The identity helpers read that entry rather than a second copy of the strings.
        assert!(is_builtin_plugin(def.name));
        assert_eq!(
            def_for_plugin_id(def.name).map(|found| found.name),
            Some(def.name)
        );
        // The write-side lookup is the handle's, and answers for the same definition.
        assert!(is_builtin_install_spec(def.install_id));
        assert!(!is_builtin_install_spec(def.name));
    }
    // The resource directory keeps its historical name: it is part of an existing installation's
    // identity (the engine records the path as the marketplace's `source_uri`), so renaming it would
    // orphan every install that predates the change.
    assert_eq!(BUILTIN_RESOURCE_DIR, "builtin-browser-marketplace");
    assert_eq!(BUILTIN_SCOPE, "user");

    let terminal = &BUILTIN_DEFINITIONS[0];
    assert_eq!(terminal.name, "omp.terminal");
    assert_eq!(terminal.install_id, "omp.terminal@omp-desktop-builtin");
    assert_eq!(terminal.package_dir, "omp.terminal");
    assert!(
        !terminal.toggleable,
        "the terminal is the surface the build promises; its switch stays closed"
    );

    let auto_continue = &BUILTIN_DEFINITIONS[1];
    assert_eq!(auto_continue.name, "omp.auto-continue");
    assert_eq!(
        auto_continue.install_id,
        "omp.auto-continue@omp-desktop-builtin"
    );
    assert_eq!(auto_continue.package_dir, "omp.auto-continue");
    assert!(
        auto_continue.toggleable,
        "the auto-continue behavior is the user's to switch off"
    );

    assert!(
        !is_builtin_install_spec("omp.browser@omp-desktop-builtin"),
        "the browser is a first-party surface now, not a seeded plugin"
    );

    // A same-named package from somebody else's marketplace is not a built-in plugin, whichever way
    // it is addressed: its handle is not one this build derives, and its id alone names no seed.
    assert!(!is_builtin_install_spec(
        "omp.terminal@some-other-marketplace"
    ));
    assert!(
        !is_builtin_install_spec("omp.terminal"),
        "the plugin id alone is not an engine handle"
    );
    assert!(!is_builtin_plugin("other-plugin"));
    assert!(def_for_plugin_id("other-plugin").is_none());
}

/// The built-in installation is recognised from the facts a row reports about where it came from -
/// its plugin id, its scope, and the marketplace that recorded it - and never from the id a package
/// spells for itself. A same-named install from another marketplace, a linked one, and one at
/// another scope are all ordinary plugins.
#[test]
fn only_the_facts_of_the_reserved_installation_make_a_row_built_in() {
    let def = def_for_plugin_id("omp.terminal").expect("this build ships one");
    assert!(is_builtin_row(&row(
        def.name,
        "marketplace",
        Some(BUILTIN_MARKETPLACE_NAME)
    )));
    assert!(!is_builtin_row(&row(def.name, "npm", None)));
    assert!(!is_builtin_row(&row(def.name, "link", None)));
    // The same plugin name from somebody else's marketplace: not ours.
    assert!(!is_builtin_row(&row(
        def.name,
        "marketplace",
        Some("some-other-marketplace")
    )));
    // Another plugin from the reserved marketplace is not a plugin this build ships either.
    assert!(!is_builtin_row(&row(
        "other-plugin",
        "marketplace",
        Some(BUILTIN_MARKETPLACE_NAME)
    )));
    // The bundle is seeded at the user scope; a project-scope install of the same plugin is a
    // different installation.
    let mut project = row(def.name, "marketplace", Some(BUILTIN_MARKETPLACE_NAME));
    project.scope = "project".to_owned();
    assert!(!is_builtin_row(&project));
    // A row from a host that predates `installId` still resolves: the identity rule collapses its
    // handle, and the marketplace is still the host's own fact.
    let mut legacy = row(def.name, "marketplace", Some(BUILTIN_MARKETPLACE_NAME));
    legacy.install_id = None;
    legacy.source.install_id = None;
    legacy.id = def.install_id.to_owned();
    assert!(is_builtin_row(&legacy));
    legacy.source.marketplace = None;
    assert!(
        !is_builtin_row(&legacy),
        "without the marketplace fact nothing is proven"
    );
}

/// The trust mark is written onto a host list in exactly one place, and only for the row whose
/// facts are the reserved installation's *and* whose marketplace was verified to be this
/// application's bundle. Without the verification half, a same-named marketplace registered before
/// the first seed would be trusted as built-in - and a same-named plugin from any other marketplace
/// is not marked even then, because the marketplace it came from is the fact being judged.
#[test]
fn the_trust_mark_needs_the_reserved_facts_and_a_verified_marketplace() {
    let terminal = def_for_plugin_id("omp.terminal").expect("this build ships one");
    let auto_continue = def_for_plugin_id("omp.auto-continue").expect("this build ships one");
    let mut view = EnginePluginsView {
        plugins: vec![
            row(terminal.name, "marketplace", Some(BUILTIN_MARKETPLACE_NAME)),
            row(
                auto_continue.name,
                "marketplace",
                Some(BUILTIN_MARKETPLACE_NAME),
            ),
            // Same plugin name, somebody else's marketplace: a third-party plugin.
            row(terminal.name, "marketplace", Some("some-marketplace")),
            row(terminal.name, "npm", None),
            row("other-plugin", "marketplace", Some("some-marketplace")),
        ],
    };
    // Unverified: nothing is marked, however the row spells itself.
    apply_trust(&mut view, false);
    assert!(view.plugins.iter().all(|row| !row.builtin));
    assert!(
        view.plugins.iter().all(|row| row.toggleable),
        "an unmarked row is an ordinary plugin, so its switch stays open"
    );

    // Verified: exactly the rows that are this application's own installations are marked, and only
    // the definition that opted in keeps its switch open.
    apply_trust(&mut view, true);
    assert!(view.plugins[0].builtin);
    assert!(!view.plugins[0].toggleable);
    assert!(view.plugins[1].builtin);
    assert!(view.plugins[1].toggleable);
    assert!(!view.plugins[2].builtin);
    assert!(view.plugins[2].toggleable);
    assert!(!view.plugins[3].builtin);
    assert!(view.plugins[3].toggleable);
    assert!(!view.plugins[4].builtin);
    assert!(view.plugins[4].toggleable);
}

/// One predicate answers "may the user switch this off", for the page and for the write alike.
///
/// The two sides used to derive it separately, so a one-sided edit could offer a switch that then
/// refused, or close one that accepted. This pins the predicate itself, and both of its callers.
#[test]
fn one_predicate_decides_the_switch_for_the_page_and_the_write() {
    // An ordinary plugin is always the user's to switch, whatever its id spells.
    assert!(switch_open(false, "omp.auto-continue"));
    assert!(switch_open(false, "some-third-party"));
    // A built-in follows its definition: the terminal is the surface the build promises.
    assert!(!switch_open(true, "omp.terminal"));
    // The auto-continue definition opted in.
    assert!(switch_open(true, "omp.auto-continue"));
    // A row marked built-in whose id names no definition this build carries has no opt-in to read,
    // so its switch stays closed - the fail-closed direction, the same one the write takes.
    assert!(!switch_open(true, "some-third-party"));
}

/// The removals this application refuses are refused by name, and nothing else is - and the
/// marketplace one is refused only while the row really is this application's own, because a row
/// holding the reserved name against somebody else's source is the conflict the seed fails closed
/// on, and removing it is the only way out of that state.
///
/// The built-in installations themselves are protected: neither a switch-off nor a removal is the
/// user's to make, and a row the marketplace check cannot prove is an ordinary plugin.
#[test]
fn the_reserved_marketplace_is_refused_and_the_built_in_installations_are_protected() {
    let bundle = Path::new("/bundle/builtin-browser-marketplace");
    let reserved = |source: Option<&str>, root: Option<&Path>| {
        marketplace_removal_refusal(BUILTIN_MARKETPLACE_NAME, source, root)
    };
    // The row this application registered: the bundle itself, or a directory inside it.
    for source in [
        "/bundle/builtin-browser-marketplace",
        "/bundle/builtin-browser-marketplace/package",
    ] {
        let refusal = reserved(Some(source), Some(bundle)).expect("this application's own");
        assert_eq!(refusal.code, PLUGIN_MARKETPLACE_RESERVED);
    }
    // The reserved name against somebody else's source: removable, which is the recovery path.
    assert!(reserved(Some("/somewhere/else/catalog"), Some(bundle)).is_none());
    assert!(reserved(Some("/bundle/other-marketplace"), Some(bundle)).is_none());
    // Nothing registered under the name, and a bundle this build cannot resolve: nothing this
    // application can prove is its own, so the row is the user's to manage.
    assert!(reserved(None, Some(bundle)).is_none());
    assert!(reserved(Some("/bundle/builtin-browser-marketplace"), None).is_none());
    // Every other name is untouched by this guard.
    assert!(marketplace_removal_refusal(
        "some-marketplace",
        Some("/bundle/builtin-browser-marketplace"),
        Some(bundle)
    )
    .is_none());

    // A verified built-in is removed by nobody, and its switch-off is refused unless the definition
    // opted in. The proof is the same marketplace check the seed and the trust mark use. A same-named
    // plugin from another marketplace, and a marketplace that merely holds the reserved name against
    // somebody else's source, both stay the user's to manage.
    let terminal = def_for_plugin_id("omp.terminal").expect("this build ships one");
    let auto_continue = def_for_plugin_id("omp.auto-continue").expect("this build ships one");
    let owned = row(terminal.name, "marketplace", Some(BUILTIN_MARKETPLACE_NAME));
    let auto_owned = row(
        auto_continue.name,
        "marketplace",
        Some(BUILTIN_MARKETPLACE_NAME),
    );
    for target in [&owned, &auto_owned] {
        let refusal = protection_refusal(&[target], true, BuiltinWrite::Remove)
            .expect("a built-in is not the user's to remove");
        assert_eq!(refusal.code, PLUGIN_BUILTIN_PROTECTED);
    }
    // The terminal's switch is the build's surface and stays closed.
    assert!(
        protection_refusal(&[&owned], true, BuiltinWrite::SwitchOff).is_some(),
        "the terminal cannot be switched off"
    );
    // The auto-continue definition opted into the switch, so its off state is the user's answer.
    assert!(
        protection_refusal(&[&auto_owned], true, BuiltinWrite::SwitchOff).is_none(),
        "the auto-continue plugin is the user's to switch off"
    );
    assert!(
        protection_refusal(&[&owned], false, BuiltinWrite::SwitchOff).is_none(),
        "without the marketplace proof nothing is protected"
    );
    assert!(
        protection_refusal(&[&owned], false, BuiltinWrite::Remove).is_none(),
        "without the marketplace proof nothing is protected"
    );
    // A same-named installation from somebody else's marketplace: an ordinary plugin.
    let foreign = row(terminal.name, "marketplace", Some("some-other-marketplace"));
    assert!(protection_refusal(&[&foreign], true, BuiltinWrite::SwitchOff).is_none());
    assert!(protection_refusal(&[&foreign], true, BuiltinWrite::Remove).is_none());
    // The same plugin installed at another scope is a different installation.
    let mut project = row(terminal.name, "marketplace", Some(BUILTIN_MARKETPLACE_NAME));
    project.scope = "project".to_owned();
    assert!(protection_refusal(&[&project], true, BuiltinWrite::SwitchOff).is_none());
    assert!(protection_refusal(&[&project], true, BuiltinWrite::Remove).is_none());
    // Another plugin from the reserved marketplace is not one this build ships.
    let other = row(
        "other-plugin",
        "marketplace",
        Some(BUILTIN_MARKETPLACE_NAME),
    );
    assert!(protection_refusal(&[&other], true, BuiltinWrite::Remove).is_none());
    assert!(protection_refusal(&[&other], true, BuiltinWrite::SwitchOff).is_none());
    // No row addressed at all: the engine's own answer about an installation it does not have.
    assert!(protection_refusal(&[], true, BuiltinWrite::Remove).is_none());
    assert!(protection_refusal(&[], true, BuiltinWrite::SwitchOff).is_none());

    // The restore route seeds the plugins this application ships and refuses everything else,
    // because it must not put back whatever a caller happened to name.
    assert!(restore_refusal(terminal.name).is_none());
    assert!(restore_refusal(auto_continue.name).is_none());
    let unknown = restore_refusal("other-plugin").expect("not this application's");
    assert_eq!(unknown.code, PLUGIN_BUILTIN_UNKNOWN);
    assert!(restore_refusal(terminal.install_id).is_some());
    assert!(restore_refusal(auto_continue.install_id).is_some());

    // The public install route is closed for the reserved spec and for nothing else: the seed
    // installs through the runtime itself, so a caller cannot replace the installation - or
    // re-enable a copy the user switched off - by naming it here. An imported package that
    // happens to carry the same package name resolves to `<name>-import`, which is a different
    // installation and stays installable.
    let install = install_refusal(terminal.install_id).expect("reserved spec");
    assert_eq!(install.code, PLUGIN_INSTALL_RESERVED);
    assert!(install_refusal(" omp.terminal@omp-desktop-builtin ").is_some());
    assert!(install_refusal("omp.terminal@omp.terminal-import").is_none());
    assert!(install_refusal("omp.terminal").is_none());
    assert!(install_refusal(auto_continue.install_id).is_some());
    assert!(install_refusal("omp.auto-continue@omp.auto-continue-import").is_none());
    assert!(install_refusal("other-plugin@some-marketplace").is_none());
}

/// The bundled packages' *version* is what makes a new build reach an existing installation, so a
/// change to any of their files has to move it.
///
/// A built-in plugin is installed into a cache directory keyed by its version
/// (`plugins/cache/plugins/<marketplace>___<name>___<version>`), and the seed only touches it when
/// the engine's own update check reports a newer version. Editing the shipped files without bumping
/// the version therefore leaves every existing data root on the old copy for good - which is how
/// the pause mark and the load bar already in the source once never reached the running application
/// (2026-10-26: the installed copy was the same 0.2.0 built hours earlier). A version and digest are
/// pinned per package below, so editing any file of one fails here until both manifests are bumped
/// (`package/<name>/package.json` and `.omp-plugin/marketplace.json`).
#[test]
fn a_change_to_a_bundled_package_comes_with_a_version_bump() {
    /// Package name → the version both manifests must declare, and `sha256` over that package's
    /// files as `path\0content\0` in path order, CRLF normalized (the working tree's line endings
    /// are the checkout's business, not the package's).
    const PINS: &[(&str, &str, &str)] = &[
        (
            "omp.terminal",
            "0.2.1",
            "392072cfc3da6f064001461c3790b891ccaa30a3bf7523b4c4e32ee9633ae615",
        ),
        (
            "omp.auto-continue",
            "0.1.0",
            "d1abd56e544494e5c7a627dab085d74870dad00400023fac25b28f438ca82987",
        ),
    ];

    use std::fs;
    use std::path::PathBuf;

    use sha2::{Digest, Sha256};

    fn collect(directory: &Path, prefix: &str, files: &mut Vec<(String, PathBuf)>) {
        let entries = fs::read_dir(directory).expect("the bundled package is readable");
        for entry in entries {
            let entry = entry.expect("a bundled package entry");
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            let relative = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            if path.is_dir() {
                collect(&path, &relative, files);
            } else {
                files.push((relative, path));
            }
        }
    }

    fn normalized(bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(bytes.len());
        let mut index = 0;
        while index < bytes.len() {
            if bytes[index] == b'\r' && bytes.get(index + 1) == Some(&b'\n') {
                index += 1;
                continue;
            }
            out.push(bytes[index]);
            index += 1;
        }
        out
    }

    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(BUILTIN_RESOURCE_DIR);
    let catalogue: Value = serde_json::from_str(
        &fs::read_to_string(root.join(".omp-plugin").join("marketplace.json"))
            .expect("the bundled catalogue"),
    )
    .expect("the bundled catalogue is JSON");
    for def in BUILTIN_DEFINITIONS {
        let (_, version, digest) = PINS
            .iter()
            .find(|(name, _, _)| *name == def.name)
            .expect("every shipped package is pinned here");
        let package = root.join("package").join(def.package_dir);
        let manifest: Value = serde_json::from_str(
            &fs::read_to_string(package.join("package.json"))
                .expect("the bundled package manifest"),
        )
        .expect("the bundled package manifest is JSON");
        assert_eq!(
            manifest.get("version").and_then(Value::as_str),
            Some(*version),
            "the bundled package {} moved without this pin: bump it in package.json and in the \
             catalogue beside it, then update this test",
            def.name
        );

        let listed = catalogue
            .get("plugins")
            .and_then(Value::as_array)
            .and_then(|plugins| {
                plugins
                    .iter()
                    .find(|plugin| plugin.get("name").and_then(Value::as_str) == Some(def.name))
            })
            .expect("the catalogue lists the shipped package");
        assert_eq!(
            listed.get("version").and_then(Value::as_str),
            Some(*version),
            "the catalogue and the package must declare the same version for {}",
            def.name
        );

        let mut files = Vec::new();
        collect(&package, "", &mut files);
        files.sort_by(|left, right| left.0.cmp(&right.0));
        let mut hasher = Sha256::new();
        for (relative, path) in &files {
            let bytes = normalized(&fs::read(path).expect("a bundled package file is readable"));
            hasher.update(relative.as_bytes());
            hasher.update([0u8]);
            hasher.update(&bytes);
            hasher.update([0u8]);
        }
        let digest_hex: String = hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_eq!(
            digest_hex, *digest,
            "the bundled package {} changed without a version bump: raise VERSION in both manifests \
             (and in this test), then update DIGEST; an install at the same version is never \
             rewritten",
            def.name
        );
    }
}
