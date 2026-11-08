# Postmortem 0002: a bare `pnpm tauri dev` wrote into the installed app's data root
Status: resolved


## Summary

`pnpm tauri dev` was run without `--config src-tauri/tauri.dev.conf.json`. That build keeps the **installed**
application's `identifier` (`com.omp.desktop`), so it used the installed app's single-instance lock and its data root:
store, host data, engine home and WebView2 profile were the installed copy's, not a development copy's.

## Impact

Two externally visible consequences, both on the user's installed application:

- The dev process was folded by `tauri_plugin_single_instance` (the lock is keyed by identifier), so the development
  build did not start as its own application.
- The dev run registered the reserved marketplace `omp-desktop-builtin` in the installed app's engine home. The
  installed app then refused with `PLUGIN_MARKETPLACE_RESERVED`, because from the engine's point of view a marketplace
  it did not seed was holding its reserved name.

## Timeline

- The agent started the development build with the bare script, intending only to look at a UI change.
- The run wrote into `%LOCALAPPDATA%\com.omp.desktop` (the installed data root).
- The user's next installed-app start failed with `PLUGIN_MARKETPLACE_RESERVED`.

## Root cause

The identifier is the data-root key, and only the dev config file changes it. A script that looks like "start the app
in development" silently means "impersonate the installed app" unless that flag is present — and nothing in the
repository said so at the point a caller would run it.

## Fix

Development is own-identity only: `pnpm tauri:dev` (which passes `--config src-tauri/tauri.dev.conf.json`, `identifier`
= `com.omp.desktop.dev`, data root `%LOCALAPPDATA%\com.omp.desktop.dev`) is the single development entry, the bare
`pnpm tauri dev` is named as wrong, and the two data roots are documented as fully separate — store, host data, engine
home (including the reserved-marketplace row and built-in seeding) and WebView2 profile each have one copy per
identity, so both can run at once.

## Rules changed

- `rules.md#artifact-rebuild` step 1 — dev is a separate identity, not a second instance of the same app; bare `pnpm tauri dev`
  is forbidden, and the observed pollution is cited in one line.
- `AGENTS.md` dev 身份独立（强制） — one paragraph naming the flag, the identifier and the data root.
