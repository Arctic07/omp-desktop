# OMP Desktop engineering specification

This file is the engineering contract for OMP Desktop: capability ownership, layering, code style, protocol, resource bounds, security, versioning, and the checks that keep them. `AGENTS.md` is the agent entry point (how to build, which instance is which, how to run things); `src/AGENTS.md` and `src/rules.md` are the frontend landing rules. Where this file and `src/AGENTS.md` disagree about frontend code, `src/AGENTS.md` wins.

Optimize for, in order: correctness, user data safety, security, backward compatibility, architectural integrity, testability, maintainability, delivery speed. Optimize for changing the system safely, not for changing it quickly.

A rule stated here is a hard requirement. When one conflicts with a system or developer instruction, the higher-priority instruction wins, and the delivery note names the conflict.

## Project position and stack

OMP Desktop is the desktop form of omp (Stencil Labs' terminal coding agent). The engine is omp; this repository supplies its interaction surface and system integration, never a second agent implementation.

- **One integration surface**: the official SDK `@oh-my-pi/pi-coding-agent` — `createAgentSession()` plus the session, settings, model, discovery, and tool-factory APIs. Authority is <https://omp.sh/docs/sdk> and the upstream `oh-my-pi` source.
- **Capability ownership**: tool execution, prompt and context assembly, session file format, model resolution and roles, compaction and retry, extensions and skills, MCP, LSP, and subagents belong to the engine and reach the UI through the protocol. The Rust host and the frontend never reimplement equivalent logic and never read or write engine data files, except the read-only projection described in [Engine integration and data ownership](#engine-integration-and-data-ownership).
- **Look before building**: find the existing SDK entry point before implementing an agent-facing feature. When none exists, name the missing capability and stop — no equivalent reimplementation, mock, or frontend fallback.
- **Exactly one engine form**: a host process this project builds, embedding the official SDK, carrying every session, driven by this repository's stdio protocol. The user's machine needs no omp, Node, or Bun install; the engine and its runtime are never downloaded or replaced at runtime; the deleted official-binary sidecar does not come back; upstream RPC mode (`omp --mode rpc`) is a single-session CLI model and does not carry one process with many sessions.
- **Values live in the implementation**: frame caps, error codes, command tables, and protocol vocabulary are `host/src/constants.ts`, `host/src/protocol/**`, and `host/src/dispatch.ts`. This file states rules, never numbers that drift.
- The desktop shell is Tauri 2. The frontend owns interface and interaction; Rust owns the security boundary, system capabilities, long-running work, concurrency, data processing, and performance-critical paths.
- No new SDK dependency, adapter layer, empty interface, mock, placeholder, or `TODO: implement` without an explicit requirement.
- Code is lean, stable, readable, maintainable: no waste, no duplication, no invalid abstraction, no temporary patch, no code that exists to satisfy a check.

### The only frontend

`src/` is the only frontend: React 19 + TypeScript + Vite + Tailwind v4 + beUI. New features, bug fixes, UI changes, and state or data-flow changes land there and nowhere else.

- Landing rules: `src/AGENTS.md` (structure and behavior) and `src/rules.md` (design system, component library, file size). On conflict they win for frontend code.
- Run `pnpm tauri:dev` (`identifier` `com.omp.desktop.dev`) and `pnpm tauri:build`; the root scripts (`dev`, `build`, `preview`, `typecheck`, `test`, `lint`) delegate to `pnpm --filter src <name>`.
- Quality: extensible, maintainable, single responsibility, clear boundaries, no duplicate implementation, no dead code, no placeholder or invented data. Every number and every state comes from the engine or the host, never from what would look good.

### Reference material is read-only

Other projects — the upstream engine, other desktop implementations of the same SDK, terminal-agent CLIs — are reference. They are not part of this repository and not a rule source.

- **Read the approach, then find the equivalent here.** This file and the existing code decide whether a borrow fits; on conflict this repository wins.
- **Borrow no code.** Nothing under an unclear or incompatible license. A borrowed idea is rewritten against this repository's layering and style, and the delivery note names the file or conclusion taken.
- **Borrow no process.** Another project's branch, worktree, E2E, commit, or gate conventions are not this repository's; the gates are in [Verification and gates](#verification-and-gates).
- **Read no credentials.** No project's `.env`, keys, or user data.
- Repository documents name no machine paths, user names, internal project names, or private repository URLs — the repository is public. Use `<workspace>`, `%LOCALAPPDATA%`, `%USERPROFILE%`.

### Plugin system

Two layers with fixed capability ownership. The **engine plugin layer** — discovery, marketplace, enablement, extension runtime, skills, commands, hooks, tools, MCP — belongs to the engine and is reached through host frames. The **desktop plugin layer** — contribution points, gates and consent, isolation, management and store UI, audit — belongs to this application.

Forbidden: reimplementing plugin discovery, manifest semantics, the enablement state machine, or marketplace logic; a second plugin store or a second copy of enablement state; Rust or the frontend writing the engine's data directory; calling unsandboxed third-party code a sandbox.

**Identity.** `pluginId` is the plugin's own id plus its scope, and is the key for rows, grants, pages, themes, and setting keys. `installId` (`name@marketplace`) exists only to call the engine's write commands (uninstall, enable, disable, upgrade). One plugin may be listed in several marketplaces: records merge into one row per `(pluginId, scope)` with the rest in `sources[]`, and a grant is stored per `pluginId`, so changing the source never re-asks consent. Version comparison has exactly one form, `Bun.semver.order(candidate, installed) > 0`; a cross-marketplace upgrade is uninstall then install, two confirmations, one rollback.

**Contribution points** (`package.json#omp.desktop`, `schemaVersion` 1, additive only): `panels[]`, `views[]`, `settingsDestinations[]`, `sidebarTabs[]` (loaded documents); `workPanelTabs[]` (drawn by this application, `renderer` is a semantic token this build serves as `terminal`); `themes[]` (`tokens` + `css` + `assets`); `main` + `contributes.commands[]` + `activationEvents[]` (`onStartup`, `onCommand:`, `onView:`); `renderer` + `rendererActions[]` + `rendererCallMethods[]`. An out-of-bounds block is rejected whole. An unknown `icon` or `renderer` token degrades to the default instead of failing.

**Permissions** are the manifest declaration *and* the user's grant. The four high-risk capabilities — `ui.theme.css`, `plugin.process`, `renderer.extension`, `agent.complete` (it spends the user's money) — are consented separately and never share one sentence of copy; the confirmation is per installation and compares the code a package runs, not the permissions it declares (`consent::widened_reasons`). A built-in is granted by being enabled and cannot be disabled or uninstalled (`PLUGIN_BUILTIN_PROTECTED`); authenticity means the reserved marketplace `omp-desktop-builtin` and a `source_uri` inside this build's resource root.

**Plugin processes** are `omp-host.exe --plugin-worker`, the same artifact. Caps, backoff, and timeouts are the constants in `process/mod.rs`; stop order is `worker_unload` then kill; a crash changes status and never auto-disables, and the supervisor logs the exit code. A crash after a live run retries on a doubling backoff until its restart budget is spent; surviving the reset window (or a manual restart) forgives the budget, and `omp.desktop.autoRestart: false` refuses the retries and goes straight to `crashed`. A plugin's calls into the desktop pass the same gate table as the bridge — there is no second decision table.

**Renderer slots** serve only `/<key>/renderer.mjs`, realpath inside the plugin root. The module runs in the application's own realm and can read and write the page, so its trust level is labelled honestly and never called a sandbox. React comes from `host.react`; bare module imports are refused; every mount point is wrapped in an `ErrorBoundary`.

**Theme CSS**: rejected forms and size caps live in `theme_css` and `constants.ts`. `url()` accepts `data:` and declared assets only, rewritten to the plugin's own source, and never relaxes the main document's CSP.

**Capability surface**: the desktop API version this build reports is `0.3.0` (`constants.ts`'s `PLUGIN_DESKTOP_API_VERSION`, which every `engines.ompDesktop` range is evaluated against). Every family above passes one `BridgeMethod` table whose caps are mirrored in `constants.ts` and `bridge/capabilities.rs`. `bus.subscribe` serves resident processes only. `net.anyHost` needs the permission and its setting, decided only in `net::NetPolicy`; `fs.anyPath` is its file-side twin, `gates::resolve_any` dropping the root, reject table, scope and question for all three file modes; a listing and a walk apply that table to the names below the resolved path too. That 0.3.0 stage is what lets a plugin *use* a reach it holds: `fs.stat`, `fs.list` and `fs.glob` pass the read gate with a directory allowed (`gates::resolve_inspect`; a glob's pattern language is the manifest's own `fs.read.scope`, its walk bounded and marked `truncated`), `fs.readRange` answers a byte range inside `MAX_READ_BYTES`, `session.rename`/`session.delete` write a listed conversation through the host's own `session_set_name`/`session_delete`, `browser.*` drives the plugin's own built-in-browser page, `fs.openDefault`/`fs.reveal` hand one path to the system behind two brakes no permission relaxes (`gates::is_rejected_path`, `gates::is_executable_path`, kept even under `fs.anyPath` and asked again at the act), and `plugin.dataDir` answers the one directory an installation owns — permissionless, like `ready` and `log`, because it reaches into this application's own storage rather than out of it.

**Dual validation**: every new manifest field lands in three places — host parse, Rust recheck, and frontend projection. Two of three is unfinished. Error codes are unified in `src-tauri/src/errors.rs`; audit event words are `plugin.*` in `services/plugins/audit.rs`.

### Built-in capabilities

**Terminal.** A tab's existence and position come from `workPanelTabs[renderer=terminal]`; its interface and PTY belong to this application (`services/terminal.rs`), which loads no plugin document and reimplements no xterm carrier. One terminal per conversation: `open_or_attach` is the atomic check-and-open, a later caller attaches and receives the replay, and each session keeps a 128 KiB bounded output ring. The agent side is the first-party `workspace_terminal` tool (`list`, `read`, `write`, `create`) operating the user's terminal without going through the page, because the pty lives in the desktop process; it must answer within its 20 s budget, and `read` is a tail text snapshot with escape sequences and `\r` stripped — not a terminal emulator. Tab numbering belongs to the frontend (`state/panel-tabs.ts`): every conversation numbers its own tabs from 1, a closed tab returns its number to the next one, and the pty id is a runtime key only, handed over by `terminal_label_set`. `list` prints `PowerShell-2 (terminal-7)`, so a user naming a tab reaches that id. Numbering is never shared across conversations.

**Built-in plugin artifacts.** A change to any file of a built-in plugin bumps its version (`package.json` and `marketplace.json`) and rebuilds the application artifact: the install root is a versioned cache, so content at an existing version is never rewritten.

### Engine protocol

One host process embeds the SDK and speaks NDJSON over stdio. Frames correlate by their `id`, never by arrival order; session-scoped events and `state` carry `sessionId`; a reply reaches its requester by `id`. `PROTOCOL_VERSION` must be equal in `host/src/constants.ts` and `src-tauri/src/services/runtime/mod.rs`, and adding or removing a command *is* a protocol change that bumps it — otherwise an old artifact handshakes successfully and swallows the new command as an unknown frame. The host reads `omp-host.json.protocol` before spawning and refuses a mismatch (`ENGINE_PROTOCOL`).

- **Frame caps** (values in `host/src/constants.ts`): a physical line, logical-frame reassembly, and prompt length (host side and the real host-through-desktop path) each have a ceiling. Only host outbound frames fragment. Anything over a cap is refused explicitly (`FRAME_TOO_LARGE`, or a redacted `invalid_input`), never truncated silently.
- **A routing id is not an engine session id.** Identify a session by the `sessionId` in the `session_open` reply (or `state.sessionFile`), never by `state.sessionId`.
- **History** pages are oldest-first in the public shape. The cursor `c<offset>@<total>` is bound to a snapshot and a mismatch answers `stale_cursor`; the desktop passes cursors through as opaque strings.
- **Two error-code sets**: lowercase codes produced by the host (`host_not_ready`, `session_not_found`, `session_busy`, `stale_cursor`, `invalid_session_path`, `invalid_input`, `protocol_mismatch`, `env_pin_failed`, `host_failed`, `timeout`) and the uppercase codes in `src-tauri/src/errors.rs`.
- **A host-to-desktop request** (`terminal_request`, `browser_request`) is always answered by the desktop, on one timeout budget shared by both sides. The frame dictionary is `host/src/dispatch.ts` and `host/src/protocol/**`.

### Documentation discipline

The repository keeps two standing documents: `AGENTS.md` (agent entry — reading order, build, instances, recipes, tiers, budgets, gates) and this file (engineering rules). Everything else lives in code and tests: the plugin, terminal, protocol, and update contracts are stated where they are implemented, and evidence for a change is its tests plus the delivery note.

- Completed plans, status ledgers, and one-off evidence directories do not enter the repository; their history is in git.
- A change to the implementation updates the paragraph that states it in the same change. Two documents describing one fact always drift; the home is named in `AGENTS.md`'s tier table.
- Comments may still carry the shorthand of the design documents deleted on 2026-10-27 (`spec`, `plan`, and `contract` prefixes with a section number). Those numbers describe documents that no longer exist; they are inert markers, never current authority, and new comments cite this file by anchor instead, e.g. `rules.md#plugin-system`.

## Pre-change architecture check

Before any non-trivial change, and at least the caller and impact check for a one-line fix:

1. State the scope: inputs, outputs, success conditions, failure behavior, and what is *not* part of this change.
2. Read this file, the relevant configuration, the target source, and every direct caller. Reuse the existing pattern; an existing capability is never reimplemented.
3. Decide the layer: interface, frontend logic, IPC, Rust command, Rust service, or the engine side (SDK plus host protocol).
4. Design module boundaries, data flow, state ownership, concurrency model, cancellation, permission boundary, error propagation, and resource lifetime — and define the DTOs, command names, frame protocol, and error contract before writing code.
5. List the boundary cases: empty input, invalid path, missing permission, missing file, oversized data, process failure, concurrent requests, cancellation, repeated operation.

Do not create empty directories, empty interfaces, uncalled abstraction layers, or unfinished extension points "for later".

## Layering and repository layout

Directories exist when a real need exists, never as empty shells. Application assembly stays in `lib.rs` and `src/src/App.tsx`; domain logic never piles up there.

### Frontend

The authoritative layout is `src/AGENTS.md`. The outline:

```text
src/src/
├─ api/            DTOs and command wrappers; `client.ts` is the only `invoke`,
│                  field names verbatim from the Rust `#[serde(rename)]`
├─ state/          `useSyncExternalStore` domain stores (`store.ts` is a minimal
│                  wrapper) and the pure rules of the same domain
├─ components/     ported beUI sources, by domain
├─ home/           the session surface (conversation list, composer, title bar)
├─ settings/       the settings surface (an overlay above the conversation)
└─ lib/            shared utilities, i18n copy, hooks
```

A router, multi-level pages, or a new top-level directory needs a real requirement first and an update to `src/AGENTS.md` in the same change. Two directory systems never coexist.

### Rust and host

```text
src-tauri/src/
├─ lib.rs         Tauri initialization, plugin initialization, command registration
├─ commands/      thin command layer: validate input, call a service
├─ services/      domain implementation (runtime/ host orchestration and protocol,
│                 store/ application data, session_index/ read-only projection,
│                 git/, custom_providers/, …)
├─ models/        cross-IPC DTOs and event models (models/dto/**)
├─ state.rs       application state, task state, resource lifetime
└─ errors.rs      the single error type and its codes

host/
├─ src/           entry point, protocol codec, session registry, event fan-out
├─ scripts/       build and artifact verification scripts
└─ build.ts       build entry (equivalent to the scripts entry; one at a time)
```

The host is part of the build artifact. `host/.build/`, `host/dist/`, `host/.dev-data/`, and `host/evidence/` stay excluded by the root `.gitignore`; no other long-lived directory appears under `host/`.

### Single-file line limit

- No new or modified file exceeds 1000 lines, blank lines and comments included. 300–600 is the target; near 800, split before adding more. A component past ~200 lines is evaluated for splitting.
- An already oversized file may not keep growing: split it under 1000 lines before changing its business logic, unless the user explicitly defers that. A split preserves single responsibility, dependency direction, and the external contract — no mechanical file cutting and no forwarding layer invented to dodge the limit.

## Frontend TypeScript

`src/AGENTS.md` and `src/rules.md` own the language and styling details: beUI is the one component library; IPC only through `src/src/api/**` with DTO fields verbatim from Rust; state in `src/src/state/**`; `useStoreSelector` never returns a new object; large lists use `@tanstack/react-virtual`. This section keeps the requirements that hold for all of `src/**`.

- Props, store state, event parameters, function parameters, return values, and API boundaries are typed. No new `any`, `@ts-ignore`, or `@ts-expect-error`; when an external type is genuinely missing, narrow the scope and state the verifiable reason.
- Page orchestration belongs to the components in `src/src/home/**` and `src/src/settings/**`; cross-component state belongs to an existing store; pure functions belong to `src/src/lib/**` or a domain rule module beside its store; IPC calls go through `src/src/api/**`.
- A component does one clear thing and exposes its contract through typed props. It does not depend on a parent's variable names, on implicit DOM structure, or on undeclared global state. No side effects or data-processing loops during render.
- One fact has one source. High-frequency transient UI state (input, selection, expansion, drag) stays in the frontend; a single value does not get a global store; no copy is maintained without a synchronization contract.
- Async work handles loading, success, failure, cancellation, and stale responses. An old result never overwrites a newer one.
- Import order is external dependencies, a blank line, then local modules; single quotes, no semicolons, trailing commas. Delete unused imports, variables, types, and comments; no dead code, empty function, unreachable branch, or ineffective fallback.
- Reuse the existing virtualization for large lists instead of rebuilding it.

### UI and styling

- Reuse the existing components, icons, design tokens, and style utilities. A second UI system needs a reason.
- Colours, spacing, radii, shadows, and font sizes come from the existing CSS variables and tokens (the global tokens in `src/src/index.css` and the Tailwind variables). No magic numbers copied between surfaces; cross-component styles live in `src/src/styles/**`.
- No inline style for static styling. A dynamic style uses a CSS variable, a class, a Tailwind variant, or has a stated reason.
- Class names carry the component or area prefix (`omp-`), never `.title` or `.container`.
- Windows are full-height, keyboard reachable, with visible focus and sufficient contrast; every interactive element has an understandable aria label or visible text.

## Rust core

### Responsibilities

Rust is the default home for: filesystem and workspace scanning, path safety, file watching; Git state and diff, stage and commit, pull; full-text search, indexing, binary detection, structured parsing; spawning child processes, building arguments, reading output, cancellation, timeouts, exit status, resource reclamation; concurrency scheduling, persistence, caching, and other performance-critical paths; anything that hides a secret or touches OS secure storage.

The engine side is Rust too: host lifetime (spawn, handshake and version negotiation, graceful shutdown, death reclamation), NDJSON frame codec, request/response correlation by `id`, event normalization and fan-out, session LRU with no process pool, and the read-only projections of engine data (session index, search projection, migration gates, backup and compaction).

The projection's persisted home is `sessions-index.sqlite` under the data root — not `app.sqlite`, and outside the migration regime described in [app.sqlite schema changes](#appsqlite-schema-changes). Every row derives from a transcript file; a `user_version` mismatch rebuilds the whole database; deleting it at any time costs one scan. A read path first asks whether its answer can be proven, and falls back to the engine's own read when it cannot. No cache is ever written into an engine directory.

The projection carries two things: **message byte ranges** (a page reads only those lines' bytes, never a copy of the text) and **searchable text** (the `text` blocks of every `user`, `assistant`, and `custom` message; tool output and engine narration stay out of the index). The index is built by the list scan as a side effect — every file the scan reads is a file it indexes, so an unread file's index is by definition current — which is why the first listing after an upgrade does one full parse (measured: 224 MB of transcripts in about 3.4 s, an 11 MB index), and every later listing touches only changed files. That parse never moves into `session_search`: a query must be a query.

The usage page's index is the other derived store, and it belongs to the host: `usage-index.ts` writes it as `usage-index.json` in the host's own data directory, outside the engine's session directory, keyed by the canonical path of every transcript and invalidated by that file's length and modification time. One read parses the files that changed and publishes from the rest, so a page open costs a stat per file; a version this build does not know, or bytes it cannot parse, rebuild it from the store (measured 2026-10-30: 439 MB of transcripts in 7.6 s once, 46–70 ms afterwards).

The frontend calls these capabilities and displays their results; it never copies a filesystem, Git, or process core. Application data (`app.sqlite`, host preferences) is written by Rust alone; the frontend never touches disk directly.

### Implementation requirements

- `lib.rs` only initializes and registers commands. A command is thin; domain logic lives in a service.
- Rust internals are `snake_case`; cross-IPC fields declare their serialized names explicitly, and the TypeScript type and the Rust DTO change together.
- External input is validated at the Rust boundary: path normalization and a workspace containment assertion; explicit caps on Git paths, command arguments, and file size.
- Failure returns a structured `Result`. `unwrap`, `expect`, and panics never handle user input, files, network, or process errors at runtime.
- Avoid needless `clone`, allocation, copying, and re-parsing. File, search, Git, and process work carries memory, output-size, and time bounds.
- Blocking file, Git, process, and CPU work never blocks the async runtime. Long tasks are inspectable, cancellable, and reclaimable on failure, and release their processes, handles, temporary files, and watchers when they end.
- Cross-platform code handles Windows, macOS, and Linux differences explicitly; it never relies on a path, shell syntax, or environment variable that only the development machine has.
- Important writes go through a temporary file and an atomic replace. Do not complicate for performance before the bottleneck is measured.

### Engine integration and data ownership

- **The protocol is ours and frozen.** The desktop and the host speak only this repository's NDJSON (commands on stdin, frames on stdout). Frame vocabulary, the command table, and error codes are defined in `host/src/protocol/**` and frozen with the implementation. Fragmented and reassembled frames are this project's own frames and never borrow upstream naming. Host-level and session-level commands are separate layers; new capability lands at session level by default.
- **Handshake and correlation.** `hello` / `hello_ok` negotiate the protocol version and frame caps; a mismatch refuses to start and reports it. A pending request is matched by its frame `id`, never by arrival order. A `parse` frame without an `id` and an unknown command frame go to the session-level error channel; an unhandled frame is ignored explicitly and counted. A turn is complete at `agent_end` (`isTerminal !== false`, or `awaitingAsyncWork === true`).
- **Caps.** The handshake advertises the caps (values in `host/src/constants.ts`). A logical frame above the physical-line cap travels only as this project's fragmented frame. An oversized payload is refused explicitly and counted: a redacted `invalid_input` when an `id` is known, a dedicated code when the desktop refuses to send. Never truncate or drop silently. The prompt cap is refused the same way, with no fallback to disk and no path reference.
- **Outbound is a boundary too.** The host's outbound queue is metered and capped **in bytes** (`Buffer.byteLength(..., 'utf8')`, not `String.length`, whose UTF-16 units let CJK content reach the ceiling about three times later), and **the in-flight batch counts** — otherwise congestion reads false while writes stall and the queue becomes unbounded. When stdout write fails the host can no longer put any counter on screen, `host_health` included, so it ends by exiting (`EXIT_WRITE_FAILED`) and the desktop's child-exit detection reclaims the sessions on the crash path. Never switch to "drop frames silently and keep running".
- **The UI bridge is required capability.** The engine's confirm, select, input, notify, cancel, and open-link requests each need an equivalent answer channel (`extension_ui_request` / `extension_ui_cancel`), including timeout defaults and cancel broadcast. Without it, approval modes and login flows are incomplete.
- **Environment and locations.** The host child's environment is constructed explicitly (`env_clear` plus a whitelist) and pins the variables that decide data locations; it never inherits ambient environment, a user `.env`, or platform defaults. Every variable this application owns carries the `OMP_DESKTOP_` prefix (`OMP_DESKTOP_CODING_AGENT_DIR`, `OMP_DESKTOP_UI_REQUEST_TIMEOUT_MS`, `OMP_DESKTOP_HOST_BIN`). Keys the engine or the OS owns (`PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR`, `PI_NOTIFICATIONS`, `OMP_WORKTREE_DIR`, `XDG_DATA_HOME`, `HOME`, `USERPROFILE`) are set exactly as their owner's semantics require and are never renamed — a renamed key makes the engine fall back to the real user directory. Each location is asserted against the data root, and a violation refuses to start and reports it. Disclosure is part of the contract: the settings page shows the locations, the uninstall notes list them, and the start log records them.
- **Data ownership.** The engine's data directory is read-only to everything outside the engine process; changing session content goes through protocol commands. Engine settings (`config.yml`) and its own configuration files (MCP definitions, the model catalogue) are modified only by the **host process through the SDK or the engine's own write API**, and the answer follows a `flush()`: model roles through `Settings.setModelRole`; skill toggles through `Settings.set` (`skills.enabled`, `skills.enable*`, `disabledExtensions`); MCP enablement through `setMcpServerEnabled`; the memory backend through `Settings.set("memory.backend")`.
- **Serial gate.** `host_health`, `models_reload`, and `host_shutdown` run only when the target session has no in-flight turn and the write handle is flushed. Role commands only read and write engine settings and the model catalogue, never a session file, and stay outside that gate — the exemption is stated at its implementation.
- **Read semantics.** `session_history_page` fails explicitly (`invalid_session_path`, redacted text) for a `sessionFile` that does not exist, is unreadable, is not absolute, or lies outside the host's session directory (directory paths included). It never answers an empty page.
- **Observability.** Unknown frames, dropped frames, and replay attempts, plus `hostStatus === 'degraded'`, have an on-screen outlet: a diagnostic row in settings that appears only when abnormal, in both languages.
- **SDK usage.** Omitted means discovered; explicitly passed means taken over. Every input that decides a location or a credential is passed explicitly by the desktop (`sessionManager`, `settings`, `authStorage` + `modelRegistry` as the same instance). Every top-level session passes a unique agent identity (`agentId`, `agentDisplayName`, `expectedAgentRef`): without `expectedAgentRef` the engine registers unconditionally and a second default-identity session silently replaces the first (`sdk.ts`). Do **not** pass a private `AgentRegistry` — no spawn path forwards the caller's registry to a child, so it only separates the session from its own `task` subagents and breaks `proc://<id>/kill`, `jobs`, and `history://` (`oh-my-pi:task/structured-subagent.ts`). `toolNames` is not a whitelist; a restricted session sets `restrictToolNames: true`. Cross-session reuse is limited to stateless factories and caches — an instance already bound to an `ExtensionAPI` is never handed across. `dispose()` is idempotent; `beginDispose()` is how new work is refused first; SDK-owned resources are never cleaned up around the SDK.
- **Session scope.** Model, thinking level, tool set, skills, prompt sections, and extensions are session-scoped. Process scope holds only genuinely shared services: model registry, HTTP pool, LSP and MCP, auth, settings.
- **Distribution and credentials.** The SDK, the host artifact, and the embedded runtime are build artifacts, shipped with the installer and recorded by version and checksum. They are never downloaded at runtime and never copied into user data (one evaluated exception: warming a native addon during install, managed as build-artifact cache). Credentials live in OS secure storage, are injected by the desktop, and never reach source, logs, process arguments, or a plaintext configuration file.

## Tauri IPC and permissions

- Every `invoke`, event listener, and window API is wrapped by the frontend API layer (`src/src/api/**`); pages and components never compose command names.
- One command expresses one clear business operation with a stable name, explicit parameters, and a serializable return value. A new or changed command updates the Rust DTO, the frontend type, the call sites, and `capabilities` together.
- High-frequency interaction does not cross IPC per event: aggregate in the frontend, or have Rust offer a batch, paged, streamed, or incremental interface. Large data is never transferred unbounded — page it, chunk it, summarize it, or point at a temporary file.
- Long tasks use a task id plus typed events that distinguish start, progress or output, completion, failure, and cancellation, and each event identifies its task.
- An IPC error carries a stable code and information the user can act on. Stack traces, secrets, tokens, and unnecessary absolute paths never reach the frontend.
- `capabilities` grant the minimum: no wildcard shell, filesystem, or system permission for convenience. A new permission states its purpose and scope.
- External programs run with a fixed program, an argument array, and a controlled working directory. Never build a shell command from a string.

### Main-thread budget

- A command that reaches a webview is `#[tauri::command(async)]`: a synchronous body runs on the UI thread, and every WebView2 call marshals back there, so waiting on one freezes the window. `services/main_thread_watch.rs` logs a silent main thread (postmortem 0005).
- The background class (`BELOW_NORMAL` plus EcoQoS, `services/process_tuning.rs`) is dropped while any conversation has a turn running, so an answer the reader waits on is never scheduled as spare capacity (note `2026-10-30-live-turn-was-throttled-in-the-background`).

## Dependencies

- Before adding a dependency, confirm the existing ones cannot do it. Every new dependency states its purpose and is evaluated for API stability, maintenance activity, version compatibility, license, cross-platform support, package size, build time, and security.
- Dependencies are locked to reproducible versions and ship with unneeded features off. No overlapping, unmaintained, or few-line-helper dependencies.
- The frontend follows `pnpm-lock.yaml`, Rust follows `Cargo.lock`. The host is a workspace package in the root `pnpm-workspace.yaml` and shares the root lockfile: **no host-owned lockfile may exist**. After a dependency change, check the lockfile and the build chain.
- `@oh-my-pi/*` packages are imported only inside `host/**`. The desktop and the frontend import no engine SDK package, and the repository keeps no second integration implementation.
- Upgrading the SDK is upgrading the engine: update the pinned version and checksums, re-examine `patches/@oh-my-pi__*` ([`AGENTS.md#engine-patches`](AGENTS.md#engine-patches)), then run the "old data plus new engine" check in [Engine upgrade and distribution](#engine-upgrade-and-distribution).

## State, concurrency, and reliability

- Define state ownership first: transient UI state in the component, shared business state in a named store or Rust state, persisted data in a named data layer.
- Async flows cover repeated triggers, races, stale results, cancellation, timeouts, process exit, and application shutdown.
- No implicit retry, silent degradation, or swallowed error by default. When a requirement calls for one, define the attempt count, the interval, the stop condition, and what the user sees.
- Git, file, and process failures recover or report a clear error. A degraded path follows a defined behavior and never fabricates success.
- Logs have a purpose, a level, and locating context. No secrets, tokens, private content, or meaningless debug output.
- A run's log identifies the build and its own death: `run started` carries the pid and the git identity, `run ended` is written even past the file's byte ceiling, and a native fault writes a bounded minidump plus a record naming the exception and the faulting module (`services/crash.rs`, note `2026-10-31-native-crash-evidence`). The release PDB is kept beside the artifact, so `module+0xoffset` resolves.
- A cache has a capacity, a lifetime, and an invalidation rule. No unbounded cache, full copy, or reliance on an implicit global. Shared concurrent resources state their synchronization and lifetime.

### Resource bounds and release points

Memory that outlives a request may be held by three kinds of structure only: a process-level singleton, a cache with a capacity, and a structure bounded by an external collection (sessions, workspaces, or manifests on disk). A new structure that outlives a request states **owner / bound / release point** in a comment where it is created. A structure that answers none of the three is treated as unbounded with no release point, and is fixed before merge.

| Layer | Long-lived containers | Bound and release point |
| --- | --- | --- |
| host (`host/src`) | Per-session event journal, outbound queue, subagent roster; session registry; the usage index (`usage-index.ts`) | Capped by constants and shed or merged under them (`constants.ts`); sessions evicted by LRU plus TTL (`MAX_LIVE_SESSIONS`, `IDLE_EVICT_MS`); `session-lifecycle.ts::disposeSession` releases watchers, engine session, and file handles. The usage index is bounded by the store itself: `USAGE_MAX_FILES` files, one row per model and at most `USAGE_FILE_DAY_ROWS_MAX` day rows each, and a file the store no longer lists has its rows dropped on the next read |
| Rust desktop | Session registry and per-session state, pending requests, fragment reassembly, terminal PTYs, session index cache, subagent projections and watch sets, logs and scratch | Each container has a constant cap or empties on close or exit: `MAX_PENDING_FRAMES`, `SESSION_CACHE_LIMIT` with `retain_seen`, terminal `MAX_SESSIONS`, projection `CHILD_PROJECTIONS_MAX`, watch set `WATCHED_CHILDREN_MAX` (added and removed by `child_watch`), `LOG_FILE_LIMIT_BYTES`; logs retained 7 days by modification time (`log_retention.rs`'s `LOG_RETENTION_DAYS`) with the newest 20 engine files, plus a scratch sweep |
| Frontend (`src/src`) | Per-session record (`state/session-record.ts` rows and folded frames), pending-frame queues (`session-stream.ts`'s `pending`, `subagent-view.ts`'s `pendingChildren`), warm-session timers (`session-store.ts`'s `warmReleases`), reader positions, attachment preview cache | Records retained by visit order: `RETAINED_RECORDS` count and `RETAINED_MESSAGES` total rows (`session-record.ts`, rows being the cheap proxy for memory; `pruneRecords` evicts by `visitOrder` and skips in-flight, listening, or queued-prompt sessions). Frames batch on the app-wide presentation beat (`state/presentation.ts`: every animation frame when visible and focused, a timer otherwise) with queue caps `PENDING_FRAMES_MAX` and `CHILD_PENDING_MAX`. A session the reader left stays warm for `WARM_RELEASE_MS` (warm set capped by `WARM_RECORDS`, below the desktop's `MAX_LIVE_SESSIONS`) with streaming text on the `BACKGROUND_DELTA_FLUSH_MS` window; expiry's `letGo` is the real release (unsubscribe, clear queues and attachments, hand the session back to the desktop), and `adopt` verifies with `session_watch(id, true)` that the desktop still holds the session. Attachment previews cap at `MAX_ATTACHMENT_PREVIEWS`. Reader positions (`state/reader-place.ts`) hold one small record per visited session, bounded by the on-disk session set and released at process exit |

How to judge:

- A structure that grows per session or per path states **bound and eviction or release point**, and its release point is the same one the session itself takes (delete, close, evict, exit). Cleaning up only on "delete" is a leak.
- **Derived records die with what they derive from.** Messages, the `historyLoaded` flag, and local echoes belong to one record and leave together; losing half shows up as "reopening gives an empty conversation" or "reopening replays the whole history".
- **Not a leak**: a process-level singleton (runtime, desktop event listeners), a small marker pruned while reading a list, a cache with capacity and TTL, a structure bounded by an on-disk collection.
- **A leak**: no bound and no release point, half of a derived record still alive, an object that outlived its owner (DOM node, handle, child process, timer).

## Security

- Never trust a frontend-supplied root, path, command, argument, URL, file content, or user text; Rust validates again. Prevent path traversal, symlink and junction escape, arbitrary command execution, argument injection, unauthorized file access, and resource exhaustion.
- Secrets, tokens, and private content never reach source, logs, `localStorage`, a commit, or a plaintext configuration file. Prefer OS secure storage.
- The repository is public and its history is permanent: a credential, API key, `.env` file, session transcript or log, data-root or evidence copy, a sample or scratch project from this machine, a local absolute path, a user name, or an internal project name never enters a commit or a push. Such an artifact stays outside the tree, `pnpm check:repo`'s `check:public` refuses one that is about to be added, and a credential that did reach a commit is rotated, not merely deleted.
- Untrusted text is not rendered with `dangerouslySetInnerHTML` or another raw HTML injection without a stated sanitizing boundary.
- The engine child's environment, `.env` files, logs, and data directory are all attack surface: construct the environment, pin the data-location variables, redact logs as needed, and state which external input may influence engine behavior. The environment whitelist is never advertised as a complete security boundary.
- The host is driven and attackable at once: inbound frames validate shape, length, and `id`; out-of-bounds paths, malformed fragments, and oversized payloads are refused explicitly and counted.

## Verification and gates

Verify what the change touches. "The code looks correct" is not delivery. Which evidence counts, and how to prove a check itself works, is [Test evidence and gate discipline](#test-evidence-and-gate-discipline).

- Frontend: `pnpm --filter src build` (`tsc -b` plus `vite build`), `pnpm --filter src test`, `pnpm --filter src lint`, and the affected page or interaction actually exercised. Rust: `cargo fmt --check`, `cargo check`, and the affected command or scenario.
- Tauri configuration, permission, or IPC change: check command registration, frontend types, call sites, `capabilities`, and the real start path.
- Engine or protocol change: drive a real host process through handshake (`hello` / `hello_ok`) → `ready` → prompt → streaming events → `agent_end`, plus the three failure paths (process killed, stdin closed, timeout cancelled). A UI-request change proves "answerable, cancellable, and takes its default on timeout".
- Bug fix: reproduce first, then confirm the original scenario no longer triggers. Only a behavior regression worth keeping earns a permanent test.
- Unexecuted checks and remaining risk are listed in the delivery note.

### Artifact rebuild

Everything runnable here comes from a build artifact: `host/dist/omp-host.exe` (the host), `src-tauri/binaries/omp-host-<triple>.exe` (Tauri's `externalBin` target), `src-tauri/target/{debug,release}/omp-host.exe` (the running copy), `src-tauri/target/{debug,release}/omp_desktop.exe` (the application), and `src/dist/` (the frontend, embedded in a release build and served by Vite through `devUrl` in dev). Source changed without a rebuild is a change nobody can see: the user still runs the old behavior, and "it does not start" gets misdiagnosed as a code defect.

**Rebuild when** `host/src/**` changed (host artifacts), `src-tauri/**` changed (application binary), or `src/src/**` changed (frontend artifact — `pnpm --filter src build` writes `src/dist/`, the `frontendDist`).

**Procedure** (complete it in one pass; do not ask first):

1. **Close only the instance that occupies this build's profile**, by `ExecutablePath`, never by process name. Only an instance running from the profile being rebuilt holds `omp-host.exe` open (`target/release` for `pnpm tauri:build`, `target/debug` for `pnpm tauri:dev`), and that is what makes the externalBin copy and `cargo build` fail with `PermissionDenied`. `pnpm --filter src build` and `pnpm host:install` write only `src/dist/`, `host/dist/`, and `src-tauri/binaries/`, so they require closing nothing.
   - The installed copy (`%LOCALAPPDATA%\Omp Desktop\`) holds no repository file: a repository rebuild must not close it, because it may be the user's only window or the application this session runs in. Dev, repository release, and installed are three instances; rebuild one layer, close only that layer (`AGENTS.md` states the identity check).
   - Dev has its own identity: only `pnpm tauri:dev`, which passes `--config src-tauri/tauri.dev.conf.json` (`identifier` `com.omp.desktop.dev`, data root `%LOCALAPPDATA%\com.omp.desktop.dev`). A bare `pnpm tauri dev` takes the installed identity, gets folded by its single-instance lock, and pollutes its data root ([postmortem 0002](postmortems/0002-bare-tauri-dev-used-the-installed-identity.md)).
   - Who started it decides whether you may close it. The parent chain in desktop form is `bash → omp-host.exe → omp_desktop.exe`. An ancestor of the current session is never closed — hand the close, rebuild, and restart to the user. A process you started yourself (your own child) is closed normally. A process unrelated to your tree is closed by profile, and the delivery note names which one (name and path).
   - Never close by process name ([postmortem 0001](postmortems/0001-rebuild-kill-by-process-name.md)): `Stop-Process -Force` by name also kills the installed copy and the session's own host. Close by profile:
   ```powershell
   $profile = (Join-Path (Get-Location) 'src-tauri\target\release')   # debug for pnpm tauri:dev
   Get-CimInstance Win32_Process -Filter "Name='omp_desktop.exe' or Name='omp-host.exe'" |
     Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($profile, 'OrdinalIgnoreCase') } |
     ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
   ```
2. **Host artifacts** (`host/src/**` changed): `pnpm host:install` writes `host/dist/` and `src-tauri/binaries/` and self-verifies its checksum.
3. **Frontend artifact** (`src/src/**` changed): `pnpm --filter src build` (the root `pnpm build` is the same thing) writes `src/dist/`.
4. **Application** (`src-tauri/**` changed, or the embedded frontend must change): `pnpm tauri:build --no-bundle` builds release with `src/dist/` embedded, then runs `scripts/clean-build-cache.mjs`, which deletes only historical Cargo incremental directories and interrupted `.tmp*.temp-archive` leftovers and preserves dependency artifacts (a failure leaves the scene intact). A full wipe stays manual: `cargo clean --manifest-path src-tauri/Cargo.toml`. Never use bare `cargo build --release`: the repository declares no `custom-protocol` feature, the `dev` cfg depends on it (`tauri:build.rs`: `dev = !custom_protocol`), only the CLI turns it on, and bare cargo produces a binary that still points at `localhost:1421`. For `target/debug`, use `pnpm tauri:dev`, which copies `externalBin` itself.
5. **Sync the running copies.** `target/{debug,release}/omp-host.exe` and `omp-host.json` are copied by `pnpm tauri:dev`; `pnpm tauri build --no-bundle` does not refresh them. After a host-only rebuild, copy `host/dist/omp-host.exe` and `omp-host.json` into **both** profiles' `target/` by hand (the two files' `builtAt` and `sha256` come from one build), or the release application fails the handshake and refuses to start ([postmortem 0003](postmortems/0003-stale-host-copy-in-target-release.md)).

**Icons and Windows resources.** The exe icon and the tray icon (`services/presence.rs`'s `default_window_icon`) both come from the Windows resource `tauri_build::build()` generates in `src-tauri/build.rs`, and `tauri_build` does not list `bundle.icon` in `rerun-if-changed`; `build.rs` adds `cargo:rerun-if-changed=icons` itself. When an icon "did not change", confirm that line still exists, then check whether the build script actually re-ran (`target/{profile}/build/omp_desktop-*/invoked.timestamp`) ([postmortem 0004](postmortems/0004-rebuilt-exe-kept-the-old-icon.md)).

**Verification.** The **four** host artifact locations (`host/dist/`, `src-tauri/binaries/`, `src-tauri/target/release/`, `src-tauri/target/debug/`) agree on `sha256` and `bytes` (compare each `omp-host.json`, and confirm its `protocol` equals the desktop's `PROTOCOL_VERSION`); the release application contains the current frontend's asset names; the delivery note states which layers were rebuilt and which were not.

**Failure handling.** A file still locked after closing the application: retry once. Then stop and report the process and path holding it — never retry in a loop. Renaming a running exe aside is allowed on Windows as a temporary measure, and the note records the workaround and the leftover file.

## Change and delivery

- Touch only the files the requirement needs. No unrelated refactor, formatting, dependency, or behavior change rides along. Never overwrite, revert, or clean up the user's unrelated work.
- Before changing an exported component, function, type, route, store, or Tauri command, check every reference and migrate it in the same change. Replacing an implementation completes the cutover: no uncalled alias, compatibility shell, deprecated path, or duplicate implementation survives.
- Do not `git add`, commit, push, or delete user files unless asked.
- The application never writes engine data files and never migrates engine data formats.
- The delivery note lists the files changed, the behavior change, the checks executed, the checks not executed, and the remaining risk. Before delivering, run `pnpm check:repo` (document budgets, resolvable references, single-file size, record format) and fix every red item instead of waiving it, and confirm no debug output, temporary file, empty shell, unused dependency, unfinished placeholder, oversized file, or inconsistent naming remains.

### Verification scaffolding

A measurement rig, probe page, script, pane prompt, or raw output it produced is **not product code and does not enter the repository**:

- Scaffolding under `probe-`, `perf-`- or `.tmp-` prefixes is excluded by the root `.gitignore` **and removed from the index** (`git rm -r --cached <dir>`) — the ignore file alone is not enough.
- Raw machine output (`reports/*.json`, `*.stdout.log`, `*.stderr.log`, one-off dumps, `prompts/*.txt`) never ships. What may be kept long-term is a human-readable conclusion, outside product code.
- Before delivery, either delete the whole scaffolding directory or leave it untracked. Enumerate the ignored products with `git status --ignored`; plain `git status` cannot see them.
- A temporary worktree is removed before delivery (`git worktree remove --force`), and the note still lists the scaffolding location and whether it was kept or is safe to delete.

## Execution order

Read this file, the configuration, the source, and the call sites, and decide capability ownership as [Pre-change architecture check](#pre-change-architecture-check) says (with [Updates and upgrades](#updates-and-upgrades) whenever a version axis, the `app.sqlite` structure, the protocol, or the SDK is involved) → write a short breakdown of the requirement, architecture boundary, contract, dependencies, and risk → implement the smallest complete path, then errors, cancellation, boundaries, and resource reclamation → verify the affected surface and fix the root cause → review line counts, responsibility, permissions, performance, callers, and leftovers, and deliver by [Change and delivery](#change-and-delivery).

No stage delivers a half-finished piece, fabricated data, an empty function, an ineffective fallback, a hidden error, or a core path "to be implemented later".

## Updates and upgrades

Any installed user must reach the current version from any earlier one. Structural changes, protocol changes, and engine upgrades never damage existing data, drop fields, or leave a user stuck on "it installs but will not upgrade". The signing key custodian, the update source, and the minimum upgradable version are decided by the user before the first release.

### Version axes

Five independent axes; none substitutes for another. The current value of each lives in its definition site, never copied into this file.

| Axis | Defined in | Allowed change |
| --- | --- | --- |
| `APP_VERSION` | `package.json`, `src-tauri/Cargo.toml`, `tauri.conf.json`, `host/src/constants.ts` (`HOST_VERSION`) | Any semver step; all four agree |
| `SCHEMA_VERSION` | `src-tauri/src/services/store/schema.rs` | Increases only; each step ships its DDL, migration steps, and an upgrade test |
| `PROTOCOL_VERSION` | `host/src/constants.ts` and `src-tauri/src/services/runtime/mod.rs` | Both sides step together when a payload field's **meaning or type** changes |
| `SDK_VERSION` | `host/package.json` and `omp-host.json`'s `sdkVersion` | An upgrade is an engine upgrade — see [Dependencies](#dependencies) and [Engine upgrade and distribution](#engine-upgrade-and-distribution) |
| Plugin `schema_version` | `src-tauri/src/models/plugins.rs` | Steps when the plugin form changes; an older form is refused as `valid=false` |

Adding an optional field alone never bumps `PROTOCOL_VERSION`: that would refuse artifacts that are in fact compatible.

Four assertions hold before every release: **A1** the four `APP_VERSION` sites agree; **A2** `SCHEMA_VERSION` equals the highest defined `apply_vN` and every `N > 1` has an upgrade test; **A3** the four host artifact locations agree on `sha256` and `bytes` ([Artifact rebuild](#artifact-rebuild)); **A4** `PROTOCOL_VERSION` is equal on both sides and equals `omp-host.json.protocol`.

### Release versions and publishing

- **Semver is the release's own contract.** A `MAJOR` step is a change an older installation cannot read (a protocol or store shape that raises the minimum upgradable version), `MINOR` is a user-visible feature, and `PATCH` is a fix. The tag is `vX.Y.Z` and nothing else; the release workflow refuses a tag that disagrees with any of the four `APP_VERSION` sites.
- **A prerelease never reaches the stable feed.** `-beta.N` and `-rc.N` builds are local testing artifacts, not releases the workflow publishes: a tag carrying a prerelease suffix is refused, `latest.json` names a stable release only, and a GitHub release marked prerelease is not "latest". The updater checks exactly the one feed named in `tauri.conf.json` (this project's GitHub Releases `latest.json`) and installs only a strictly greater version.
- **One release, one signature.** The signature invariant is [Engine upgrade and distribution](#engine-upgrade-and-distribution)'s; this lane adds where its halves live: the public key in `tauri.conf.json`, the private key outside the repository (`%USERPROFILE%\.tauri\omp-desktop.key` on its custodian's machine and `TAURI_SIGNING_PRIVATE_KEY` in the release workflow), and the `.sig` beside the NSIS installer (`bundle.createUpdaterArtifacts`). Losing the private key strands every installed copy; rotating it takes a release that ships the new public key.
- **Publishing is the tag.** Bump the four sites, write the release notes, run the gates, commit, tag `vX.Y.Z`, and push the tag. The tag-triggered workflow builds the host artifact, the frontend, and the NSIS installer, then publishes the release and its `latest.json`. A manual publish performs the same steps and uploads the same files: the installer, its `.sig`, and `latest.json`. Run one build after the bump so `Cargo.lock` records the same version, and commit it with the tag.
- **Bootstrap.** The first release that carries the updater is installed by hand; every later release updates in place.
- **Who checks, and when.** A packaged build checks 15 s after start and every 6 h; a development build never does. A failed check is a status the interface words, not a hidden retry. Installing is always the user's press — the title bar's update pill or the About page — and nothing downloads or installs on its own.

### app.sqlite schema changes

- **Add, never rewrite.** A new column is NULLable or has a deterministic default. A column's name, type, unit, and meaning never change in place: a new meaning gets a new column plus a backfill, and the old one survives until the next major version.
- A primary key or unique constraint change rebuilds the table: temporary table → `INSERT ... SELECT` → `DROP` → `RENAME`, all in one transaction (the pattern is v6 in `services/store/schema.rs`).
- The **carry strategy is explicit and written into the migration function**: `carry` (a provable one-to-one), `drop-and-reask` (unprovable, and the UI can obtain it again), or `default-backfill` (a deterministic default). Rows are never dropped silently.
- A `drop-and-reask` field needs a UI path that obtains it again (plugin consent re-asking, for instance). A field with no re-ask path is never dropped.
- Every migration step is idempotent (`IF NOT EXISTS` or a shape check), because a crash can land between the DDL and the `user_version` bump. Every step and the `user_version` write share one transaction.
- A migration touches no network, subprocess, engine data, or user file. It touches `app.sqlite`.
- Every `apply_vN` has an upgrade test: build a file from that version's original DDL, open it with the current build, assert the rows survived and the shape is current.

### Startup upgrade and downgrade

- **Back up `app.sqlite` before migrating**, to a copy that can be atomically restored, with the version in its filename. The backup is a precondition, not an option.
- A failed migration restores the backup and refuses to open the main interface. No "best effort" continuation, no half-reading.
- An old build reading a file written by a newer version fails explicitly (`STORE_VERSION_TOO_NEW` semantics) with actionable text: where the backup is, to reinstall the newer version, how to reach support. Never a bare "it will not open".
- Migration happens before the host starts and with no IPC in flight. Engine data is never migrated here.

### Engine upgrade and distribution

- An SDK upgrade is an engine upgrade: update the pinned version and `omp-host.json`'s `sdkVersion`, then run the minimal "old data plus new engine" path — handshake → session list → open a historical session → one prompt.
- An update package carries three layers: the application, the embedded frontend, and the host artifact. The engine and its runtime are never downloaded or replaced at runtime, and no engine copy is written into user data.
- Update packages are signed and the client accepts only verified ones. The signing key never enters the repository, logs, or CI output.
- **Version monotonicity**: a remote version is strictly greater than the local one; re-publishing different content at one version is a release incident, and rolling back means publishing a higher version, never re-pointing the feed at an older one.
- Install replaces files and does not touch data; data migration happens on the new version's first start, per [Startup upgrade and downgrade](#startup-upgrade-and-downgrade).
- When the protocol or schema changes in a way that cannot be migrated in place, the minimum upgradable version rises and older installations take the reinstall path instead of an in-place update.

### Delivery

A change that touches a version axis, the store structure, the protocol, or the SDK states in its delivery note: the axes affected and their new values, the user's upgrade path, what happens to existing rows (carried, dropped, defaulted), the checks not executed, and the remaining risk.

Never: change DDL without bumping `SCHEMA_VERSION`; bump it without migration steps; keep two spellings of one structure; or defer a migration with "later" — which is the failed cutover [Change and delivery](#change-and-delivery) forbids.

## Boundaries, invariants, and defensive patterns

Source: the defect classes collected in the `deepseek-harness` checkout (`deepseek-harness:docs/defensive-patterns.md`, `deepseek-harness:packages/AGENTS.md`), restated for this repository. Each rule exists because the equivalent bug shipped somewhere. They supplement [Rust core](#rust-core), [State, concurrency, and reliability](#state-concurrency-and-reliability), and [Security](#security), and never relax them. A module named below is an example, not the scope.

### Validate at boundaries; trust typed same-process code

Runtime validation belongs exactly where a foreign or untyped value enters the process: Tauri command arguments, `parse` frames and every NDJSON field, engine and session files read from disk, PTY bytes, tool and model JSON, plugin manifests, URLs, clipboard paths, environment blobs. Between two functions of the same typed program, do not re-validate, default, or deep-copy a value the type system already constrains; the input checklist in [Pre-change architecture check](#pre-change-architecture-check) applies at those boundaries only. A "defensive" check there hides the real defect — a wrong caller — and buys an allocation on every path.

### Exhaustiveness follows who owns the vocabulary

A union this repository closes — a terminal frame's `kind`, a plugin form, a settings enum, an error code — is switched exhaustively and ends in `default: assertNever(x)` (add the helper in the module that needs it); the Rust side matches it without a `_ =>` arm. A union the engine or the wire keeps open (`SessionEvent`, `parse` frames, the engine vocabulary mirrored in `src/src/api/session-types.ts`) is the opposite: an unknown member is rejected and counted at the boundary, and each fold's `default` names the layer that owns the remaining members instead of pretending to cover them (`state/transcript.ts` does; a new default that does not is incomplete). Adding a member to a closed union breaks the build by design; adding one to an open union changes the fold that owns it.

### Defaulting is an explicit step in one owner

Every value that may be absent is resolved by a named step in the module that owns its meaning — `resolve(request): Spec` reads, validates, fills the default, and returns a complete spec — with the default's source written at that site. No `?? v`, `|| v`, or `unwrap_or(v)` inside the running function: such a default cannot be audited and cannot stay in sync across Rust and TypeScript. An unknown frame, command, or enum member is not a missing value and never takes a default; it is rejected and counted.

### Deployment-varying values are config, not constants

Values that differ per deployment (timeouts, concurrency, retention, paths, enabled sets) are config fields validated at load; a compile-time constant or a test hook is not configurability. Conversely, protocol constants, external specification versions, and security invariants stay fixed — a configurable security boundary is no boundary.

### Misconfiguration fails loud, at the earliest resolvable point

A self-contained configuration error fails at load. A reference that needs external state to judge (session file, workspace, plugin directory) fails at the earliest point it can be judged, with actionable text. Skipping a missing referent and continuing produces an application that starts normally and is silently crippled.

### Registrations are effects and must have a disposer

Every registration — plugin contribution, event listener, file watch, PTY, tray or menu item, IPC channel, timer — returns a disposer that can be called exactly once and is invoked by the owner of its lifetime (session close, window close, plugin unload, application exit). Each one also needs a **release test**: register, dispose, assert it left the registry and no longer receives callbacks. A test that only proves "registration succeeded" says nothing about leaks. The release points this repository already has are the template — `session-lifecycle.ts::disposeSession` in the host, the frontend's `letGo`, `stopListening`, and `closeSubagentView`, `writeGuard.forget` — and a new registration names its own release point where it is created.

### Bounds cover the complete result

Byte, item, and time limits apply to the complete emitted or retained value — wrappers, separators, metadata, and JSON braces included — not to the "payload body". Tests cover a tiny limit, a value exactly at the limit, one chunk over the limit, and multibyte text (bytes, not UTF-16 code units).

### Publish state only at its commit point

UI, derived caches, echoes, prompt fragments, and query views are published only after the operation succeeded, and all derive from one authoritative source. A failure path never leaves a state that looks successful; anything published before its result is rollback-able, and the rollback itself has a test.

### Enforce the decision in the operation that makes it

"Must not send", "must not write", and "must not escape" are refused where the operation actually executes — executor, command, service, protocol layer. Disabling a button, omitting a schema field, wording a prompt, a facade, a wrapper, or listener order is not enforcement: another call path bypasses all of them. The denial test enters through the executor and covers the alternate callers (the second `namedModel === null` guard in the composer's submit path, recorded in `src/AGENTS.md`, is this rule in practice).

### Report orthogonal outcomes independently

One result can be several things at once — a run can time out **and** exit 0, be cancelled **and** have written a file. Report each fact on its own (`timedOut`, `signal`, `exitCode`, `canceled`); never nest one flag's report inside another's branch, or a caller reads a cut-short run as success.

### Disposal must reach quiescence, not just request it

Teardown is async and waits for the work to actually stop (kill → await exit → close handles), and it deregisters listeners and notification sinks **before** killing, so a late completion stays silent instead of writing into released state. A dispose that returns before quiescence leaves orphan processes and orphan timers.

### Contain callback exceptions in the dispatcher

When dispatching to externally supplied listeners or subscribers, wrap each callback in its own `try`/`catch` and log it: one bad subscriber must not reject the promise it runs inside, nor starve the subscribers after it. `store.ts::set`'s per-subscriber `try`/`catch` is the existing implementation; a new dispatch point follows the same shape.

### Remove link-shaped paths without following them

A path that may be a symlink or a Windows junction is removed with `lstat` shape detection and then `unlink` — unlink deletes only the link and refuses a real directory, so it never descends into the target; recursive delete is reserved for confirmed real directories, because removing a junction recursively walks into its target. Scratch and temporary files land in a private directory (mode 0700) with random names and exclusive creation (`'wx'`, mode 0600): a predictable world-readable path invites symlink races and disclosure.

### An empty catch names the error and why

A swallowed exception states which class of error it is, why ignoring it is correct, and what the caller sees instead; the `try` body stays at one statement. A wide `try` with an empty `catch` swallows the next real error with it.

### Opaque cross-boundary ids are branded

Session id, workspace id, plugin id, agent ref, and task id are branded types on the TypeScript side (`type SessionId = string & { readonly __brand: 'SessionId' }`) and newtypes on the Rust side; no bare `string` for them in `src/src/api/**` or in the host protocol. An id that is added, or whose boundary is already being changed, is branded in that change; an existing plain-`string` id migrates when its surface is next touched — no drive-by sweep. Two ids that are both `string` do not fail to compile when swapped, and they write to the wrong session at runtime.

### Model-visible is logged

The engine owns the transcript: what it writes is durable by construction, and the host keeps no second account of it. Our half is what we add to a request — `@<path>` mention lines (`services/attachment_mentions.rs::mention_line`, read back by the same module's `read_prompt`), mode instructions, steering, attachment summaries. Each is reconstructable from durable state and read back by its writer, so a restart rebuilds the same request; nothing that exists only in frontend memory enters a prompt (`src/AGENTS.md` states the composer form: what is sent and what is re-read draw the same picture).

### Comments state contracts, not transcripts

Comments and JSDoc carry the non-obvious contract: preconditions, failure behavior, timing, ownership, bounds, release points, and why the obvious alternative is wrong. They do not restate the code, walk through the implementation, replay a review, or narrate "tried A, then B". A cited `file.rs::fn` or line range is part of the contract: renaming the function updates the citation in the same change.

### A capability is complete when all three roles exist

A capability ships as three parts: **definition** (the frame in `host/src/protocol/**` plus its DTO in `src-tauri/src/models/dto/**`), **provider** (the host handler or the Rust service that owns it), and **consumer** (the `src/src/api/**` wrapper plus the store that reads it). Two of three is a half-built capability. The inverse smell: a Tauri command or protocol frame with exactly one caller and no other consumer is a private helper that leaked into the contract — keep it private until a second consumer exists, and drop it when the last one goes.

## Test evidence and gate discipline

[Verification and gates](#verification-and-gates) states what must be verified. This section states which evidence counts and how to prove a check itself works (source: `deepseek-harness:docs/testing.md`).

### Match evidence to the surface

Evidence lands on the surface that changed: a behavior change runs that behavior's test or a real scenario; a protocol change runs `hello → ready → prompt → agent_end` plus the three failure paths; an artifact change runs [Artifact rebuild](#artifact-rebuild)'s checksum and embedded-asset comparison; a documentation change runs `pnpm check:repo` (budgets, references, record formats). Do not run the full suite for an unrelated change, and do not repeat a check that already passed **when nothing changed since** — any edit after a green run re-runs the layer it touched. The standing gates are never waived. This repository runs no CI on a change — the tag-triggered release workflow is the only automation — which makes the delivery note the final gate: unexecuted checks are listed one by one, and "should be fine" is not a substitute.

### Coverage is not evidence; tests describe behavior

A line that ran is not a behavior that works, and no coverage number stands in for evidence here. Every added or changed behavior carries a direct assertion on consumer-observable behavior, boundaries, errors, state transitions, and concurrency invariants — not on implementation details, source text, log wording, a bare "does not throw", a non-empty field, or a grown length. A test with no assertion, a tautology, or an assertion written to raise a count is not a test. When behavior changes on purpose, its tests change with it and the delivery note says why; keeping old behavior to keep an old test green is not an option.

### A spec that passes only when run alone is a defect in the spec

Tests run concurrently (`node --test` and `bun test` both parallelize files, and one machine also carries other agent sessions and application instances). Ports, temporary paths, global state, and child processes are owned by the test and released in teardown — including the failure, timeout, and thrown-assertion paths; shared fixtures live in a `harness.ts`-style module, never another `*.test.ts`. Island-only green is a defect to fix, not an unstable environment.

### Verify the world, not the self-report

An end-to-end assertion re-reads the world from outside: rerun the command, re-read the file, re-inspect the process or handle, take a screenshot. Searching the subject's own output lets a cheating implementation — or a self-reporting agent — turn the check green. Asserting that untouched files are byte-identical is a valid assertion too.

### A guard only guards if the regression fails it

When adding a gate or guard, run the **negative control**: introduce the regression it must catch, watch it go red, revert. A guard nobody has seen fail is unverified — which applies to `host/src/write-guard.ts`, the file-size limit, and the artifact-consistency checks as much as to a new script.

### Test the real entry path

The real entry path is the shipped artifact: `host/dist/omp-host.exe`, the copies in `src-tauri/binaries/` and `target/{debug,release}/`, the frontend embedded in `src/dist/`, and `cargo test --lib` running against the `resource.lib` that `tauri_build` wrote. A hand-assembled fixture proves the wiring moved bytes, nothing more.

### Plan coverage in the same change

Unit, scenario, and end-to-end coverage for a new capability ship with the capability; no "tests later". A missing tier is named in the delivery note with its reason.
