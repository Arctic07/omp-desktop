//! The work a session reports while it runs: what a tool call's result carries, the todo phases
//! the engine tracks, and the roster of the subagents it spawned.
//!
//! These are the DTOs behind the agent surface's task-shaped rows - the chip a tool call collapses
//! into, the dock's todo phases, and the subagent strip - rather than the transcript itself, which
//! stays in [`super`] (`ChatMessage` and the history frames). They belong together because they are
//! produced together and read together: the children a `task` call reports and the live roster of
//! those same children are one set of facts seen from two frames, and both carry the engine's own
//! roster vocabulary.

use serde::Serialize;
use serde_json::Value;

/// The structured part of a tool call's result that a chat row draws.
///
/// The engine reports far more than this — whole-file snapshots, per-file metadata, diagnostics,
/// output limits — and none of it belongs on the wire. What travels is the diff a reader looks at,
/// the path a reader opens, the subagents a `task` call ran, and the pages a search read; the
/// projection that fills this in (`services/runtime/mod.rs::tool_details`) bounds every string and
/// caps every list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolDetails {
    /// The file the call acted on, when the engine named one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) path: Option<String>,
    /// The unified diff a single-file edit made.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) diff: Option<String>,
    /// The line the first hunk starts on, for a reader who opens the file next.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) first_changed_line: Option<i64>,
    /// One entry per file a multi-file edit changed, in the engine's order.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) files: Vec<ToolFileChange>,
    /// The subagents one `task` call spawned.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) subagents: Vec<ToolSubagent>,
    /// The `task` tool's own aggregate state for a call it runs in the background: the engine's
    /// word for the call (`running`, `completed`, `failed`), not for one child.
    ///
    /// It is a `task` fact, not a general one: `bash` and `eval` publish an `async` marker of the
    /// same shape when they hand a call to a background job, and neither names a subagent, so the
    /// projection fills this in only from a payload whose marker is typed `task`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) subagent_state: Option<String>,
    /// The pages a search call read, as the citation lines under its row.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) sources: Vec<ToolSource>,
    /// The answer a search provider synthesized for the query, when it wrote one.
    ///
    /// Only the LLM-mediated providers answer with prose (`response.answer`); a pure search engine
    /// returns citations and nothing else. It is the part of a search a reader actually reads, so
    /// it travels with the sources rather than being folded into the raw result text the model
    /// consumes. Bounded by `services/runtime/mod.rs::MAX_SEARCH_ANSWER_CHARS`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) answer: Option<String>,
    /// The minimizer's rewrite of a shell call's output, when it made one.
    ///
    /// The result text a row draws is the minimized capture, so it cannot say that a larger one
    /// exists; this is that fact, and a `bash` call is the only tool the engine reports it for. The
    /// projection (`services/runtime/mod.rs::tool_details`) bounds the label and keeps the counts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) minimized: Option<ToolMinimized>,
}

/// One shell call's minimizer record: the filter that ran and the bytes it took the output from
/// and to.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolMinimized {
    /// The filter's engine label (`git`, `chain`, ...); empty when the engine named none.
    pub(crate) filter: String,
    /// The raw capture's size in bytes.
    pub(crate) input_bytes: i64,
    /// The minimized text's size in bytes.
    pub(crate) output_bytes: i64,
}

/// One page a search call read: what it was called, where it is, and the line the engine quoted
/// from it.
///
/// A source is the one part of a search result a reader acts on - everything else on that row is
/// words the model wrote - so it carries exactly what an anchor needs and nothing else. The
/// projection that fills it in (`services/runtime/mod.rs::tool_sources`) caps the list and drops
/// entries nothing could open.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolSource {
    /// The page's own title; empty when the engine reported none.
    pub(crate) title: String,
    pub(crate) url: String,
    /// The snippet the engine quoted, empty when it quoted none.
    pub(crate) snippet: String,
}

/// One file inside a multi-file edit's details.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolFileChange {
    pub(crate) path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) diff: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) first_changed_line: Option<i64>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub(crate) is_error: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error_text: Option<String>,
}

/// One subagent of a `task` call: what it was, what it was asked, and how it is doing - the last
/// of which a background spawn reports while its children run, so this row is the live roster and
/// not only a report of finished work.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolSubagent {
    /// The agent's own name, when the spawn named one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) name: Option<String>,
    /// The engine's own id for the child - the `agentId` every list of one run keys its entry by,
    /// and the same id the live roster frame carries for it. A child reported without one is a row
    /// nothing could match against its own live row, so the field is the join, not a label.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) id: Option<String>,
    /// The agent type it ran as (e.g. `scout`).
    pub(crate) agent: String,
    /// The one-line description of its work, or its assignment when it gave none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) description: Option<String>,
    /// The child's exit code; `0` is a subagent that finished its work.
    pub(crate) exit_code: i64,
    pub(crate) duration_ms: i64,
    pub(crate) tokens: i64,
    /// True when the engine cut the child's output short.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub(crate) truncated: bool,
    /// How the child is doing, in the engine's own vocabulary of a live roster:
    /// `pending` / `running` / `completed` / `failed` / `aborted`. A row that reported no state -
    /// an engine older than the field, or a detail object that never named one - carries none,
    /// which the frontend draws as a child whose state is not yet known rather than as a finished
    /// one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) status: Option<String>,
    /// Tools the child has called so far. Absent, not `0`, when no roster reported one: a child
    /// that never used a tool and a roster that never counted look the same on the wire otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tool_count: Option<i64>,
    /// The tool the child is inside right now, when it is inside one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) current_tool: Option<String>,
    /// The last thing the child said it was doing, in its own words.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_intent: Option<String>,
    /// The model the child ran on, as `<provider>/<id>`, when the engine resolved one. A child
    /// inherits the parent's model only when nothing names another, so a card that states it is
    /// answering "which model did this work", not repeating the composer's own field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model: Option<String>,
}

/// The model a subagent's record names.
///
/// The engine writes the model two ways on the same record: `resolvedModelIdentity` is
/// `<provider>/<id>` with routing and no thinking suffix, `resolvedModel` is the display form (a
/// `:<level>` suffix when a level was pinned). The identity is what a row states; the display form
/// is the fallback for a record that carried only one of the two, and a record that named neither
/// answers `None` rather than guessing the parent's model.
pub(crate) fn subagent_model(record: &Value) -> Option<String> {
    ["resolvedModelIdentity", "resolvedModel"]
        .iter()
        .find_map(|key| {
            record
                .get(*key)
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .map(str::to_owned)
        })
}

/// Where one todo task stands, as the engine's `todo` tool tracks it.
///
/// The words are the wire contract the frontend declares by name (`src/utils/agentTypes.ts`);
/// `Unknown` is what a status this build has never seen becomes, so a newer engine's state still
/// renders as a task instead of being dropped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TodoStatus {
    Pending,
    InProgress,
    Completed,
    Abandoned,
    Blocked,
    Unknown,
}

impl TodoStatus {
    /// The status a host state carries, `Unknown` for anything this build does not know.
    pub(crate) fn from_wire(value: &str) -> Self {
        match value {
            "pending" => Self::Pending,
            "in_progress" => Self::InProgress,
            "completed" => Self::Completed,
            "abandoned" => Self::Abandoned,
            "blocked" => Self::Blocked,
            _ => Self::Unknown,
        }
    }
}

/// One task within a todo phase.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct TodoItem {
    pub(crate) content: String,
    pub(crate) status: TodoStatus,
    /// What a blocked task waits for. The engine only sets it on `blocked`, so it is absent
    /// everywhere else rather than an empty string the frontend would have to test for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) blocker: Option<String>,
}

/// A named group of todo tasks - the engine's unit of work, and the row the dock shows.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct TodoPhase {
    pub(crate) name: String,
    pub(crate) tasks: Vec<TodoItem>,
}

/// One child of a session's live subagent roster, as the frontend reads it.
///
/// The engine describes one child through more than one frame - a lifecycle frame says it started
/// or how it ended, progress frames say what it is doing - so this is the merge of all of them
/// rather than the payload of any one, and the frontend replaces its whole copy of the row with it.
/// That is why every field is serialized, `null` when the engine has not said: on a row that is
/// replaced wholesale, an absent key would read as "this stopped being true" instead of "this is
/// not known". `status` travels in the engine's own roster vocabulary (`pending` / `running` /
/// `completed` / `failed` / `aborted`), the same one a `task` call's rows carry.
///
/// What a frame mentions but no reader draws stays out: the roster is what the live subagent strip
/// renders, and a field nothing reads is a field the frontend would have to narrow away again.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubagentRow {
    /// The engine's `agentId` for the child: what its later frames are matched against.
    pub(crate) id: String,
    /// The agent type it runs as (e.g. `scout`).
    pub(crate) agent: String,
    /// Its ordinal within the batch it was spawned in.
    pub(crate) index: i64,
    /// The `task` call that spawned it, when the engine named one.
    pub(crate) parent_tool_call_id: Option<String>,
    /// True for a detached spawn: the parent turn keeps working while the child runs.
    pub(crate) detached: bool,
    /// How it is doing, in the engine's words.
    pub(crate) status: String,
    /// The one-line description of its work, when it has one. Either half of a child can carry it -
    /// the spawn names it, and so can the child's own progress report - so it is not a fact of
    /// one channel.
    pub(crate) description: Option<String>,
    /// The assignment it was spawned with.
    pub(crate) assignment: Option<String>,
    /// Tools it has called so far.
    pub(crate) tool_count: Option<i64>,
    /// The tool it is inside right now, when it is inside one.
    pub(crate) current_tool: Option<String>,
    /// That call's arguments, as text.
    pub(crate) current_tool_args: Option<String>,
    /// The last thing it said it was doing, in its own words.
    pub(crate) last_intent: Option<String>,
    /// The model it runs on, as `<provider>/<id>`; see [`subagent_model`]. `null` until a frame
    /// that resolved one arrives.
    pub(crate) model: Option<String>,
    /// Cumulative tokens it has spent.
    pub(crate) tokens: Option<i64>,
    /// How long it has been running: the engine's own measurement, refreshed by every progress
    /// frame while the child works rather than a figure that only appears once it settles. `null`
    /// until a frame reports one.
    pub(crate) duration_ms: Option<i64>,
    /// Host clock (ms) of the first frame this process saw for the child: the engine reports how
    /// long a child has run, not when it started, so this is the only "since when" a row carries
    /// and it is this process's own reading rather than an engine fact.
    pub(crate) started_at: i64,
    /// Its most recent tool calls, newest first.
    pub(crate) recent_tools: Vec<SubagentRecentTool>,
    /// The tail of what it last printed, newest first.
    pub(crate) recent_output: Vec<String>,
}

/// One tool call in a child's recent window.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubagentRecentTool {
    pub(crate) tool: String,
    /// The call's arguments, as the engine reported them.
    pub(crate) args: String,
}
