# Postmortem 0004: a rebuilt exe kept the old icon
Status: resolved


## Summary

After changing `src-tauri/icons/**`, `pnpm tauri build --no-bundle` produced an executable whose Windows resources
still carried the previous icon — all six old PNG entries present, none of the six new ones, and the two exe byte
counts identically sized.

## Impact

A visible product defect (the taskbar, title bar and installer all show the old mark) with no error anywhere: the
build succeeded, the artifact was new, and only the resource section inside it was old.

## Timeline

- Icons were replaced; `pnpm tauri build --no-bundle` was run.
- Cargo judged the crate's sources unchanged and did not re-run `build.rs`.
- The exe was stamped from the resource file `build.rs` had generated in the previous build, so it embedded the old
  icons.

## Root cause

`tauri_build::build()` emits the Windows resource list, but `bundle.icon` is not among the inputs it registers with
`rerun-if-changed`. A file that is a build input without being declared as one is an input only when something else
happens to invalidate the script.

## Fix

`src-tauri/build.rs` declares `cargo:rerun-if-changed=icons`. The diagnostic for "the icon did not change" is to
confirm that line still exists, then check whether the build script actually re-ran
(`target/{profile}/build/omp_desktop-*/invoked.timestamp`) — the same class of check the embedded-frontend comparison
applies to `src/dist`.

## Rules changed

- `rules.md#artifact-rebuild` 图标与 Windows 资源 — the `rerun-if-changed` line and the two-step diagnosis.
- `AGENTS.md` 产物内嵌前端核对（强制） — the sibling case: `tauri build` embeds `src/dist` from generated code, so a
  stale build script ships a stale frontend too.
