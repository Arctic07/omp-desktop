/**
 * Frozen constants (contract `.tmp-plan/contracts/c1-sdk-host-contract.md` §4).
 *
 * Every value here is contract-pinned: changing one is a protocol change, not a tuning knob.
 */

/**
 * Handshake protocol version advertised by `hello` and confirmed by `hello_ok`.
 *
 * 2 was the vocabulary that includes the engine-state commands: the model-role reads and writes
 * (`model_roles` / `model_role_candidates` / `model_role_set`) and the capability commands
 * (`skills_list`, `skills_set`, `mcp_list`, `mcp_set_enabled`, `memory_status`, `memory_action`,
 * `usage_summary`). A host built before them answers `hello` with 1, and without a version change
 * it would accept the handshake and then absorb every one of those commands in `dispatch.ts`'s
 * unknown-frame branch - the desktop's calls would time out with nothing stating why. The desktop
 * refuses to spawn an artifact whose manifest records another version (`host_bin.rs`), so an
 * artifact older than this build is reported instead of half-worked.
 *
 * 3 adds the MCP definition writes (`mcp_upsert`, `mcp_remove`), so the settings page can define
 * servers rather than only toggle the ones other tools defined.
 *
 * 4 adds the memory-catalog read (`memory_catalog`), and 5 the conversation delete
 * (`session_delete`), the one command that removes a transcript instead of only ending a screen's
 * use of it.
 *
 * 6 adds the approval-mode read and write (`approval_mode` / `approval_mode_set`), so the desktop
 * can report and change the mode the engine judges tool calls by instead of only observing it.
 * (The settings card that made that a choice was removed on 2026-10-07 - this application runs the
 * mode it settles on, `yolo`, and converges the engine onto it at every warm - so the pair is now
 * that convergence's own read and write rather than a page's. The command table is unchanged by
 * that removal, which is why no later version records it.)
 *
 * 7 adds the forwarded child-session event (`subagent_event`): a `task` child's own events, which
 * the desktop draws the child's live turn from. A frame vocabulary change travels the same way a
 * command change does - an artifact from before it would drop those frames as unknown, and a
 * desktop that never received one would show a running child as a blank screen.
 *
 * 8 adds conversation branching (`session_branch_points` / `session_branch`): the messages a
 * conversation can branch from, and the branch itself, which the engine performs by rewriting the
 * open session onto a new file with the old one as its parent. Both are session-level commands, so
 * an artifact from before them would absorb the calls in the unknown-frame branch and the desktop
 * would wait on an answer nothing was going to send.
 *
 * 9 was an intermediate shape of the same feature (`session_navigate`, a leaf move inside the
 * conversation being read); 10 replaces it with `session_branch_from`, which starts a conversation
 * of its own continuing from that entry and leaves the one being read whole. The command table
 * changed, so the version does too: an artifact built for 9 would answer 9's semantics to a caller
 * asking for 10's, which is exactly what a version is for.
 *
 * 11 adds the automatic-compaction switch (`compaction_status` / `compaction_set_enabled`), so the
 * settings page can report and change whether the engine compacts a filling context by itself.
 *
 * 12 adds `commit_message`: the review panel asks the engine's own commit pipeline for a conventional
 * message drafted from the staged tree. A model call, so it is answered off the read loop like the
 * catalogue read is.
 *
 * 13 adds the plugin-management commands (`plugins_*`, `marketplaces_*`): the installed set and its
 * per-plugin settings, the install/uninstall/enable/upgrade writes, and the marketplace registry's
 * own list/add/remove/update. An artifact from before them would absorb every one of those frames in
 * the unknown-frame branch, so the desktop's plugin page would wait on answers nothing was going to
 * send; the writes are the sharp end of that, because a version that never saw them cannot even
 * report that it refused one.
 *
 * 14 adds the plugin engine diagnostic (`plugins_engine`): the engine version, the protocol and the
 * external toolchain an install needs (`bun`/`git`/`npm`, probed in the host process). A page that
 * asks an older artifact for it would otherwise wait on an answer nothing was going to send, and
 * the plugin page needs those facts to tell "this plugin is broken" from "this machine cannot
 * install plugins at all".
 *
 * 15 reshapes the desktop page lists: `omp.desktop.panels` / `views` / `settingsDestinations` /
 * `sidebarTabs` are objects (id, localised title, entry, order, panel size) rather than bare id
 * strings, and `engines.ompDesktop` is evaluated instead of only reported. The command table is
 * unchanged, but the payload is not: an artifact from before this version would fail to read the
 * rows at all, which is exactly the pairing this number exists to keep honest.
 *
 * 16 adds the two provider-credential commands (`provider_key_set` / `provider_key_clear`, spec
 * §13.3): the desktop's own keyring-backed key pushed into the *running* engine as an in-memory
 * runtime override, and its removal. Both are new commands, so an artifact from before them would
 * absorb them in the unknown-frame branch and the key the desktop holds would never reach the
 * engine it was set for - the same silence every command addition above was versioned for.
 *
 * 17 adds the global-rules pair (`rules_read` / `rules_write`): the engine's *user-scope* sticky
 * rules file (`<agentDir>/RULES.md`), read whole for the settings page and replaced whole from it.
 * Both are new commands, and the write is a file write this host performs itself rather than an
 * engine call - the engine has no API for that path - so an artifact from before them would absorb
 * both frames in the unknown-frame branch and the page would sit on a call nothing was ever going
 * to answer. Same silence, same version.
 *
 * The plugin reload's failure count (`plugins_reload`'s `failed`) did **not** earn a version of its
 * own, and this is the reason to keep written down: it is an incremental optional field - the
 * desktop's DTO carries `#[serde(default)]`, so an answer without it parses, and a caller that does
 * not read it loses only the new fact. A version exists to refuse an artifact whose *shape* would be
 * misread, and nothing here changes a shape: bumping would refuse artifacts that are in fact
 * compatible. Version the protocol when a payload's existing fields change meaning or type, not
 * when one more optional field is added.
 *
 * 20 adds the forced stop (`session_force_stop`): the step left when `session_abort` reports that
 * the turn ignored its abort window. The host tears one conversation's record down - the engine's
 * own dispose, which is what reaches the session's background work - and answers with the file the
 * caller reopens. One new command, so an artifact from before it would absorb the frame as unknown
 * and leave a user who pressed "force stop" with a button that did nothing. Same silence as
 * 13/16/17, same version.
 *
 * 21 adds the marketplace catalogue read (`marketplace_plugins`): the entries a registered
 * marketplace offers, which is what the plugin store lists in its public and personal segments. One
 * new command, so an artifact from before it would absorb the frame as an unknown one and the store
 * would open empty - the same silence as 13/16/17/20, same version.
 *
 * 22 adds the host-request pair (`terminal_request` → `session_terminal_response`): the
 * agent's `workspace_terminal` tool asks the application what the terminals the user has open in a
 * workspace have printed, and types into one. Both directions are command-table entries, so an
 * artifact from before them would absorb the request as an unknown frame and leave the tool waiting
 * on an answer nothing was ever going to send. Same silence as 13/16/17/20/21, same version.
 *
 * 23 extends the `workspace_terminal` request action set with `create`, which starts a background
 * terminal through the desktop's existing PTY service. An older host would reject the action, so the
 * request contract requires a new protocol version.
 *
 * 25 adds `session_rewind` (a user message taken back: the same engine rewrite `session_branch`
 * performs, addressed by entry id or by the message's own timestamp). An older host would absorb it
 * as an unknown command and the rewind would hang on an answer nothing sends - same class as 13.
 *
 * 27 changes what `session_rewind` means and answers: the rewrite is in place (the session keeps
 * its id and file; only its active branch shortens) instead of branching onto a new file. The
 * answer's `sessionId` is now the same one the caller sent, and `sessionFile` / `previousSessionId`
 * are gone with the move. An older desktop would read the unchanged `sessionId` as a branch onto
 * the same file and refuse it (`follow_branch`'s own guard), so the pair is versioned.
 *
 * 28 adds the engine reclaim (`engine_reclaim`): the caches the engine leaves in its own tree - the
 * native addon directories of engine versions that are no longer running. The desktop cannot delete
 * them itself (§5.3: that tree is read-only to everything outside this process), so without the
 * command the settings page's clear can only ever report a fraction of what the user asked it to
 * free. An older host absorbs the frame as unknown and the desktop reports the engine's share as
 * zero.
 *
 * 29 changes what a stop answers. `session_abort` withdraws the reader's queued steer/follow-up
 * messages before aborting and returns them (`restored`), and a turn that outlasts the stop window
 * is no longer a failed call: the answer names it in `remaining` instead of throwing the retired
 * `abort_timeout`. An older desktop would read `aborted:true` as a landed stop and drop the input it
 * never learned about, while an older host throws the code for the same situation - so the pair is
 * versioned rather than left to field tolerance.
 *
 * 30 adds the P1 capability frames (`plugins_session_list` / `plugins_session_get` /
 * `plugins_session_messages` / `plugins_usage_turns` / `plugins_agent_complete` / `plugins_ws_*`),
 * which is how a plugin's `session.read`, `usage.read`, `agent.complete` and `net.websocket` calls
 * reach the data this application already holds. An artifact from before them absorbs each frame in
 * the unknown-frame branch and the calling plugin's bridge call sits until its own budget expires -
 * the same silence as 13/16/17, same version.
 *
 * 32 removed the browser frame vocabulary and its tools. 33 brings the browser back as a
 * session-scoped pair `browser_request` → `session_browser_response`,
 * with the `Browser` and `BrowserPreview` tools. An artifact from 32 would absorb the request frame
 * as unknown and leave the tool waiting until its own budget, so the pair is versioned like every
 * addition before it.
 *
 * 34 adds the local-configuration import (`omp_import_scan` / `omp_import_apply`): another omp
 * installation's roles, provider keys, custom providers, MCP servers and skills, read from its agent
 * directory and copied additively. Both are new commands, so an artifact from before them would
 * absorb the frames as unknown and the dialog would wait on an answer nothing was going to send -
 * the same silence as 13/16/17, same version.
 *
 * 35 adds the MCP source import (`mcp_import_scan` / `mcp_import_apply`): the MCP servers Claude
 * Code, Codex, omp and the legacy pi layout define in the user's real profile. New commands again,
 * and the same silence for an artifact that predates them.
 *
 * 36 adds `compaction_set_options`: the two idle switches under the compaction card
 * (`compaction.idleEnabled`, `recap.enabled`), which `compaction_status` now also reports. A new
 * command, so a host built before it would absorb the frame as unknown while the settings page
 * waited on an answer - the same class as 35.
 *
 * 37 adds `provider_keys_set`: a provider's rotation pool, handed to the running host as in-memory
 * credentials. An artifact from before it would absorb the new frame as unknown and keep serving
 * the one key it was started with. `provider_key_clear` no longer takes an environment name; the
 * host decides the variable from the spawn allow-list.
 *
 * 38 widens `session_delete` to take the routing id `session.read` publishes as well as the
 * transcript path this desktop's own delete names: that id address is the frame behind a plugin's
 * `session.delete`, and a plugin's `session.rename` needs no version of its own (`session_set_name`
 * already carries the id and the name). No command is added, and an artifact from before 38 would
 * still answer - but with the wrong refusal: it resolves `sessionFile` and finds none, so a delete a
 * plugin asked for comes back as an unreadable request rather than as a delete.
 */
export const PROTOCOL_VERSION = 38

/**
 * The plugin worker's own protocol version (plan §6.2/§8.1), shared with the Rust supervisor.
 *
 * This is deliberately *not* {@link PROTOCOL_VERSION}: a plugin worker speaks the `worker_*` frame
 * set on its own stdin/stdout, and the two halves refuse to start when their numbers disagree
 * (`plugin.process.protocol_mismatch`). Changing one is a protocol change on both sides.
 */
export const PLUGIN_WORKER_PROTOCOL = 1

/** Physical stdout line ceiling; a longer logical frame is split into `rpc_chunk` frames. */
export const MAX_FRAME_BYTES = 1_048_576

/** Reassembly ceiling for a chunked logical frame. */
export const MAX_REASSEMBLED_BYTES = 67_108_864

/** Longest `chunkId` the decoder accepts, matching the reference client's cap. */
export const MAX_CHUNK_ID_BYTES = 128

/** Payload bytes carried by one outbound `rpc_chunk` line (keeps the encoded line well under 1 MiB). */
export const CHUNK_PAYLOAD_BYTES = 512 * 1024

/** Per-session outbound queue caps; overflow sheds increments before terminal frames. */
export const SESSION_EVENT_QUEUE_FRAMES = 2_048
export const SESSION_EVENT_QUEUE_BYTES = 8 * 1024 * 1024

/**
 * Ceiling on what the transport itself holds: the lines waiting behind the sink, plus the batch it
 * is writing right now.
 *
 * Owner: `outbound.ts`'s single writer, which is the process's one stdout writer; bound: this many
 * UTF-8 bytes of encoded lines; release: the pump empties the queue as the sink takes it, and the
 * process ending frees whatever is left. Over it `FrameWriter.congested` is true, which is the
 * signal each session reads before it publishes (`SessionEvents.#flush`) - a consumer that stopped
 * reading makes every session shed its own increments instead of letting this queue grow, so the one
 * long-lived container on the transport side is bounded by this number rather than by how fast the
 * desktop reads.
 */
export const OUTBOUND_QUEUE_BYTES = 4 * 1024 * 1024

/**
 * Per-session replay journal: depth, and the byte budget behind that depth.
 *
 * The depth alone is not a memory bound, because an engine increment is not a fixed size.
 * `message_update` carries the assistant message accumulated so far, so one long turn can fill the
 * whole depth with snapshots of the same growing block - each one a superset of the last - and the
 * per-session figure then reaches tens of megabytes across the live sessions. The budget is
 * therefore what bounds the journal, and over it the oldest entries go first: the journal is a
 * window over the stream, and a reader whose replay starts before that window is answered
 * `truncated` (`SessionEvents.replay`) and rebuilds from `session_state` + `session_history_page` -
 * which is exactly the handling that already exists for the frame count.
 */
export const EVENT_JOURNAL_FRAMES = 2_048
export const EVENT_JOURNAL_BYTES = 4 * 1024 * 1024

/** History paging: default page and the frontend's jump page. */
export const PAGE_MESSAGES = 50
export const JUMP_PAGE_MESSAGES = 200

/** Live sessions kept warm before the LRU sheds the coldest idle one. */
export const MAX_LIVE_SESSIONS = 8

/**
 * Branch points one `session_branch_points` answer carries.
 *
 * A picker is for branching near the end of a conversation, and the answer is a single frame: the
 * newest 200 user messages are offered, and `truncated` says the list was cut at its oldest end
 * rather than leaving a reader to believe a long conversation had only these.
 */
export const MAX_BRANCH_POINTS = 200

/** Idle session eviction threshold. */
export const IDLE_EVICT_MS = 900_000

/**
 * Subagent ids one session tracks as live, for its stop control.
 *
 * A leak guard rather than a roster limit: the ids are only ever used to cancel a running child,
 * and the oldest is dropped first, so a session that has spawned far more children than this keeps
 * the newest ones - the ones a stop is still meaningful for.
 */
export const MAX_TRACKED_SUBAGENTS = 256

/** Concurrency ceilings reported to the engine. */
export const MAX_CONCURRENT_TURNS = 4
export const MAX_PARALLEL_TOOL_CALLS = 10

/** Host-side UI request timeout, used only when the engine request carries no explicit timeout. */
export const UI_REQUEST_TIMEOUT_MS = 300_000

/** Test knob: overrides {@link UI_REQUEST_TIMEOUT_MS} for engine requests without an explicit timeout. */
export const UI_REQUEST_TIMEOUT_ENV = 'OMP_DESKTOP_UI_REQUEST_TIMEOUT_MS'

/**
 * How long one commit draft may run before this process stops it and answers.
 *
 * The engine's pipeline runs several model operations over one staged diff (map batches, analysis,
 * summary, re-validations), and its own per-attempt ceiling is 120 s with up to three attempts per
 * operation - so a stalled provider can hold one draft for many minutes. The desktop used to give
 * up first: its call budget was 120 s, the pending request was dropped, and the engine's answer
 * arrived with no one to hand it to (2026-10-29, `a response frame did not match any pending
 * request id`). Two full attempts is the ceiling a reader is held to: past it the draft is not
 * coming back, and the abort stops the pipeline instead of letting it burn the rest of the
 * retries. The desktop's own `COMMIT_MESSAGE_TIMEOUT_MS` stays above this, so this process always
 * answers first and the reader learns why the draft stopped.
 */
export const COMMIT_DRAFT_BUDGET_MS = 240_000

/** Test knob: overrides {@link COMMIT_DRAFT_BUDGET_MS}, the same way the UI request timeout has one. */
export const COMMIT_DRAFT_BUDGET_ENV = 'OMP_DESKTOP_COMMIT_DRAFT_BUDGET_MS'

/**
 * Test knob: what the plugin toolchain probe reports, as comma-separated `<tool>=<value>` pairs
 * (`bun=0,git=0`).
 *
 * The smoke uses it to drive the "this machine cannot install plugins" branch on a machine where
 * `bun`/`git`/`npm` really are installed - the alternative would be mutating the system `PATH`,
 * which tests the harness rather than the host. Only `0` (and `false`) is honoured: the knob can
 * deny a tool, never claim one that is absent, so setting it can only make the host more
 * conservative, and the preflight it controls only ever refuses work.
 */
export const PLUGIN_TOOLCHAIN_ENV = 'OMP_DESKTOP_SMOKE_TOOLCHAIN'

/** Grace given to sessions before the process exits. */
export const SHUTDOWN_GRACE_MS = 10_000

/**
 * How long a stop waits for the turn it aborted to reach its end.
 *
 * The reader is waiting on this answer, so the window is a promise to them rather than to the
 * engine: the engine's own abort resolves when the turn settles, and the engine's ACP host races it
 * against five seconds for exactly this reason (`modes/acp/acp-agent.ts`,
 * `ACP_CANCEL_CLEANUP_TIMEOUT_MS`). Past it the stop still answers - what it could end is ended,
 * and `remaining` names the turn that would not let go so the screen can offer the forced stop.
 * Together with {@link STOP_CHILD_CANCEL_GRACE_MS} this keeps every stop well inside the desktop's
 * own fifteen-second call budget (`services/runtime/mod.rs::CONNECT_TIMEOUT_MS`), so a press can
 * never come back as a timeout after the work was already stopped.
 */
export const STOP_ABORT_GRACE_MS = 5_000

/**
 * How long a stop waits for the children it cancelled to unwind.
 *
 * A child's own `abort()` waits for its turn to end, exactly like the parent's, and a child blocked
 * in a tool can take as long as the turn that started it. The stop must not become that wait: the
 * children are named in `remaining` when they outlast it, and the forced stop - which tears the
 * session down - is the step after that.
 */
export const STOP_CHILD_CANCEL_GRACE_MS = 3_000

/**
 * The reason the engine threads through its own `AbortController` for a deliberate user interrupt
 * (`@oh-my-pi/pi-tui/src/chat/messages.ts::USER_INTERRUPT_LABEL`).
 *
 * The engine compares this exact string, it does not merely log it: `AgentSession.abort()` marks the
 * aborted message as a user interrupt, suppresses advisor auto-resume and restores queued input
 * instead of running it, and its renderers suppress the redundant abort line. A stop pressed on this
 * desktop is that same act, so it sends this reason rather than a host-invented sentence - a custom
 * reason made the engine treat the reader's stop as an internal lifecycle abort, which is why a
 * steered message could start a fresh turn right after it.
 *
 * Carried here rather than imported because no engine entry point exports the constant: the engine's
 * own `sdk.ts` and `session/messages.ts` both use it without re-exporting it. `session-stop.test.ts`
 * pins this value against the installed engine's source, so an upstream rename fails the host tests
 * instead of silently changing what a stop means.
 */
export const USER_INTERRUPT_LABEL = 'Interrupted by user'

/**
 * How long `/vibe`'s exit waits for the director's running turn to settle.
 *
 * The exit is the mode's only way out, and it has to end the turn before it swaps the toolset back:
 * the engine's `abort()` resolves when the turn reaches its end, and a turn blocked in a tool or in
 * a provider that never answers can keep that promise pending indefinitely. Past this window the
 * exit tears the workers down and restores the toolset anyway, so the conversation cannot be left
 * holding a read-only toolset by a turn that will not settle.
 */
export const VIBE_EXIT_ABORT_GRACE_MS = 5_000

/**
 * Window a forced stop gives the ordinary one before it tears the record down.
 *
 * Shorter than {@link SHUTDOWN_GRACE_MS} on purpose: the caller pressing "force stop" has already
 * waited out the ordinary window once, and what it asks for is the step after that.
 */
export const FORCE_STOP_GRACE_MS = 2_000

/**
 * How long a session may produce no engine event before the host says so in its own log.
 *
 * The threshold a user-facing reading is measured against is this one, published per session as
 * `lastEventAt` on the state frame; the sweep below is only the host's own account of the same
 * fact, for a support case read after the fact. It is deliberately generous: a long tool, a long
 * think and a hung turn are indistinguishable from outside, so the host reports silence rather
 * than judging it.
 */
export const TURN_SILENCE_MS = 120_000

/** How often the host looks for sessions that have gone silent. */
export const SILENCE_SWEEP_MS = 15_000

/**
 * Largest prompt the host accepts inline.
 *
 * The engine's prompt API takes the text itself, so this host has no disk-spill form to hand it:
 * above this size the command is refused with `invalid_input` rather than truncated, which is a
 * known deviation from the migration plan's "write it out and pass a path reference". The bound
 * is generous on purpose - a prompt this large arrives as a chunk run, and the only hard ceiling
 * above it is `MAX_REASSEMBLED_BYTES`, which 8 MiB leaves room for with the framing overhead.
 */
export const MAX_PROMPT_BYTES = 8 * 1024 * 1024

/** Absolute session directory inside the data root. */
export const SESSION_DIR_SEGMENT = ['host', 'sessions'] as const

/** Longest working directory a capability command accepts, in characters. */
export const CAPABILITY_CWD_MAX = 4_096

/** Rows one capability list may carry; beyond this the payload says it was cut. */
export const CAPABILITY_ROWS_MAX = 500

/** Longest server or skill name a capability write accepts, in characters. */
export const CAPABILITY_NAME_MAX = 128

/** Longest free-text field (a skill description, a transport target) one row carries. */
export const CAPABILITY_TEXT_MAX = 2_048

/**
 * Bounds on one provider credential write (`provider_key_set`, spec §13.3).
 *
 * The provider id is a lookup key, not free text, so it is capped at the same length as a server
 * name; the key is capped generously - long enough for any bearer a provider issues - because the
 * bound exists to keep a hostile caller from building an oversized frame, not to judge the key.
 */
export const PROVIDER_ID_MAX = 128
export const PROVIDER_KEY_CHARS_MAX = 4_096

/**
 * Ceiling on the user-scope rules file (`<agentDir>/RULES.md`), in UTF-8 bytes.
 *
 * The engine carries that file's whole body on every request, so its size is a cost paid on every
 * turn rather than once; the settings page edits text a person writes by hand, and 256 KiB is far
 * past any body a person writes. Over the ceiling both frames refuse (never truncate): half a rule
 * set still reads like a rule set, and the page would save that shortened version back over the
 * original.
 */
export const RULES_CONTENT_MAX_BYTES = 256 * 1024

/** Warnings and discovery errors one payload carries. */
export const CAPABILITY_WARNINGS_MAX = 100
export const CAPABILITY_ERRORS_MAX = 100

/** The seven per-source skill toggles, without their `skills.` settings prefix. */
export const SKILL_SOURCE_IDS = [
  'enableCodexUser',
  'enableClaudeUser',
  'enableClaudeProject',
  'enablePiUser',
  'enablePiProject',
  'enableAgentsUser',
  'enableAgentsProject',
] as const

/** How long one `MemoryBackend.status()` call may take before it is reported as timed out. */
export const MEMORY_STATUS_TIMEOUT_MS = 5_000

/** Characters of engine-rendered memory instructions one payload carries. */
/** How many workspaces one `memory_catalog` read may name. */
export const MEMORY_CATALOG_WORKSPACES_MAX = 64

export const MEMORY_PREVIEW_MAX = 8_192

/** Memory artifacts one payload lists, and the strings one status field may carry. */
export const MEMORY_ARTIFACT_ROWS_MAX = 16
export const MEMORY_STATUS_TEXT_MAX = 1_024

/** Recall banks one status row carries: a backend that tracks many is still bounded here. */
export const MEMORY_STATUS_BANKS_MAX = 16

/**
 * Ceilings for an MCP definition a form submits.
 *
 * A definition is a small record - one command, a handful of arguments, a few environment entries
 * - so these bounds only keep a hostile caller from building an oversized frame; what makes a
 * definition *valid* is the engine's own rule, which runs when it is written.
 */
export const MCP_ARGS_MAX = 32
export const MCP_ENV_ENTRIES_MAX = 32
export const MCP_HEADERS_MAX = 16
export const MCP_VALUE_CHARS_MAX = 2_048
export const MCP_TIMEOUT_MS_MAX = 3_600_000

/**
 * Ceilings for a plugin command.
 *
 * A spec, a plugin id and a marketplace name are all short strings, and none of these bounds is a
 * rule the engine has: they only keep a hostile frame from carrying a megabyte into a filesystem
 * call. What makes a spec *valid* is the engine's own classifier, which runs on whatever survives
 * this check.
 */
export const PLUGIN_SOURCE_MAX = 512
export const PLUGIN_ID_MAX = 256
export const PLUGIN_KEY_MAX = 128
export const PLUGIN_SETTING_TEXT_MAX = 8_192

/**
 * The configuration file names the engine reads from a plugin *root*, one set per surface.
 *
 * These are the single source of truth for the consent probe (`plugins-facts.ts`): the engine
 * accepts the prefixed and the unprefixed spelling of each file, so a probe that looked for one of
 * them would report a plugin that configures an MCP server, an LSP server or a DAP adapter as
 * carrying no code - and the consent gate would wave it through (spec §15.1-3, H1). The engine's own
 * lists were read from `@oh-my-pi/pi-coding-agent@18.18.2`
 * (`src/discovery/omp-plugins.ts`, `src/lsp/config.ts`, `src/dap/config.ts`); changing a set here is
 * a change to that contract, and must be mirrored in `engine-contract.ts` and the plugins smoke.
 */
export const PLUGIN_MCP_FILENAMES = ['.mcp.json', 'mcp.json'] as const
export const PLUGIN_LSP_FILENAMES = ['lsp.json', '.lsp.json', 'lsp.yaml', '.lsp.yaml', 'lsp.yml', '.lsp.yml'] as const
export const PLUGIN_DAP_FILENAMES = ['dap.json', '.dap.json', 'dap.yaml', '.dap.yaml', 'dap.yml', '.dap.yml'] as const

/**
 * Desktop-manifest permission names P1 knows (spec §6.2).
 *
 * A manifest that names anything else is refused whole rather than partially honoured: an unknown
 * permission means this host cannot say what the plugin is asking for, and "load it anyway" would
 * grant whatever the name maps to on a future build.
 */
export const PLUGIN_DESKTOP_PERMISSIONS = [
  'ui.panel',
  'ui.view',
  'ui.settings',
  // A sidebar tab is a shell-level navigation entry rather than a docked pane, so it is its own
  // permission: a plugin that only wants to be reachable from the sidebar does not have to ask for
  // the work panel as well (spec §3.2, §4.2).
  'ui.tab',
  'notify',
  'clipboard.read',
  'clipboard.write',
  'fs.read',
  // The two modes that change what is on disk (spec §6.2): added with their own gates, scopes and
  // questions, and refused for a whole tree at manifest validation.
  'fs.write',
  'fs.delete',
  // The file half of `net.anyHost`: a manifest that declares this may name *any* path in all three
  // modes, and the workspace root, the plugin's own package, the reject table and the declared scope
  // all stop applying (`services::plugins::gates::resolve_any`). It exists for the open plugin
  // surface - a plugin that manages a user's projects, or a dotfile they asked it to own, is not
  // helped by a gate that only ever sees the workspace - and it is declared separately so a plugin
  // that listed a scope never reads as one that asked for the whole disk.
  'fs.anyPath',
  // The two ways a path leaves this application (API 0.3.0): handed to the system's own *default
  // program*, or pointed at in this machine's file manager. Two names rather than one because the
  // first can start a program - the default handler for an executable extension is the program
  // itself - while the second only opens a window. Both ride the read scope for their reach, and
  // neither is widened by `fs.anyPath`: that widening is about where a plugin may reach, and the
  // two brakes these carry (the credential reject table, and the executable-extension list) are
  // about what a launcher will do, which no file permission makes safe. `fs.glob` and
  // `fs.readRange` are deliberately *not* here: they are the read permission's own reach, and a
  // name for them would be a second way to say `fs.read`.
  'fs.openDefault',
  'fs.reveal',
  'net.fetch',
  'agent.extension',
  // A theme is declarative: the plugin contributes token values, and the application applies
  // whichever one the user picked. The permission is what keeps a plugin that declares no theme from
  // being read as having contributed one (spec §3.2, §4.2).
  'ui.theme',
  // The stylesheet half of a theme, deliberately separate from the token half: a theme that also
  // ships `css` or `assets` injects reviewed *content* into the application document, so it asks for
  // its own permission and a manifest without it refuses the whole desktop block. Both halves are
  // needed together - a stylesheet is only reachable through a theme, and a theme is what `ui.theme`
  // declares (spec §3.2, §4.2).
  'ui.theme.css',
  // A resident plugin process (`omp.desktop.main`, plan §6.1). The host validates only the shape:
  // whether a process may run is the Rust supervisor's judgement, and a built-in plugin is exempt
  // there (`row.builtin`) without a second name in the manifest. Declaring it here keeps a manifest
  // that asks for a process from being refused as asking for something unknown.
  'plugin.process',
  // The plugin's right to add its own commands to the command palette (`omp.desktop.contributes.
  // commands`, plan §6.1). The worker forwards every registration; the gate is Rust's.
  'command.register',
  // The right to run a slot module *in the application document* (`omp.desktop.renderer`, plan
  // §7.1). It is the highest reach in this list - the module shares the application's realm rather
  // than a page frame's or a worker's - so it is one name for the module and both dispatch lists
  // (`rendererActions`, `rendererCallMethods`), and a manifest that declares any of the three
  // without it has the whole block refused. The confirmation card is worded as such and a widened
  // revision asks again (`reconfirm_widened`).
  'renderer.extension',
  // The session index, read-only (P1): what this application already lists - the conversations, one
  // conversation's metadata, and the messages of one conversation within an explicit body budget.
  // No write path exists in this permission, and a message body is returned only when the caller
  // names a `contentLimit`.
  'session.read',
  // The other half of the conversation surface (API 0.3.0): renaming one conversation and deleting
  // it. Its own name because it is the first thing here that *changes* what the user owns - the read
  // above is deliberately, permanently read-only - and its gates are separate so a plugin that only
  // lists conversations never reads as one that can remove them. Its reach is `session.read`'s
  // (the ids the index lists), and nothing it does writes a session file: both calls go through the
  // host's own `session_set_name` / `session_delete`.
  'session.write',
  // The token and cost accounting this application already computes from the engine's own session
  // entries (`host/src/usage.ts`), one row per model call.
  'usage.read',
  // One completion through the models this application is already configured with (P1). High risk:
  // it spends the user's money at the provider, so it has its own first-use question and its own
  // rate budget rather than sharing another high-risk permission's sentence.
  'agent.complete',
  // The plugin bus (P1): one plugin's topics, and everyone's. Publishing is limited to the
  // publisher's own `plugin:<owner>/…` namespace; subscribing may cross plugins. Both are
  // resident-process capabilities - a plugin *page* has no push channel to subscribe on.
  'bus.publish',
  'bus.subscribe',
  // One WebSocket through this application's own client (P1), held to `net.domains` exactly as
  // `net.fetch` is, with a per-plugin socket ceiling and a per-frame size bound.
  'net.websocket',
  // One address handed to the system's own browser (P1).
  'shell.openExternal',
  // This application's own built-in browser, driven by a plugin (API 0.3.0): one page per
  // installation, never the reader's tab and never another conversation's. One name for the seven
  // verbs, because they are one page. The address rule is `net.domains`': a page a plugin can drive
  // is a page it can read, so navigation is an egress like any other. The raw CDP channel is not
  // part of this surface at all - cookie, storage and target management, DevTools attachment and
  // request interception are unreachable because no method spells them.
  'browser.use',
  // The second key beside `net.domains` (P1): a manifest that declares this *and* sets
  // `omp.desktop.net.anyHost: true` may reach any host. Declared separately so a plugin that only
  // listed domains never reads as a plugin that asked for the whole network.
  'net.anyHost',
] as const

/**
 * Desktop-manifest localisation bounds (spec §3.2).
 *
 * A locale's three fields are short display strings, and the locale set is closed in practice (`en`
 * and `zh`); the caps only stop a manifest from turning one row's payload into a translation table.
 * Over the locale cap the first keys in sorted order are kept, so the same manifest always produces
 * the same payload.
 */
export const PLUGIN_DESKTOP_I18N_LOCALES_MAX = 16
export const PLUGIN_DESKTOP_I18N_TEXT_MAX = 512

/**
 * Setting labels one locale may override (`i18n.<locale>.settings`, spec §3.2/§5.5).
 *
 * The block renames controls, and a plugin has far fewer controls than this; the cap only stops a
 * manifest from turning one row's payload into a translation table. Over the cap the first keys in
 * sorted order are kept, so the same manifest always produces the same payload.
 */
export const PLUGIN_DESKTOP_I18N_SETTINGS_MAX = 64

/**
 * Bounds on one plugin theme (spec §3.2, §4.2).
 *
 * A theme is a set of this application's own design tokens and nothing else: the token names are
 * checked against the two families the application publishes, so a plugin cannot invent a property
 * the renderer would then apply, and the values are checked against the syntaxes a token may hold,
 * so a value cannot smuggle a second declaration. The caps stop one manifest from turning a row into
 * a stylesheet; a theme over them is refused rather than trimmed, because half of a theme is not the
 * theme its author wrote (the block's own rule for a panel whose entry is out of root).
 */
export const PLUGIN_THEME_TOKEN_MAX = 96

/**
 * Themes one plugin may contribute (spec §4.2, plan §5.1).
 *
 * The appearance page draws one row per theme, so the count is a UI bound as much as a payload one:
 * a manifest over it is refused whole (`too_many_themes`) rather than trimmed, because a plugin
 * that asked to be eight themes and got the first eight would be a different contribution than the
 * one it declared.
 */
export const PLUGIN_THEME_COUNT_MAX = 8

/**
 * Bounds on a theme's optional stylesheet and its declared assets (spec §3.2, §4.2).
 *
 * A theme may name one package-relative stylesheet and the files that stylesheet is allowed to
 * reference; the host checks the shapes and the counts, and the Rust side - which is the one that
 * reads the bytes - checks the real sizes (`PLUGIN_THEME_CSS_MAX_BYTES` there). The path caps match
 * the page-entry cap for the same reason: one manifest field is not a place to name a directory
 * tree. Over a cap the theme is refused rather than trimmed, like every other theme field.
 */
export const PLUGIN_THEME_CSS_PATH_MAX = 256
export const PLUGIN_THEME_ASSETS_MAX = 16
export const PLUGIN_THEME_ASSET_PATH_MAX = 256
/**
 * What a declared asset's extension may be: images a stylesheet can paint with, and the one font
 * format this build serves. The list is closed because the Rust side serves exactly these as static
 * files; an extension outside it would be a file whose meaning the other half has not agreed on.
 */
export const PLUGIN_THEME_ASSET_EXTENSIONS = ['svg', 'png', 'jpg', 'jpeg', 'webp', 'avif', 'woff2'] as const

/** Longest `omp.desktop.engines.ompDesktop` range this host reports (spec §3.2). */
export const PLUGIN_DESKTOP_ENGINES_MAX = 128

/**
 * Bounds on one `omp.desktop.fs.read.scope` list (spec §3.2).
 *
 * A scope is the standing reach a file-mode permission stands for, so it is a short list of short
 * patterns: the caps stop a manifest from turning one row's payload into a pattern language, and the
 * segment cap bounds what the matcher on the Rust side has to walk. A list over the cap is refused
 * rather than trimmed, like every other safety field here.
 */
export const PLUGIN_FS_SCOPE_MAX = 32
export const PLUGIN_FS_SCOPE_PATTERN_MAX = 256
export const PLUGIN_FS_SCOPE_SEGMENTS_MAX = 16

/**
 * The desktop API version this build serves, which `engines.ompDesktop` is compared against
 * (spec §3.2).
 *
 * Its own line rather than the application's version: what a plugin's range is about is the
 * *desktop contract* - the manifest fields, the page carriers, the bridge - and that contract can
 * stay where it is while the application ships a patch. Bump it when a plugin could notice.
 *
 * **0.3.0 is the version whose surfaces this build actually serves** - `fs.stat`/`fs.list`/`fs.glob`/
 * `fs.readRange`/`fs.openDefault`/`fs.reveal`, `session.rename`/`session.delete`, `browser.*` and
 * `plugin.dataDir` are all in `BridgeMethod` - so the constant moved with them: a range a plugin
 * writes for those methods (`>=0.3.0`) now evaluates true, while a pin that excluded them
 * (`^0.2.0`, i.e. `>=0.2.0 <0.3.0`) is refused `unsupported_engine_range`. `>=0.1.0` and `>=0.2.0`
 * - what this build's own templates and the authoring recipe write - stay satisfied.
 */
export const PLUGIN_DESKTOP_API_VERSION = '0.3.0'

/**
 * Bounds on one desktop page entry (spec §3.2): a panel, a work-panel view, a settings page or a
 * sidebar tab.
 *
 * A page entry is a small record - an id, a title, one relative path, an icon token, and for a panel
 * a size - so these caps only keep a manifest from turning one row's payload into a directory
 * listing. An entry over them refuses the block, the same way an entry outside the plugin root does:
 * half a page contribution is not what its author declared.
 */
export const PLUGIN_DESKTOP_ENTRIES_MAX = 32
/** Longest `entry` path one page entry may name, before it is resolved against the plugin root. */
export const PLUGIN_DESKTOP_ENTRY_PATH_MAX = 256
/** Largest `order` one page entry may sort by; over it the entry is refused rather than clamped. */
export const PLUGIN_DESKTOP_ENTRY_ORDER_MAX = 10_000
export const PLUGIN_DESKTOP_ENTRY_ORDER_DEFAULT = 100
/**
 * The shape of one page entry's `icon` (spec §3.2): a lowercase semantic token the page resolves
 * against its own icon table.
 *
 * A token rather than a name this host recognises: only the shape is checked here, so a token this
 * build has never heard of still reaches a page that knows it and degrades to that entry's default
 * icon there. A value outside the shape refuses the block, the way every other entry field does -
 * an icon its author meant is not one to drop quietly.
 */
export const PLUGIN_DESKTOP_ICON_TOKEN = /^[a-z][a-z0-9-]{0,31}$/
/**
 * The shape of one work-panel tab's `renderer` (spec §3.2): a lowercase semantic token, spelled the
 * way an icon token is and for the same reason.
 *
 * It names one of the surfaces this application draws itself rather than a page it loads, so only
 * the shape is checked here - the vocabulary belongs to the side that draws it. A token this build
 * does not serve reaches the page and is dropped there (a tab nothing can draw is not drawn); a
 * value outside the shape refuses the block, the way every other entry field does.
 */
export const PLUGIN_DESKTOP_RENDERER_TOKEN = /^[a-z][a-z0-9-]{0,31}$/
/** The window size bounds one panel entry may ask for. */
export const PLUGIN_DESKTOP_PANEL_WIDTH_MIN = 320
export const PLUGIN_DESKTOP_PANEL_WIDTH_MAX = 2_048
export const PLUGIN_DESKTOP_PANEL_HEIGHT_MIN = 240
export const PLUGIN_DESKTOP_PANEL_HEIGHT_MAX = 1_600

/**
 * Bounds on the plugin-process block (`omp.desktop.main`, plan §6.1).
 *
 * The host validates shapes only - whether a process may run, and whether a built-in is exempt, is
 * the Rust supervisor's judgement - so these caps keep one manifest from turning the row payload
 * into a directory listing or the worker argv into an unbounded string. A `main` outside the
 * package-relative shape refuses the whole desktop block (the same posture as a theme stylesheet);
 * an activation event this build does not implement is dropped with one log line instead (spec
 * §3.2), because an event is a request to be *told* about something and an unknown one grants
 * nothing.
 */
export const PLUGIN_DESKTOP_MAIN_PATH_MAX = 256
/** How many activation events one block may declare; over it the block is refused rather than cut. */
export const PLUGIN_DESKTOP_ACTIVATION_EVENTS_MAX = 32
/** Longest activation event string this host reads; a longer one is an unknown event (dropped). */
export const PLUGIN_DESKTOP_ACTIVATION_EVENT_MAX = 128
export const PLUGIN_DESKTOP_COMMANDS_MAX = 32
export const PLUGIN_DESKTOP_COMMAND_KEYWORDS_MAX = 16
export const PLUGIN_DESKTOP_COMMAND_KEYWORD_MAX = 64
/**
 * Bounds on the renderer-slot block (`omp.desktop.renderer`, plan §7.1).
 *
 * A slot module is one package-relative file plus two short vocabularies - what it may ask the
 * application to do, and which of its own worker methods `plugin.call` may reach - so these caps
 * only keep a manifest from turning one row's payload into a directory listing or an unbounded
 * dispatch table. Over a cap the block is refused rather than cut, the same posture as every other
 * entry list here: half a dispatch table is not the reach its author declared. The method bound is
 * counted in characters (`PLUGIN_RENDERER_METHOD_MAX`) so the same manifest reads the same on both
 * sides of the contract.
 */
export const PLUGIN_RENDERER_PATH_MAX = 256
export const PLUGIN_RENDERER_ACTIONS_MAX = 16
export const PLUGIN_RENDERER_CALL_METHODS_MAX = 32
export const PLUGIN_RENDERER_METHOD_MAX = 128
/**
 * The action tokens a slot module may dispatch (`host.dispatch(action, payload)`, plan §7.1).
 *
 * Closed on this side on purpose: `composer.*` and `attachments.*` are carried out by the slot host
 * in the frontend without a round trip, and `plugin.call` is the one that reaches the plugin's own
 * worker through T2's invoke channel. A token this build cannot interpret is a request it cannot
 * honour, so an unknown token refuses the whole desktop block instead of being dropped - the same
 * answer an unknown permission gets (spec §6.2, §7.3).
 */
export const PLUGIN_RENDERER_ACTIONS = [
  'plugin.call',
  'composer.insertText',
  'composer.readDraft',
  'composer.replaceDraft',
  'attachments.add',
  'attachments.list',
  'attachments.remove',
] as const
/**
 * The shape of one method name in `rendererCallMethods` (plan §7.1): an ASCII letter first, then
 * letters, digits, `_`, `-` and `.`. A method names one handler in the plugin's own worker, so the
 * grammar is the command id's without its length cap - the cap is `PLUGIN_RENDERER_METHOD_MAX`,
 * counted separately so the two sides bound the same string.
 */
export const PLUGIN_RENDERER_METHOD_NAME = /^[A-Za-z][A-Za-z0-9._-]*$/
/**
 * The shape of one contributed command id.
 *
 * A command id is a namespaced token (`git-helper.open`), so it is the page-entry id grammar with
 * `.` allowed as a separator: an ASCII letter first, then letters, digits, `_`, `-` and `.`, at most
 * 64 characters, and therefore no control characters and nothing a shell or a frame reader would
 * join differently.
 */
export const PLUGIN_DESKTOP_COMMAND_ID = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/

/**
 * Plugin worker budgets (plan §6.2/§6.3).
 *
 * Owner: one worker process. Limit: its own pending-invoke table and its own rolling-second
 * counter. Release: a pending entry leaves when `worker_invoke_result` arrives (or the process
 * ends), and the rolling window forgets timestamps older than {@link PLUGIN_WORKER_INVOKE_WINDOW_MS}.
 * The frame ceiling is the host's own `MAX_FRAME_BYTES` reused rather than a second number that
 * could drift from the protocol it belongs to.
 */
export const PLUGIN_WORKER_MAX_PENDING_INVOKES = 64
export const PLUGIN_WORKER_INVOKES_PER_SECOND = 200
export const PLUGIN_WORKER_INVOKE_WINDOW_MS = 1_000
/** Longest frame `id` the worker echoes; a longer or malformed one is a frame it cannot answer. */
export const PLUGIN_WORKER_ID_MAX = 128
/** Longest `--root` the worker argv accepts, in characters. */
export const PLUGIN_WORKER_ROOT_MAX = 1_024
/**
 * What the worker's own outbound queue may hold, in bytes.
 *
 * Owner: one worker process's writer. Limit: this many bytes of encoded lines waiting behind the
 * pipe. Release: every line leaves when its write completes, and a queue that reaches the ceiling
 * means the supervisor stopped reading - the worker leaves rather than growing (the same posture as
 * the host's own writer, whose bound is `OUTBOUND_QUEUE_BYTES`).
 */
export const PLUGIN_WORKER_OUTBOUND_MAX_BYTES = 4 * 1024 * 1024
/**
 * Longest worker log line, in characters: the bridge's own `MAX_LOG_LINE_CHARS` (1024), because
 * `pi.log` and `worker_log` land in the same file and a line is a line on either path.
 */
export const PLUGIN_WORKER_LOG_CHARS_MAX = 1_024

export const PLUGIN_THEME_VALUE_MAX = 64

/**
 * The token names a plugin theme may set: the document's own published palette.
 *
 * Three prefixed families (`--dsw-*` design tokens, `--omp-*` this application's chrome,
 * `--sidebar-*` the rail's palette) plus the bare names the same stylesheet declares in `:root`
 * (`--background`, `--card`, `--primary`, … `--radius`, `--chart-1`..`--chart-5`). It is still a
 * closed list of names this build publishes - a theme cannot introduce a property of its own - but
 * it now covers the surfaces a theme is expected to repaint: a palette that could tint the window
 * frame and not the conversation was a theme that looked half-applied (2026-10-27, `src/index.css`
 * is the list's source of truth; `host/src/plugins-desktop.test.ts` pins the two together).
 */
export const PLUGIN_THEME_TOKEN_NAME =
  /^--(?:dsw|omp|sidebar)-[a-z0-9-]{1,64}$|^--(?:sidebar|background|foreground|card|card-foreground|popover|popover-foreground|primary|primary-foreground|secondary|secondary-foreground|muted|muted-foreground|accent|accent-foreground|destructive|border|input|ring|radius|chart-[1-5])$/

/**
 * What one token value may look like: a colour function, a length, a font stack, or one of the
 * keywords the tokens already use. Deliberately an allow-list of shapes rather than a deny-list of
 * characters: a value cannot carry a second declaration (`;`, `{`, `}`, `@` and backslashes are not
 * in any alternative), and the only functions it may name are the colour ones, so nothing here can
 * build a `url(...)` the renderer would then fetch. A `url(` nested inside an allowed function is
 * possible in the letter of the pattern, and produces a declaration no browser parses, so it cannot
 * become a request either.
 */
export const PLUGIN_THEME_TOKEN_VALUE = /^(?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla|oklab|oklch|color|color-mix|lab|lch)\([^;{}@\\]*\)|(?:\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw)?)(?:\s+\d+(?:\.\d+)?(?:px|rem|em|%)?){0,4}|[a-zA-Z][a-zA-Z0-9 ,.'"\-]{0,63})$/

/**
 * What a token value may never contain, even inside an allowed function: anything that names a
 * resource to fetch. The shape allow-list above already excludes these in the common case; this is
 * the explicit refusal, so a future edit to that pattern cannot quietly re-open the door.
 */
export const PLUGIN_THEME_VALUE_FORBIDDEN = /(?:url|image|image-set|src|element|paint)\(|@import/i

/** Session files one usage scan reads, and how many it reads at once. */
/**
 * How deep the session scan descends. The engine nests a subagent's transcript beside its parent
 * (`<dir>/<name>/<AgentId>.jsonl`) and repeats that for every generation, so a two-level scan
 * silently dropped the tokens of nested subagents; this bound only guards against a pathological
 * tree, and is far deeper than any parent chain the `task` tool can build.
 */
export const SESSION_SCAN_MAX_DEPTH = 6

export const USAGE_MAX_FILES = 2_000
export const USAGE_SCAN_CONCURRENCY = 4

/**
 * Day rows one session file's index entry keeps.
 *
 * The published day tables hold at most `USAGE_DAY_ROWS_MAX` days, so a file only needs enough rows
 * to answer them: this is one day's row per model for the published span, with room to spare. A
 * file that outgrows it drops its earliest days and the answer says it is cut (`scanned.truncated`)
 * rather than shrinking a total - the lifetime figures come from the file's own model rows, which
 * are never capped.
 */
export const USAGE_FILE_DAY_ROWS_MAX = 1_024

/** Rows the usage tables carry, and the widest range a caller may ask for. */
export const USAGE_MODEL_ROWS_MAX = 100
export const USAGE_DAY_ROWS_MAX = 366
export const USAGE_SESSION_ROWS_MAX = 200
/**
 * Rows the day-by-model table carries.
 *
 * It exists for the trend chart, which draws a handful of series over a window of days, so the cap
 * is about one month of a dozen models - far more than any chart asks for, and small enough that
 * the page's payload stays a page's payload.
 */
export const USAGE_DAY_MODEL_ROWS_MAX = 400
export const USAGE_RANGE_DAYS_MAX = 3_650

/**
 * The bounds the P1 capability calls are answered within (`omp.desktop` API 0.2.0).
 *
 * Every one of these is enforced on the Rust side, in the bridge's own gate, and each is mirrored
 * there (`src-tauri/src/services/plugins/bridge/capabilities.rs`) because the caller the bound
 * exists for is the one Rust answers. They live here because the worker's own surface documents the
 * same numbers to a plugin author, and two spellings of one ceiling is how a call that this build
 * would serve gets refused a layer earlier.
 */

/** Rows one paged read returns, and the default page. */
export const PLUGIN_SESSION_PAGE_MAX = 500
export const PLUGIN_SESSION_PAGE_DEFAULT = 200
/** Bytes of one message body a caller may ask for (`contentLimit`); no body is returned without it. */
export const PLUGIN_SESSION_CONTENT_BYTES_MAX = 4_096
/** Bytes one session or usage answer may occupy; over it the call is refused, never truncated. */
export const PLUGIN_SESSION_RESPONSE_BYTES_MAX = 1_048_576
/** Wait a window a usage query may span. */
export const PLUGIN_USAGE_WINDOW_DAYS_MAX = 365

/** Output tokens one `agent.complete` may ask for. */
export const PLUGIN_AGENT_OUTPUT_TOKENS_MAX = 4_096
/** Completions one installation may start inside {@link PLUGIN_AGENT_WINDOW_MS}. */
export const PLUGIN_AGENT_CALLS_MAX = 20
export const PLUGIN_AGENT_WINDOW_MS = 60_000
/** Completions one installation may have in flight at once. */
export const PLUGIN_AGENT_CONCURRENCY_MAX = 2

/** JSON bytes one bus message may carry. */
export const PLUGIN_BUS_PAYLOAD_BYTES_MAX = 65_536
/** Subscribers one topic may hold, topics the bus may track, and publishes inside one second. */
export const PLUGIN_BUS_SUBSCRIBERS_MAX = 16
export const PLUGIN_BUS_TOPICS_MAX = 256
export const PLUGIN_BUS_PUBLISH_PER_SECOND_MAX = 100
/** Longest topic name, and the prefix every topic a plugin publishes must carry. */
export const PLUGIN_BUS_TOPIC_CHARS_MAX = 128

/** Sockets one installation may hold open, and bytes one frame may carry. */
export const PLUGIN_WS_SOCKETS_MAX = 8
export const PLUGIN_WS_FRAME_BYTES_MAX = 262_144
/** Frames a socket may hold undelivered before the host stops reading it. */
export const PLUGIN_WS_PENDING_MAX = 32
/** Longest WebSocket address one call may name. */
export const PLUGIN_WS_URL_CHARS_MAX = 2_048

/** Longest address one `shell.openExternal` call may name. */
export const PLUGIN_OPEN_EXTERNAL_URL_CHARS_MAX = 2_048

/**
 * The worker's own two event ceilings (`pi.events`, API 0.2.0): how many topics one plugin's process
 * may listen on, and how many handlers one topic may hold.
 *
 * They bound the map the worker keeps, not the bus (the bus bounds subscribers per topic in the
 * desktop). A plugin that subscribes in a loop would otherwise grow its own process's heap without
 * anything to stop it, which is the one container a plugin fully controls.
 */
export const PLUGIN_WORKER_EVENTS_MAX = 64
export const PLUGIN_WORKER_EVENT_HANDLERS_MAX = 8

/** Status message every uncaught host failure is reported with. */
export const HOST_VERSION = '0.1.1'
