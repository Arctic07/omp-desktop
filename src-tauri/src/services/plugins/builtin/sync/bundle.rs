//! The bundled catalogue as this process reads it: where it is, and what each definition declares
//! inside it.
//!
//! Split from the seeding half (`rules.md#single-file-line-limit`) because the two answer different questions. This
//! module knows only how to find the bundle this build was packaged with and how to read one
//! definition's manifest out of it; it holds no state, calls no engine and decides nothing about
//! whether anything should be installed. The rules about what may be trusted, what a version means
//! and when a synchronization runs stay in `super`.

use std::path::PathBuf;

use serde_json::Value;
use tauri::path::BaseDirectory;
use tauri::Manager;

use crate::services::log;
use crate::services::plugins::builtin::{
    BuiltinDef, BUILTIN_MARKETPLACE_NAME, BUILTIN_RESOURCE_DIR,
};

/// The bundled catalogue as this process reads it: where it is. What each definition declares is
/// read per definition ([`Bundle::version`]), because one bundle can carry several packages.
#[derive(Debug, Clone)]
pub(super) struct Bundle {
    pub(super) root: PathBuf,
}

impl Bundle {
    /// The version one definition declares in this bundle, when this build ships a readable copy of
    /// it.
    ///
    /// The file is `<root>/package/<def.package_dir>/package.json`, and it has to be the package this
    /// module knows about: an installer that shipped something else under that directory would
    /// otherwise be seeded as the built-in plugin. `None` - a missing or unreadable manifest, a
    /// manifest that is not JSON, a name that is not the definition's, or no version at all - means
    /// this definition is skipped with a warn rather than seeded from a file nothing vouches for.
    pub(super) fn version(&self, def: &BuiltinDef) -> Option<String> {
        let manifest = self
            .root
            .join("package")
            .join(def.package_dir)
            .join("package.json");
        let text = match std::fs::read_to_string(&manifest) {
            Ok(text) => text,
            Err(error) => {
                log::warn(&format!(
                    "the built-in plugin {} is missing its manifest ({}): {error}",
                    def.name,
                    manifest.display()
                ));
                return None;
            }
        };
        let parsed: Value = match serde_json::from_str(&text) {
            Ok(parsed) => parsed,
            Err(error) => {
                log::warn(&format!(
                    "the built-in plugin {} has a manifest that is not JSON ({}): {error}",
                    def.name,
                    manifest.display()
                ));
                return None;
            }
        };
        let name = parsed
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if name != def.name {
            log::warn(&format!(
                "the bundled copy of {} declares the package name \"{name}\" rather than \"{}\"",
                def.name, def.name
            ));
            return None;
        }
        let version = parsed
            .get("version")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|version| !version.is_empty())
            .map(str::to_owned);
        if version.is_none() {
            log::warn(&format!(
                "the built-in plugin {} declares no version, so it cannot be kept in step",
                def.name
            ));
        }
        version
    }
}

/// Reads the bundled catalogue from the resource directory this build was packaged with.
///
/// Only the bundle's own existence is settled here: the directory, and the catalogue it holds being
/// the reserved marketplace this application declares. What each definition's package declares is
/// read per definition ([`Bundle::version`]), because one catalogue can list several packages and a
/// missing or unusable one of them is that definition's problem rather than the bundle's.
pub(super) fn resolve_bundle(app: &tauri::AppHandle) -> Option<Bundle> {
    let root = match app
        .path()
        .resolve(BUILTIN_RESOURCE_DIR, BaseDirectory::Resource)
    {
        Ok(root) => root,
        Err(error) => {
            log::warn(&format!(
                "the built-in plugin bundle could not be located in this build's resources: {error}"
            ));
            return None;
        }
    };
    let catalog = root.join(".omp-plugin").join("marketplace.json");
    let text = match std::fs::read_to_string(&catalog) {
        Ok(text) => text,
        Err(error) => {
            log::warn(&format!(
                "the built-in plugin bundle is missing its catalogue ({}): {error}",
                catalog.display()
            ));
            return None;
        }
    };
    let parsed: Value = match serde_json::from_str(&text) {
        Ok(parsed) => parsed,
        Err(error) => {
            log::warn(&format!(
                "the built-in plugin bundle's catalogue is not JSON ({}): {error}",
                catalog.display()
            ));
            return None;
        }
    };
    // The catalogue has to be the reserved marketplace this application declares: a bundle whose
    // catalogue names somebody else's marketplace would be registered under a name the rest of this
    // module does not recognise as its own.
    let name = parsed
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if name != BUILTIN_MARKETPLACE_NAME {
        log::warn(&format!(
            "the built-in plugin bundle's catalogue declares the marketplace name \"{name}\" rather than \"{BUILTIN_MARKETPLACE_NAME}\""
        ));
        return None;
    }
    Some(Bundle { root })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::plugins::builtin::BuiltinDef;

    /// One definition shaped like the ones a build carries, so the manifest read is asserted per
    /// definition rather than per hard-coded path.
    const DEF: BuiltinDef = BuiltinDef {
        name: "omp.example",
        install_id: "omp.example@omp-desktop-builtin",
        package_dir: "omp.example",
    };

    /// A bundle directory holding one definition's manifest, keyed by tag so parallel tests never
    /// share a tree.
    fn bundle(tag: &str, body: Option<&str>) -> Bundle {
        let root = std::env::temp_dir().join(format!("omp-bundle-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let package = root.join("package").join(DEF.package_dir);
        std::fs::create_dir_all(&package).expect("package directory");
        if let Some(body) = body {
            std::fs::write(package.join("package.json"), body).expect("manifest");
        }
        Bundle { root }
    }

    /// The version comes from the definition's own directory, and only from a manifest that really
    /// declares that definition's package name: a bundle that shipped somebody else's package under
    /// this directory is skipped rather than seeded.
    #[test]
    fn a_definitions_version_is_read_from_its_own_directory() {
        let ok = bundle(
            "ok",
            Some("{\"name\":\"omp.example\",\"version\":\" 1.2.3 \"}\n"),
        );
        assert_eq!(ok.version(&DEF).as_deref(), Some("1.2.3"));
        let _ = std::fs::remove_dir_all(&ok.root);

        // The name is the guard: another package under the same directory is not this definition.
        let wrong = bundle(
            "wrong-name",
            Some("{\"name\":\"omp.other\",\"version\":\"9.9.9\"}\n"),
        );
        assert_eq!(wrong.version(&DEF), None);
        let _ = std::fs::remove_dir_all(&wrong.root);

        // No usable version is the same answer as no manifest at all: the definition is skipped.
        for (tag, body) in [
            ("no-version", Some("{\"name\":\"omp.example\"}\n")),
            (
                "blank-version",
                Some("{\"name\":\"omp.example\",\"version\":\"  \"}\n"),
            ),
            ("not-json", Some("not json\n")),
            ("missing", None),
        ] {
            let broken = bundle(tag, body);
            assert_eq!(broken.version(&DEF), None, "{tag}");
            let _ = std::fs::remove_dir_all(&broken.root);
        }
    }

    /// A build that ships a definition reads it out of `package/<package_dir>/`, which is the layout
    /// the installer writes: the definition's own directory, never the bundle root.
    #[test]
    fn a_shipped_definition_is_read_from_its_package_directory() {
        let def = crate::services::plugins::builtin::def_for_plugin_id("omp.terminal")
            .expect("this build ships the terminal definition");
        let root = std::env::temp_dir().join(format!("omp-bundle-shipped-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let package = root.join("package").join(def.package_dir);
        std::fs::create_dir_all(&package).expect("package directory");
        std::fs::write(
            package.join("package.json"),
            format!("{{\"name\":\"{}\",\"version\":\"0.0.1\"}}\n", def.name),
        )
        .expect("manifest");
        let bundle = Bundle { root: root.clone() };
        assert_eq!(bundle.version(def).as_deref(), Some("0.0.1"));
        // A manifest sitting beside the package directory is not the definition's: the read is the
        // definition's own directory, never the bundle root.
        std::fs::write(
            root.join("package").join("package.json"),
            format!("{{\"name\":\"{}\",\"version\":\"9.9.9\"}}\n", def.name),
        )
        .expect("stray manifest");
        assert_eq!(bundle.version(def).as_deref(), Some("0.0.1"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
