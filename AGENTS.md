# AGENTS.md

OMP Desktop is the desktop form of omp (Stencil Labs' terminal coding agent): a Tauri 2 shell, a React/TypeScript frontend, a Rust desktop, and a host process this repository builds that embeds the official SDK. Read `rules.md` before changing anything; it owns architecture, ownership, code, protocol, resource, security, and delivery rules. This file owns the standing orders an agent needs in every session: what to read, how to build, which instance is which, and how to run things.

## Read first

- `rules.md` — the engineering specification. `src/AGENTS.md` and `src/rules.md` — the frontend landing rules (beUI is the one component library).
- <https://omp.sh/docs> and the upstream engine source are the authority on SDK behavior. Another project's implementation is reference only (`rules.md#reference-material-is-read-only`).
- `AGENTS.md` and `rules.md` are the only standing documents. Anything else a change needs is stated in code, in tests, in `notes/`, or in `postmortems/`.

## Where a fact lives

One fact, one home; everywhere else links here or there.

| Fact | Home | Not there |
|---|---|---|
| Standing orders every session needs (reading, build, instances, recipes) | this file, one to three lines each, linking its home | implementation steps, incident narratives, example code |
| Engineering rules: ownership, layering, code style, protocol, bounds, security, version axes, gates | `rules.md` | incident timelines, one-off recipes |
| Frontend landing rules | `src/AGENTS.md` (structure and behavior), `src/rules.md` (design system, file size) | Rust and desktop rules |
| Host protocol | `host/src/protocol/**`, `host/src/constants.ts`, `host/src/dispatch.ts`; decisions in `notes/` | product rules |
| A decision and what it beat | `notes/{proposed,implemented,rejected,archived}/{feature,bug-fix,simplification,architecture,process,testing}/yyyy-mm-dd-topic.md`, local-only and untracked | current behavior (that lives in `rules.md` and the source) |
| An incident | `postmortems/NNNN-topic.md` | the rule itself (link back to it) |
| Numbers that drift (frame caps, command tables, versions, directory trees) | the constant or generated artifact | hand copies into a document |

## Build and artifacts

Everything runnable here comes from a build artifact, so a source change without a rebuild is invisible. Rebuild after `host/src/**` (`pnpm host:install`), `src/src/**` (`pnpm --filter src build`), or `src-tauri/**` (`pnpm tauri:build --no-bundle`). The procedure, the instances you must close first, and the failure handling are in [`rules.md#artifact-rebuild`](rules.md#artifact-rebuild); do not ask before rebuilding.

- **Four artifact locations agree** on `sha256` and `bytes`: `host/dist/`, `src-tauri/binaries/`, `src-tauri/target/release/`, and `src-tauri/target/debug/` — compare each `omp-host.json` and confirm its `protocol` field. A host-only rebuild does not refresh `target/`; copy `omp-host.exe` and `omp-host.json` into both profiles by hand.
- **Verify the embedded frontend in the same build**: `grep -aoE "assets/main-[A-Za-z0-9_-]+\.js" src-tauri/target/release/omp_desktop.exe | sort -u` must equal `grep -oE "assets/main-[A-Za-z0-9_-]+\.js" src/dist/index.html`. Cargo skips the build script when the crate's sources did not change, so the exe keeps an older bundle while `src/dist` moves (measured 2026-10-22: `src/dist/index.html` named `main-DLm7nEue.js`, the exe still carried `main-BSgiT5uC.js`). On a mismatch, `touch src-tauri/build.rs` and rebuild. Compare only within one `tauri build`: building each layer once already yields two different hashes, so do not run `pnpm --filter src build` afterwards.
- **Never bare `cargo build --release`**: only the Tauri CLI turns on `custom-protocol`, which decides `dev`, and bare cargo writes a binary that still points at `localhost:1421`.
- State in the delivery note which layers were rebuilt and which were not.

## Engine patches

`patches/@oh-my-pi__*`, pinned by `pnpm.patchedDependencies`, are this repository's own edits to the pinned engine: the Go-transport wording behind provider retries and the mid-stream transport class that resumes a turn after committed text. Every upgrade starts by checking whether the new version ships that behaviour itself — `host/src/provider-transport-errors.test.ts` covers the classifier, and `turn-recovery.ts`'s transport class is read by hand — then deletes the patch that no longer earns its place. A patch still needed is re-created against the new version, never carried over unverified; `pnpm install` refusing to apply one is the tripwire.

## Instances

Three processes share the name and differ by `ExecutablePath`: dev (`target/debug`), a repository release build (`target/release`), and the installed copy (`%LOCALAPPDATA%\Omp Desktop\`). They are different applications; closing or rebuilding one never touches another.

- **Close only the instance occupying the profile being rebuilt**, and only after checking who started it. An instance that is an ancestor of this session (`bash → omp-host.exe → omp_desktop.exe`) is never closed by an agent — hand the close, rebuild, and restart to the user. Never close by process name: `Stop-Process -Force` by name kills the installed copy and the session's own host ([postmortem 0001](postmortems/0001-rebuild-kill-by-process-name.md)). The profile-scoped command is in [`rules.md#artifact-rebuild`](rules.md#artifact-rebuild).
- **An installed copy holds no repository file** and is never closed for a repository rebuild; it may be the user's only window.
- **Dev has its own identity**: only `pnpm tauri:dev`, which passes `--config src-tauri/tauri.dev.conf.json` (`identifier` `com.omp.desktop.dev`, data root `%LOCALAPPDATA%\com.omp.desktop.dev`). A bare `pnpm tauri dev` takes the installed identity, is folded by its single-instance lock, and pollutes its data root ([postmortem 0002](postmortems/0002-bare-tauri-dev-used-the-installed-identity.md)). In an app-hosted session the dev instance is this session's ancestor, so `target/debug` rebuilds go to the user.

## Running dev from an app-hosted session

The host gives an agent shell a cleared environment with a whitelist, with `HOME` and `USERPROFILE` pinned to the installed data root, so `pnpm tauri:dev` needs three prep steps first (measured 2026-10-10, corrected 2026-10-26):

1. `export USERPROFILE="$REAL_HOME" HOME="$REAL_HOME" SystemDrive=C:` where `REAL_HOME` is the real profile (`C:\Users\<user>`). A pinned home lands dev's data root inside the installed one; an empty `SystemDrive` makes WebView2 resolve `%SystemDrive%\ProgramData\...` relatively and create a `%SystemDrive%/` directory in the app's working directory.
2. `export RUSTUP_HOME="$REAL_HOME/.rustup" CARGO_HOME="$REAL_HOME/.cargo"`, or rustup answers "no default is configured".
3. Load the MSVC environment. Locate Visual Studio with vswhere (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) and `call "<VS>\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64`; 8.3 short paths do not resolve on every machine. Put the whole recipe in a wrapper at `%TEMP%\omp-cargo.bat` (set both homes, call `VsDevCmd.bat`, then `cargo %*`) and call `cmd /c "%TEMP%\omp-cargo.bat" test --lib`. An inline `cmd /c "call <bat> && pnpm ..."` loses the inner quotes across bash → cmd, and a path containing spaces must live in a file. Without the MSVC environment, `vswhom-sys` fails to find `cl.exe`.

## Rust tests

`cargo test --lib` runs without the manual `mt.exe` manifest injection: `src-tauri/src/lib.rs` links `tauri_build`'s `resource.lib` (`#[cfg(all(test, windows))] #[link(name = "resource", kind = "static")] extern "C" {}`), which carries the `RT_MANIFEST` activating comctl32 v6. Removing that link brings back `0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND`, which was a missing manifest binding to v5 `TaskDialogIndirect`, not an environment problem (`removed:notes/implemented/bug-fix/2026-10-26-windows-libtest-comctl32-manifest.md`). Run it through the wrapper above.

## Cross-session write guard

`write` carries no staleness check (`edit` does), so on a shared checkout it can silently overwrite another session's bytes — the only irreversible loss path here. `host/src/write-guard.ts` injects an inline extension per session (`session-activate.ts`'s `extensions`); its `tool_call` hook, at argument preparation before execution and approval, blocks `write`, `edit` or `apply_patch` when another session's write is in flight, a whole-file `write` comes from a session that never read the whole file (new files exempt), or the bytes on disk are not what this session last read whole (`sha256`; size plus mtime above 4 MiB). Comparing bytes is what holds against `bash`, an editor, a subagent, or a checkout without their cooperation; identical bytes never deadlock. A successful `tool_result` records the bytes, `turn_end` releases a turn's unreported in-flight writes (60 s TTL), and `disposeSession` calls `writeGuard.forget`.

A change to it updates `host/src/write-guard.test.ts` (with real temporary files) and passes a `write-guard` smoke scenario in the real engine, including an out-of-band write.

## Writing these documents

- **Current state only.** History belongs in `postmortems/`, `notes/`, or git. No "implemented / pending" status markers, and no assertion an implementation has already overturned.
- **Link, never restate.** Two copies of one fact drift; before writing, search a distinctive phrase and keep one home.
- **One physical line per paragraph** (soft wrap). Lists, tables, and code blocks keep their own formatting.
- **Contracts, not transcripts.** Keep the decision and its durable reason; drop "tried A, then B", implementation steps, and review conversation.
- **Emphasis is a budget.** Bold and capitals go to the clause that changes behavior; a page of bold emphasizes nothing.
- **A measured recipe carries its date and a reproducible criterion.** A recipe without a reproducible observation is a guess and is not written as a rule.
- **A reference outside this repository, or to a deleted file, carries its owner prefix** (`oh-my-pi:task/executor.ts`, `deepseek-harness:docs/testing.md`, `beui:components/previews`, `tauri:build.rs`, `removed:services/menu_popup.rs`). `pnpm check:links` skips prefixed references and validates the rest, so an unprefixed dead path is a defect.
- Code comments cite `rules.md` by anchor (`rules.md#plugin-system`), not by section number. `spec`, `plan`, and `contract` numbers in older comments cite documents deleted on 2026-10-27 and are never copied into new ones.
- A file ends with exactly one newline; run `git diff --check` before delivering.

**Slop check.** Duplicated rules (search the phrase, keep one); history outside its tier; status markers; hand-copied catalogs, inventories, or test lists; reasoning transcripts; one rationale repeated beside sibling functions; paragraph walls carrying several rules; emphasis inflation.

## Agent notes

Write one for any change to behavior, architecture, a cross-file contract, a protocol or on-disk format, the toolchain, or the test strategy, in the same change; a mechanical local edit is exempt. Updating the note that owns the decision satisfies this. A note is never rewritten into a different decision — supersede it and cross-link both. The tier's own README owns layout and format; `pnpm check:notes` enforces it. `notes/` is local-only: `.gitignore` excludes it and no clone carries it, so a note serves the machine that wrote it.

## Postmortems

`postmortems/NNNN-topic.md` is the only tier where an incident narrative belongs. `pnpm check:notes` enforces its sections (`Summary`, `Impact`, `Timeline`, `Root cause`, `Fix`, `Rules changed`). A standing document keeps one line: the rule plus `(postmortem NNNN)`. When a budget forces a choice, migrate the story there rather than growing a standing document.

## Budgets

`pnpm check:docs` reads this table and rejects a document over its ceiling. Words, matching the reference project's budgets, so a language change does not silently rewrite the budget.

| Document | Ceiling (words) |
|---|---|
| `AGENTS.md` | 1,950 |
| `rules.md` | 11,250 |
| `src/AGENTS.md` | 3,900 |
| `src/rules.md` | 300 |

On red: **relocate** content that belongs to another tier, **condense** what belongs here, then **raise** the ceiling, stating the reason in the delivery note. A ceiling that no longer fits a document that has nothing to relocate is a budget bug; raising one to hold content that should have moved is a missed relocation. Keep at least 5% headroom below a ceiling in force.

## Gates

A standing rule names its check; a rule without one decays into a suggestion.

| Check | Covers |
|---|---|
| `pnpm --filter src typecheck`, `pnpm --filter src lint` (`tsc -b`, oxlint) | Types, unused symbols, banned syntax |
| `pnpm --filter src test` (`node --test`) | Frontend pure rules and store behavior |
| `pnpm --filter src build` | `src/dist/` builds |
| `pnpm host:install` (self-verified `sha256`) | Host artifact parity |
| `cd host && bun test`, `bun run scripts/{seam-check,smoke,isolation,artifacts}.ts` | Frames, protocol, scenarios, isolation, artifact provenance |
| `cargo fmt --check`, `cargo check`, `cargo test --lib` | Rust format and behavior (through the wrapper above) |
| `host/src/write-guard.ts`, with tests | Cross-session overwrite |
| `pnpm check:repo` | Budgets, links, 1000-line limit (`scripts/file-size-allowlist.json`), note format, dependency direction (`scripts/arch-allowlist.json`), public surface |
| `git diff --check` | Whitespace |
| Review (no gate) | Architecture ownership, document tier, whether a test describes behavior, whether evidence matches the surface |

A new gate ships with its **negative control**: introduce the regression it must catch, watch it fail, revert. A guard nobody has seen fail is unverified.
