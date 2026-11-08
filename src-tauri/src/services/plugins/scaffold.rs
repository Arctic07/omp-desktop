//! The template entry point: a new plugin's first files, copied out of this build's resources into a
//! directory the user picked (R4 §3.3).
//!
//! Four templates ship with the application (`panel-basic`, `agent-tool-basic`, `skill-pack`,
//! `renderer-slots-basic`) and they are what "new plugin" means here: the user picks one and a
//! directory, and the template is copied into `<directory>/<template>`. Nothing is registered,
//! nothing is installed and nothing is opened - a created plugin is a directory of files the user is
//! expected to edit, and installing it afterwards is the ordinary "install from a source" path.
//!
//! The guards are on the *destination*, which is the half a user chooses: an absolute path that
//! exists and is a directory, outside this application's own data root (a plugin is the user's file,
//! not this application's data), and a destination that does not exist yet or holds nothing at all -
//! a template never overwrites a file, so a name collision is refused rather than resolved. The
//! source is a directory this build shipped, so it is read, never re-checked for escapes: nothing
//! outside the chosen destination is ever written.
//!
//! A build that cannot read the template it ships answers `PLUGIN_BUILTIN_UNAVAILABLE`, the same
//! code a build that cannot read its built-in plugin answers: both are "this build does not have the
//! copy it ships", which is not the caller's input to fix.

use std::path::Path;

use tauri::path::BaseDirectory;
use tauri::Manager;

use crate::errors::{
    IpcError, IpcResult, INVALID_INPUT, PLUGIN_BUILTIN_UNAVAILABLE, PLUGIN_INSTALL_FAILED,
};
use crate::services::log;
use crate::services::paths::{is_within, DataPaths};

/// The templates this build ships, and the only names the command accepts. The names are the
/// directory names under the bundled `plugin-templates` resource.
pub(crate) const TEMPLATES: [&str; 4] = [
    "panel-basic",
    "agent-tool-basic",
    "skill-pack",
    "renderer-slots-basic",
];

/// The resource directory the templates live in (`tauri.conf.json`, `bundle.resources`).
const TEMPLATE_RESOURCE_DIR: &str = "plugin-templates";

/// Copies one template into `<targetDir>/<template>` and answers the directory it wrote.
pub(crate) async fn create(
    app: &tauri::AppHandle,
    paths: &DataPaths,
    template: &str,
    target_dir: &str,
) -> IpcResult<String> {
    let template = template.trim();
    if !TEMPLATES.contains(&template) {
        return Err(IpcError::new(
            INVALID_INPUT,
            "That is not one of the plugin templates this build ships.",
        ));
    }
    let chosen = target_dir.trim();
    let target = Path::new(chosen);
    if let Some(message) =
        target_refusal(chosen, target.is_dir(), is_within(&paths.data_root, target))
    {
        return Err(IpcError::new(INVALID_INPUT, message));
    }
    let destination = target.join(template);
    let exists = destination.exists();
    if let Some(message) = destination_refusal(exists, exists && is_empty_directory(&destination)) {
        return Err(IpcError::new(INVALID_INPUT, message));
    }
    let source = app
        .path()
        .resolve(TEMPLATE_RESOURCE_DIR, BaseDirectory::Resource)
        .map_err(|error| {
            log::warn(&format!(
                "the plugin templates could not be located in this build's resources: {error}"
            ));
            IpcError::new(
                PLUGIN_BUILTIN_UNAVAILABLE,
                "The plugin template could not be created, because this build has no readable copy \
                 of it.",
            )
        })?
        .join(template);
    if !source.is_dir() {
        log::warn(&format!(
            "the plugin template {} is missing from this build's resources ({})",
            template,
            source.display()
        ));
        return Err(IpcError::new(
            PLUGIN_BUILTIN_UNAVAILABLE,
            "The plugin template could not be created, because this build has no readable copy of \
             it.",
        ));
    }
    let from = source.clone();
    let to = destination.clone();
    tauri::async_runtime::spawn_blocking(move || copy_tree(&from, &to))
        .await
        .map_err(|_| IpcError::new(PLUGIN_INSTALL_FAILED, "The plugin template was not copied."))?
        .map_err(|error| {
            IpcError::from_message(
                PLUGIN_INSTALL_FAILED,
                format!("The plugin template could not be copied: {error}"),
            )
        })?;
    log::info(&format!(
        "a new plugin was created from the {template} template"
    ));
    Ok(destination.to_string_lossy().into_owned())
}

/// The refusal one chosen target directory earns, from the facts about it.
///
/// Pure, so the rule can be read - and tested - without a filesystem: a path the user picked has to
/// be non-empty, absolute, a directory that exists, and outside this application's own data root.
/// The four refusals are the four ways a destination cannot be one this command writes into.
fn target_refusal(raw: &str, is_directory: bool, inside_data_root: bool) -> Option<&'static str> {
    // The rule trims for itself rather than relying on the caller: what a directory picker hands
    // back is text, and "  " is not a path any more than "" is.
    let raw = raw.trim();
    if raw.is_empty() {
        return Some("The target directory is empty.");
    }
    if !Path::new(raw).is_absolute() {
        return Some("The target directory must be an absolute path.");
    }
    if !is_directory {
        return Some("The target directory does not exist.");
    }
    if inside_data_root {
        return Some("A plugin cannot be created inside the application's own data directory.");
    }
    None
}

/// The refusal a destination that already holds something earns: a template never overwrites a file,
/// so a name that is taken is answered rather than resolved.
fn destination_refusal(exists: bool, empty: bool) -> Option<&'static str> {
    if !exists || empty {
        return None;
    }
    Some("The destination already holds files; nothing was overwritten.")
}

/// Whether one directory holds nothing at all. A directory that cannot be read is not one this
/// command will write into, which the caller's answer is the same as for a directory that is not
/// empty.
fn is_empty_directory(path: &Path) -> bool {
    std::fs::read_dir(path)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false)
}

/// Copies one template tree into `to`, creating the destination and every directory inside it.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = to.join(entry.file_name());
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The template names are the four this build ships, and nothing else is one - a name that is
    /// not in the list never reaches a directory lookup.
    #[test]
    fn only_the_shipped_templates_are_offered() {
        assert_eq!(
            TEMPLATES,
            [
                "panel-basic",
                "agent-tool-basic",
                "skill-pack",
                "renderer-slots-basic"
            ],
            "the names are the bundled resource directory names"
        );
    }

    /// The slot template is a real package: it materialises its two files, and the manifest it ships
    /// is the declaration the host and this layer read - a module, two whitelists and the one
    /// permission that covers them.
    #[test]
    fn the_renderer_template_materialises_a_parseable_package() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(TEMPLATE_RESOURCE_DIR)
            .join("renderer-slots-basic");
        assert!(source.is_dir(), "the template ships with the build");

        let destination = std::env::temp_dir().join(format!(
            "omp-scaffold-renderer-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or_default()
        ));
        let _ = std::fs::remove_dir_all(&destination);
        copy_tree(&source, &destination).expect("the template copies");

        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(destination.join("package.json")).expect("a manifest"),
        )
        .expect("the manifest parses");
        let desktop = &manifest["omp"]["desktop"];
        assert_eq!(desktop["renderer"], "desktop/renderer.mjs");
        assert_eq!(desktop["rendererActions"][0], "composer.insertText");
        assert_eq!(desktop["rendererCallMethods"][0], "listSnippets");
        assert!(
            desktop["permissions"]
                .as_array()
                .is_some_and(|permissions| permissions
                    .iter()
                    .any(|permission| permission == "renderer.extension")),
            "the module's one permission is declared"
        );

        let module = std::fs::read_to_string(destination.join("desktop").join("renderer.mjs"))
            .expect("the module ships");
        assert!(
            module.contains("host.react"),
            "the React it draws with is the host's own: {module}"
        );
        assert!(module.contains("composer.toolbar"), "{module}");
        assert!(module.contains("code.block"), "{module}");
        let _ = std::fs::remove_dir_all(&destination);
    }

    /// The destination rule, read as the four refusals it is: empty, relative, not a directory, and
    /// inside this application's own data root. The absolute path is built from this machine's own
    /// temporary directory, so the case means the same thing on Windows and on Unix.
    #[test]
    fn the_target_directory_has_to_be_an_absolute_directory_of_the_users_own() {
        let absolute = std::env::temp_dir().to_string_lossy().into_owned();
        assert!(target_refusal(&absolute, true, false).is_none());
        assert!(target_refusal("   ", true, false).is_some());
        assert!(target_refusal("", true, false).is_some());
        assert!(target_refusal("relative/plugins", true, false).is_some());
        assert!(target_refusal(&absolute, false, false).is_some());
        assert!(target_refusal(&absolute, true, true).is_some());
    }

    /// Nothing is ever overwritten: a destination that does not exist and one that exists but is
    /// empty are both usable, and anything else is refused.
    #[test]
    fn a_destination_is_only_written_into_when_it_is_absent_or_empty() {
        assert!(destination_refusal(false, false).is_none(), "not there yet");
        assert!(destination_refusal(true, true).is_none(), "empty");
        assert!(
            destination_refusal(true, false).is_some(),
            "already holds files"
        );
    }
}
