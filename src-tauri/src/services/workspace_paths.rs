/**
 * Path completion for the composer's `@` picker.
 *
 * The other half of what a workspace search can answer: which files a reader may name. It shares
 * the traversal with `workspace_search` - the git listing, the bounded walk, and the same
 * admission rules - and differs in what it does with a file: it ranks the path and never opens it,
 * because a mention is a reference to a file and a file whose contents happen to contain the query
 * is not one.
 */
use std::path::Path;

use crate::models::WorkspacePathSearchResult;

use super::workspace::canonical_workspace_root;
use super::workspace_search::{admit_workspace_file, bounded_git_file_list, walk_workspace_files};

/** Path completions: what a file picker draws, so fewer than a search result page. */
const PATH_RESULT_DEFAULT_LIMIT: usize = 50;
const PATH_RESULT_MAX_LIMIT: usize = 200;
/** Matching paths held before ranking; beyond this the answer is reported truncated. */
const PATH_MATCH_POOL_LIMIT: usize = 600;

/** How one path matched the query, lowest first: the picker's own ordering. */
const PATH_RANK_LEAF_EXACT: u8 = 0;
const PATH_RANK_LEAF_PREFIX: u8 = 1;
const PATH_RANK_LEAF_SUBSTRING: u8 = 2;
const PATH_RANK_PATH_SUBSTRING: u8 = 3;
/// Matching paths held for one query, before the ranking sorts them.
struct WorkspacePathState {
    /// The query in its comparison form: lower case, trimmed.
    query: String,
    /// `(rank, path)` pairs, in the order they were found.
    matches: Vec<(u8, String)>,
    /// True once more paths matched than the pool may hold.
    truncated: bool,
}

impl WorkspacePathState {
    fn new(query: String) -> Self {
        Self {
            query,
            matches: Vec::new(),
            truncated: false,
        }
    }

    fn at_limit(&self) -> bool {
        self.matches.len() >= PATH_MATCH_POOL_LIMIT
    }

    /// Files one admitted path; the caller holds the pool to its ceiling.
    fn push(&mut self, relative_path: &str) {
        let Some(rank) = path_rank(relative_path, &self.query) else {
            return;
        };
        self.matches.push((rank, relative_path.to_owned()));
    }

    /// The answer: the best-ranked paths, in rank order and then by path.
    fn into_result(mut self, max_results: usize) -> WorkspacePathSearchResult {
        self.matches
            .sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
        let overflowed = self.matches.len() > max_results;
        self.matches.truncate(max_results);
        WorkspacePathSearchResult {
            paths: self.matches.into_iter().map(|(_, path)| path).collect(),
            truncated: self.truncated || overflowed,
        }
    }
}

/// How one path matches the query, or `None` when it does not.
///
/// The leaf name decides first: a file is picked by what it is called far more often than by the
/// directory it sits in, so `store.ts` outranks `src/store/reader.ts` for `store`. An empty query
/// matches everything at the same rank, so the command answers with the workspace's files in path
/// order; the picker's own bare `@` is a directory listing (`list_workspace_entries`) and does not
/// come through here.
fn path_rank(relative_path: &str, lowered_query: &str) -> Option<u8> {
    if lowered_query.is_empty() {
        return Some(PATH_RANK_LEAF_EXACT);
    }
    let lowered = relative_path.to_lowercase();
    let leaf = match lowered.rfind('/') {
        Some(index) => &lowered[index + 1..],
        None => lowered.as_str(),
    };
    if leaf == lowered_query {
        return Some(PATH_RANK_LEAF_EXACT);
    }
    if leaf.starts_with(lowered_query) {
        return Some(PATH_RANK_LEAF_PREFIX);
    }
    if leaf.contains(lowered_query) {
        return Some(PATH_RANK_LEAF_SUBSTRING);
    }
    if lowered.contains(lowered_query) {
        return Some(PATH_RANK_PATH_SUBSTRING);
    }
    None
}

/// Files one candidate path; `false` tells the caller to stop scanning.
///
/// The pool is the ceiling rather than the answer's length: a path that matched at all can still
/// outrank one already held, so the scan stops only once nothing later could displace anything.
fn push_path_candidate(root: &Path, raw_path: &str, state: &mut WorkspacePathState) -> bool {
    if state.at_limit() {
        state.truncated = true;
        return false;
    }
    if let Some((_canonical, relative_path, _size)) = admit_workspace_file(root, raw_path) {
        state.push(&relative_path);
    }
    true
}

fn search_workspace_paths_blocking(
    root: String,
    query: String,
    max_results: Option<usize>,
) -> Result<WorkspacePathSearchResult, String> {
    let canonical_root = canonical_workspace_root(&root)?;
    let max_results = max_results
        .unwrap_or(PATH_RESULT_DEFAULT_LIMIT)
        .min(PATH_RESULT_MAX_LIMIT);
    if max_results == 0 {
        return Ok(WorkspacePathSearchResult {
            paths: Vec::new(),
            truncated: true,
        });
    }

    let mut state = WorkspacePathState::new(query.trim().to_lowercase());
    if let Some((data, output_truncated)) = bounded_git_file_list(&canonical_root) {
        let complete_end = data
            .iter()
            .rposition(|byte| *byte == 0)
            .map(|index| index + 1)
            .unwrap_or(0);
        for raw_path in data[..complete_end].split(|byte| *byte == 0) {
            let Ok(raw_path) = std::str::from_utf8(raw_path) else {
                continue;
            };
            if raw_path.is_empty() {
                continue;
            }
            if !push_path_candidate(&canonical_root, raw_path, &mut state) {
                break;
            }
        }
        if output_truncated {
            state.truncated = true;
        }
    } else {
        let walk_truncated = walk_workspace_files(&canonical_root, &mut |relative_path| {
            push_path_candidate(&canonical_root, relative_path, &mut state)
        });
        if walk_truncated {
            state.truncated = true;
        }
    }

    Ok(state.into_result(max_results))
}

/// Path completion for the composer's `@` picker.
///
/// A pure path search: it names workspace files and never reads their contents, which is what
/// separates it from `search_workspace_files` - a mention of a file is a reference to that file,
/// and a file whose *contents* happen to contain the query is not a mention candidate at all.
pub(crate) async fn search_workspace_paths(
    root: String,
    query: String,
    max_results: Option<usize>,
) -> Result<WorkspacePathSearchResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        search_workspace_paths_blocking(root, query, max_results)
    })
    .await
    .map_err(|_| "Workspace path search task failed".to_owned())?
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use super::{
        path_rank, search_workspace_paths_blocking, PATH_RANK_LEAF_EXACT, PATH_RANK_LEAF_PREFIX,
        PATH_RANK_LEAF_SUBSTRING, PATH_RANK_PATH_SUBSTRING,
    };

    fn scratch(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("omp-wssearch-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("workspace scratch");
        root
    }

    fn write(root: &Path, relative: &str, content: &str) {
        let file = root.join(relative);
        fs::create_dir_all(file.parent().expect("target directory")).expect("workspace directory");
        fs::write(&file, content).expect("workspace file");
    }

    fn paths(root: &Path, query: &str, max_results: usize) -> Vec<String> {
        search_workspace_paths_blocking(
            root.to_string_lossy().into_owned(),
            query.to_owned(),
            Some(max_results),
        )
        .expect("path search")
        .paths
    }

    /// The picker orders by what a file is called: an exact leaf name first, then a leaf prefix,
    /// then a leaf substring, and a path-only match last.
    #[test]
    fn the_leaf_name_decides_the_order() {
        let root = scratch("rank");
        write(&root, "src/store.ts", "");
        write(&root, "src/store/reader.ts", "");
        write(&root, "src/instore.ts", "");
        write(&root, "apps/storefront/index.ts", "");

        let found = paths(&root, "store", 20);
        assert_eq!(
            found,
            vec![
                // `store` prefixes the leaf.
                "src/store.ts".to_owned(),
                // `store` sits inside the leaf.
                "src/instore.ts".to_owned(),
                // Only the path matches.
                "apps/storefront/index.ts".to_owned(),
                "src/store/reader.ts".to_owned(),
            ],
            "leaf matches come before path matches, and each rank is sorted by path"
        );
    }

    /// The rank table itself, so a change to the ordering is a change to this test rather than a
    /// silent reshuffle of what the picker offers first.
    #[test]
    fn each_shape_of_match_has_its_own_rank() {
        assert_eq!(
            path_rank("docs/readme.md", "readme.md"),
            Some(PATH_RANK_LEAF_EXACT)
        );
        assert_eq!(
            path_rank("docs/readme.md", "read"),
            Some(PATH_RANK_LEAF_PREFIX)
        );
        assert_eq!(
            path_rank("docs/readme.md", "adme"),
            Some(PATH_RANK_LEAF_SUBSTRING)
        );
        assert_eq!(
            path_rank("docs/readme.md", "docs"),
            Some(PATH_RANK_PATH_SUBSTRING)
        );
        assert_eq!(path_rank("docs/readme.md", "nothing"), None);
        assert_eq!(
            path_rank("Docs/ReadMe.md", "readme.md"),
            Some(PATH_RANK_LEAF_EXACT)
        );
    }

    /// The regression this covers: the picker used to run the *content* search, so a file whose
    /// text merely mentioned the query appeared as a mention candidate. A mention names a file, so
    /// only the path may match.
    #[test]
    fn a_file_that_only_mentions_the_query_is_not_a_candidate() {
        let root = scratch("content");
        write(&root, "src/alpha.ts", "// store of values\n");
        write(&root, "src/store.ts", "");

        let found = paths(&root, "store", 20);
        assert_eq!(found, vec!["src/store.ts".to_owned()]);
    }

    /// A bare `@` lists the workspace instead of an empty answer: the picker's first offer is the
    /// files themselves, in path order.
    #[test]
    fn an_empty_query_lists_workspace_files() {
        let root = scratch("bare");
        write(&root, "b.txt", "");
        write(&root, "a.txt", "");
        write(&root, "nested/c.txt", "");

        assert_eq!(
            paths(&root, "  ", 20),
            vec!["a.txt", "b.txt", "nested/c.txt"]
        );
    }

    /// Ignored directories are not part of the workspace for either search, so a dependency's own
    /// file is never offered as a mention.
    #[test]
    fn ignored_directories_are_skipped() {
        let root = scratch("ignored");
        write(&root, "src/keep.ts", "");
        write(&root, "node_modules/pkg/index.ts", "");

        assert_eq!(paths(&root, "", 20), vec!["src/keep.ts"]);
    }

    /// The answer is bounded by the caller's ceiling and says so, rather than silently dropping
    /// the files it could not carry.
    #[test]
    fn a_capped_answer_reports_itself_truncated() {
        let root = scratch("cap");
        write(&root, "a1.ts", "");
        write(&root, "a2.ts", "");
        write(&root, "a3.ts", "");

        let capped = search_workspace_paths_blocking(
            root.to_string_lossy().into_owned(),
            "a".to_owned(),
            Some(2),
        )
        .expect("path search");
        assert_eq!(capped.paths.len(), 2);
        assert!(capped.truncated, "a capped answer must say so");
    }
}
