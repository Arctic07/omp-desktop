# Postmortem 0003: a rebuilt host left a stale copy in `target/release`
Status: resolved


## Summary

After `pnpm host:install`, the copy of the host that the desktop actually launches from `src-tauri/target/release/`
was still the previous build: `pnpm tauri build --no-bundle` does not refresh `omp-host.exe` + `omp-host.json` there.
The application (protocol 19) spawned a host answering protocol 18, refused the handshake, and would not start.

## Impact

A release build that looked complete could not run. The refusal surfaced as a startup failure with an engine-protocol
code, which reads like a code defect in the change under test — the actual condition was a stale artifact two
directories away from the one that had been rebuilt.

## Timeline

- `host/src/**` changed; `pnpm host:install` was run and reported its own `sha256` self-check green.
- The release application was launched from `target/release/` without refreshing its host copy.
- The handshake was refused: the desktop's `PROTOCOL_VERSION` and `omp-host.json.protocol` disagreed.

## Root cause

The build flow has four places a host binary lives (`host/dist/`, `src-tauri/binaries/`, `target/release/`,
`target/debug/`), and only some of them are written by each command. The sync of the two `target/` copies was assumed
to be part of `tauri build`; it is only part of `tauri:dev`.

## Fix

The four copies are the verification unit: after a rebuild their `sha256` and `bytes` must match (read from each
`omp-host.json`), and `protocol` must equal the desktop's `PROTOCOL_VERSION`. When only the host was rebuilt, the
binary and its manifest are copied by hand into both `target/` profiles — the pair from one build, both `builtAt` and
`sha256` from the same source. Which layers were rebuilt and which were not is stated in the delivery note.

## Rules changed

- `rules.md#artifact-rebuild` step 5 + **验证** — the `target/` copies are refreshed by hand after a host-only rebuild, and the
  four-copy `sha256` comparison is the gate.
- `AGENTS.md` 构建规则 — the rebuild sequence and the "rebuild which layer, report which layer" sentence.
