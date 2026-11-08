//! The preview of one package file: what it declares, read without installing anything.
//!
//! The confirmation card an install from a file is drawn from needs the facts a user is being asked
//! to agree to - which permissions the manifest asks for, which hosts it reaches, how many pages it
//! contributes, whether it ships code, and whether its checksum list checks out - and it needs them
//! *before* anything is registered, promoted or installed. That is this module: it unpacks one
//! archive into a staging directory its caller removes, reads the manifest out of it, and answers.
//!
//! Nothing here decides whether a package may be installed. The guards are the same ones the install
//! path runs ([`super::unpack_tree`], which refuses an escaping entry, a link and an oversized
//! package before this ever reads a manifest), and the two checksum fields are reported rather than
//! enforced: a local package may ship no `checksums.json`, and the honest answer to that is
//! "unverified, none listed" rather than a refusal - the install path is what refuses a list that
//! does not match (`guards::verify_checksums`).
//!
//! What the manifest *means* is not re-derived here either. The `omp.desktop` block is read into the
//! same DTO a plugin row carries, and the two lists it declares are filtered by the same rules the
//! row conversion applies (`validate_permission_name`, `gates::is_host_name`), so the preview of a
//! package says exactly what the plugin's own row would say about the same manifest.

use std::path::Path;

use serde_json::Value;

use super::guards::checksum_facts;
use super::{unpack_tree, PackageResult};
use crate::models::plugins::EngineDesktopBlock;
use crate::services::plugins::gates;
use crate::services::plugins::validate::validate_permission_name;

/// What one package file holds, as the confirmation card before an install reads it.
#[derive(Debug, Clone)]
pub(crate) struct PackageInspection {
    pub(crate) name: String,
    pub(crate) version: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) permissions: Vec<String>,
    pub(crate) net_domains: Vec<String>,
    pub(crate) page_count: usize,
    pub(crate) has_extensions: bool,
    pub(crate) checksum_verified: bool,
    pub(crate) checksum_count: usize,
    pub(crate) sha256: String,
}

/// Reads one package file without installing it.
///
/// `staging` is the caller's staging directory and holds the whole unpacked tree when this answers;
/// removing it is the caller's job, exactly as it is on the install path, because a refusal part-way
/// through leaves the same half-unpacked tree behind.
pub(crate) fn inspect(archive: &Path, staging: &Path) -> PackageResult<PackageInspection> {
    let tree = unpack_tree(archive, staging)?;
    let desktop = desktop_block(&tree.manifest_value);
    let checksums = checksum_facts(&tree.package_dir);
    Ok(PackageInspection {
        name: tree.manifest.name,
        version: tree.manifest.version,
        description: tree.manifest.description,
        permissions: declared_permissions(desktop.as_ref()),
        net_domains: declared_domains(desktop.as_ref()),
        page_count: page_count(desktop.as_ref()),
        has_extensions: extension_count(&tree.manifest_value) > 0,
        checksum_verified: checksums.verified,
        checksum_count: checksums.count,
        sha256: tree.archive_sha256,
    })
}

/// The `omp.desktop` block one manifest declares, when it declares one this build can read.
///
/// Read into the DTO a plugin row carries, so the preview and the row agree about the block's shape,
/// its field names and its defaults. A block this build cannot read is `None`, which the three
/// answers below treat as "declares nothing" - a package whose desktop block is unusable is one whose
/// pages this process will not serve, which is a fact for the card rather than a refusal here.
fn desktop_block(manifest: &Value) -> Option<EngineDesktopBlock> {
    let block = manifest.get("omp")?.get("desktop")?.clone();
    serde_json::from_value(block).ok()
}

/// The permissions the block declares that this build serves, in the manifest's own order.
fn declared_permissions(desktop: Option<&EngineDesktopBlock>) -> Vec<String> {
    let Some(desktop) = desktop else {
        return Vec::new();
    };
    desktop
        .permissions
        .iter()
        .filter(|name| validate_permission_name(name))
        .cloned()
        .collect()
}

/// The hosts the block declares, as the egress gate reads them.
fn declared_domains(desktop: Option<&EngineDesktopBlock>) -> Vec<String> {
    let Some(desktop) = desktop else {
        return Vec::new();
    };
    desktop
        .net_domains
        .iter()
        .filter(|domain| gates::is_host_name(domain))
        .cloned()
        .collect()
}

/// How many pages the block declares, across its four lists.
fn page_count(desktop: Option<&EngineDesktopBlock>) -> usize {
    let Some(desktop) = desktop else {
        return 0;
    };
    desktop.panels.len()
        + desktop.views.len()
        + desktop.settings_destinations.len()
        + desktop.sidebar_tabs.len()
}

/// How many extension modules one manifest declares (`omp.extensions`).
fn extension_count(manifest: &Value) -> usize {
    manifest
        .get("omp")
        .and_then(|omp| omp.get("extensions"))
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0)
}
