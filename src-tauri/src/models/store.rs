/// One live row of the `projects` table (workspace registry).
#[derive(Debug, Clone)]
pub(crate) struct ProjectRow {
    pub(crate) id: i64,
    /// The canonical workspace identity. Rows are keyed by it, but nothing above the
    /// store reads it back yet, so it is kept for the row's shape rather than display.
    #[allow(dead_code)]
    pub(crate) root_key: String,
    pub(crate) root_path: String,
    pub(crate) name: String,
    pub(crate) pinned: bool,
    pub(crate) last_opened_at: i64,
}

/// One row of `custom_providers`. `models_json` holds the serialized model definitions; the
/// service layer parses them so the store stays a plain table.
#[derive(Debug, Clone)]
pub(crate) struct CustomProviderRow {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) base_url: String,
    pub(crate) api: String,
    pub(crate) models_json: String,
}
