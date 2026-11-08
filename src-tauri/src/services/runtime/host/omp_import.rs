//! The import calls [`HostRuntime`] serves: one scan and one apply against another omp
//! installation's agent directory.
//!
//! Both are thin for the same reason the capability calls are: the host owns the engine and the
//! files it is asked to read, so what a scan finds and what an apply wrote are its answers. This
//! layer starts the host when needed, sends the frame, and reads the answer into the DTO the
//! command returns. The one exception is `keys`: that field is read here and nowhere else, because
//! the desktop's keyring is the only home a provider secret may have - it never travels to the page.

use serde_json::json;

use crate::errors::IpcResult;
use crate::models::omp_import::{ImportApplyAnswer, ImportScanView};

use super::super::CAPABILITY_TIMEOUT_MS;
use super::HostRuntime;

impl HostRuntime {
    /// What the named agent directory offers, and which of it this engine already holds.
    ///
    /// A host that is not running is started here: the settings page's import button and the
    /// first-run prompt are both explicit user-visible actions, and the scan is what they render.
    pub(crate) async fn omp_import_scan(&self, source_dir: &str) -> IpcResult<ImportScanView> {
        self.ensure_running().await?;
        let data = self
            .call_ok(
                json!({"type": "omp_import_scan", "sourceDir": source_dir}),
                CAPABILITY_TIMEOUT_MS,
            )
            .await?;
        super::capabilities::decode(data, "local configuration scan")
    }

    /// Copies the selected categories, skipping every identity this engine already holds.
    ///
    /// `catalogue_changed` says this layer has just written `models.yml` (the custom providers live
    /// in this application's own registry): the host reloads the catalogue before it resolves any
    /// role, so a role naming a just-added provider is not answered as unresolved. The answer
    /// carries the provider keys the keyring should store; the caller stores them and drops them.
    pub(crate) async fn omp_import_apply(
        &self,
        source_dir: &str,
        models: bool,
        mcp: bool,
        skills: bool,
        catalogue_changed: bool,
    ) -> IpcResult<ImportApplyAnswer> {
        self.ensure_running().await?;
        let data = self
            .call_ok(
                json!({
                    "type": "omp_import_apply",
                    "sourceDir": source_dir,
                    "models": models,
                    "mcp": mcp,
                    "skills": skills,
                    "catalogueChanged": catalogue_changed,
                }),
                CAPABILITY_TIMEOUT_MS,
            )
            .await?;
        super::capabilities::decode(data, "local configuration import")
    }
}
