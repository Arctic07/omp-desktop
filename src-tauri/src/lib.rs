#![allow(linker_messages)]

mod commands;
mod errors;
mod models;
mod services;
mod state;

// The application manifest, for the lib's own test harness.
//
// `tauri_build` compiles the Windows resource next to its build script and attaches it with
// `rustc-link-arg-bins`, so the shipped binaries carry the manifest - and the manifest is what
// keeps `comctl32.dll` on the side-by-side v6 assembly. The v5 copy in System32 exports no
// `TaskDialogIndirect`, so a binary that links this crate's code without the manifest dies in the
// loader with `STATUS_ENTRYPOINT_NOT_FOUND` (`0xc0000139`) before `main` runs. The unit-test
// harness links the same code and needs the same manifest; `tauri_build` also puts that directory
// on the native search path, which is what makes this `#[link]` resolve.
//
// It is `cfg(test)` on purpose: cargo has no "link this into the lib test harness" flag (the
// `-tests` attribute only covers integration test targets, and this package has none), and handing
// the resource to every target compiles a second `VERSION`/manifest into the bins, which fails the
// link with `CVT1100: duplicate resource`.
#[cfg(all(test, windows))]
#[link(name = "resource", kind = "static")]
extern "C" {}

use std::sync::Arc;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // The single instance is the one that owns the store, the host and the tray; a second
        // launch is ended inside this plugin's own setup - before `setup` below - so it opens no
        // store, starts no host and builds no tray. What the user gets instead is the window that
        // is already running, brought to the front.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            services::presence::show_main_window(app);
            services::log::info("a second launch was folded into this one: the window was shown");
        }))
        .plugin(tauri_plugin_dialog::init())
        // The OS half of a plugin page's `notify` (spec §6.2). The host decides whether the user is
        // looking at the window before it hands a notice to the system, so this plugin is registered
        // for the host's own use - no capability names it, and no webview can call it.
        .plugin(tauri_plugin_notification::init())
        // The application's own updates (`services::updater`): the plugin is registered for that
        // service alone. No capability names its commands, so no document can reach the updater
        // directly; the interface goes through this application's own update commands.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // What the webview stack may hand a document (see `services::permissions`): the application
        // asks for no device, and a plugin window asks for nothing at all.
        .on_permission_request(|_webview, kind| services::permissions::for_application(kind))
        // The plugin pages' one asset origin (spec §7.2): a custom scheme registered for every
        // webview, answered from `services::plugins::pages` and `services::plugins::protocol`. It is
        // registered before any window exists, and every plugin window and every docked page loads
        // its files through it - which is what lets a disabled plugin stop being served at all.
        .register_asynchronous_uri_scheme_protocol(
            services::plugins::pages::PLUGIN_SCHEME,
            |ctx, request, responder| {
                services::plugins::protocol::handle(
                    ctx.app_handle(),
                    ctx.webview_label(),
                    &request,
                    responder,
                );
            },
        )
        // The slot modules' fixed host (plan §D2): one name per installation, served from
        // `services::plugins::renderer` and imported by the main document through `script-src`'s two
        // fixed sources in `tauri.conf.json`. It is a second scheme rather than a second path under
        // `omp-plugin` because the page origin's host is the installation key, and a CSP host source
        // cannot wildcard a middle label.
        .register_asynchronous_uri_scheme_protocol(
            services::plugins::renderer::SCHEME,
            |ctx, request, responder| {
                services::plugins::renderer::handle(ctx.app_handle(), &request, responder);
            },
        )
        .setup(|app| {
            // Before anything can locate the host: a packaged bundle lives in the resource
            // directory, which only the framework knows (the exe's directory on Windows,
            // `Contents/Resources` on macOS, `/usr/lib/<product>` on Linux).
            if let Ok(directory) = app.path().resource_dir() {
                services::host_bin::set_resource_dir(directory);
            }
            // An earlier installation may have left the retired compiled host and its backups
            // beside this executable. Both layouts are known by now, so the sweep can tell which
            // one is current; see `services::residue` for the allowlist it is held to.
            if let Ok(exe) = std::env::current_exe() {
                if let Some(directory) = exe.parent() {
                    let bundle_present = directory.join("bundle").join("manifest.json").is_file()
                        || app
                            .path()
                            .resource_dir()
                            .map(|resources| {
                                resources.join("bundle").join("manifest.json").is_file()
                            })
                            .unwrap_or(false);
                    services::residue::sweep_installation(directory, bundle_present);
                }
            }
            let state = match state::AppState::new(app.handle()) {
                Ok(state) => state,
                Err(error) => {
                    // No window exists to carry this yet and nothing of the record is reachable:
                    // the one report a start that cannot open its own data gets is the operating
                    // system's own dialog, and the process then leaves instead of running against
                    // data it does not understand (`rules.md#startup-upgrade-and-downgrade`).
                    services::startup::report_fatal(&error);
                    app.handle().exit(1);
                    return Ok(());
                }
            };
            // The tray is built before the state is handed over: it needs the presence flags the
            // close hook later reads, and `setup` is the main thread tauri wants for it.
            let presence = Arc::clone(&state.presence);
            // The surface the window is painted in before its document exists: the appearance
            // setting the front end pushed at its last start, resolved against the operating
            // system's theme while the window exists. Both the window's brush and the webview's own
            // default surface are painted with it, so nothing flashes white before the first frame.
            let surface = services::appearance::load(&state.store).background(
                services::presence::main_window(app.handle())
                    .is_some_and(|window| services::appearance::system_dark(&window)),
            );
            // The automatic update check starts after the window and its state exist: it publishes
            // through `omp:update`, and a document that mounts later reads the same value from
            // `update_status`.
            let updater = Arc::clone(&state.updater);
            app.manage(state);
            updater.start_auto_checks(app.handle().clone());
            services::presence::install_tray(app.handle(), &presence);
            // The window is created hidden (tauri.conf.json) so nothing is on screen before this
            // color is set. It is set through the webview window, which paints both surfaces: the
            // webview covers the Win32 window's brush, so the brush alone leaves WebView2's default
            // surface - white - showing until the document's first frame. The color is the
            // appearance setting the front end pushed at its last start, which is the one the
            // document is about to paint itself; with no record the operating system's theme
            // answers instead, as the closest guess available before any script has run. The
            // document covers this the moment it loads, so a stored setting that disagrees with
            // the system is only wrong for that one frame.
            if let Some(window) = services::presence::main_webview_window(app.handle()) {
                if let Err(error) = window.set_background_color(Some(surface)) {
                    services::log::warn(&format!(
                        "painting the window background before the front end loads failed: {error}"
                    ));
                }
            }
            // The window is not shown here: its own document shows it once the start-up shell in
            // `index.html` has painted (`main_window_ready`, sent by `src/main.tsx`), because a
            // window shown before its webview has anything to paint puts WebView2's own white on
            // screen for a frame - the flash every start opened on (2026-10-20). The ceiling armed
            // below is what keeps a start whose bundle never runs from leaving the process with no
            // window at all.
            services::presence::arm_main_window_ceiling(app.handle());
            // The one thread nothing else watches. A window the system has to paint "not
            // responding" over leaves a line in `app.log` saying how long it was silent, which is
            // the only evidence a hang produces (`rules.md#main-thread-budget`).
            services::main_thread_watch::watch(app.handle());
            // The window's own file drop: on Windows this replaces Tauri's target with one that
            // reads the paths a Chromium editor drags out as well as a file list (see
            // `services::file_drop`). It has to run after the window exists and before the first
            // drag can, and it leaves every other platform on Tauri's own handler.
            services::file_drop::install(app.handle());
            // Take the find accelerators (`Ctrl+F`, `Ctrl+G`, `Ctrl+Shift+G`, `F3`, `Shift+F3`)
            // away from the main window's webview; the file preview and the work column answer the
            // chords they own, and nothing answers the rest (see `services::webview_keys`).
            services::webview_keys::release_find_keys(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // The strip's menu popup closes when it loses focus or is closed: the reader clicked
            // elsewhere (that click's own work belongs to wherever they clicked), or dismissed it
            // with its own title bar. The popup is focusable enough to learn it lost focus - the
            // main window keeps the keyboard the whole time - and the flag is what makes the next
            // show start from hidden rather than trusting the last rectangle.
            match event {
                // Coming back to the window is what answers the taskbar's "finished" mark: the
                // flash stops on its own, and the green overlay badge is ours to drop.
                tauri::WindowEvent::Focused(true)
                    if window.label() == services::presence::MAIN_WINDOW =>
                {
                    services::presence::clear_attention(window.app_handle());
                }
                _ => {}
            }
            // A plugin window that is gone is forgotten here, whatever closed it - the user's own
            // click, a plugin's `close` bridge call, or a plugin that stopped running. The registry
            // is what the window ceiling is counted from, so an entry left behind would keep the
            // limit occupied for the rest of the run.
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.app_handle().state::<state::AppState>();
                state.panels.forget(window.label());
            }
            // A close request is the one place the residency preference is acted on: when it says
            // the window may go away and leave the process running, the close is turned into a
            // hide. A hide that fails leaves the window on screen - the state the user can still
            // act on, since the request itself was already prevented.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.app_handle().state::<state::AppState>();
                if state.presence.hides_on_close() {
                    api.prevent_close();
                    // macOS keeps a native full-screen window in a Space of its own, and hiding it
                    // there leaves an empty black Space behind: this click leaves full screen
                    // instead, and the next one hides the window. The reference client guards the
                    // same case the same way. Compiled out on every other platform.
                    #[cfg(target_os = "macos")]
                    if window.is_fullscreen().unwrap_or(false) {
                        if let Err(error) = window.set_fullscreen(false) {
                            services::log::warn(&format!(
                                "leaving full screen before hiding the window failed: {error}"
                            ));
                        }
                        return;
                    }
                    if let Err(error) = window.hide() {
                        services::log::warn(&format!(
                            "hiding the window to the tray failed: {error}"
                        ));
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::attachments::import_composer_files,
            commands::attachments::resolve_clipboard_file_paths,
            commands::attachments::save_composer_paste,
            commands::clipboard::copy_text_and_files,
            commands::clipboard::read_clipboard_text,
            commands::diagnostics::logs_overview,
            commands::diagnostics::logs_open_directory,
            commands::diagnostics::logs_clear,
            commands::diagnostics::caches_clear,
            commands::diagnostics::logs_write,
            commands::workspace::current_working_directory,
            commands::workspace::list_workspace_entries,
            commands::workspace::read_workspace_file,
            commands::workspace::read_external_file,
            commands::workspace::reveal_workspace_entry,
            commands::workspace::open_directory_in_file_manager,
            commands::workspace::write_workspace_file,
            commands::workspace::search_workspace_files,
            commands::workspace::search_workspace_paths,
            commands::workspace::set_workspace_watch,
            commands::git::draft_commit_message,
            commands::git::get_workspace_branches,
            commands::git::checkout_workspace_branch,
            commands::git::get_workspace_review,
            commands::git::stage_workspace_files,
            commands::git::unstage_workspace_files,
            commands::git::discard_workspace_files,
            commands::git::commit_workspace,
            commands::git::sync_workspace,
            commands::runtime::runtime_status,
            commands::runtime::runtime_restart,
            commands::runtime::engine_models,
            commands::runtime::engine_model_roles,
            commands::runtime::engine_role_candidates,
            commands::runtime::engine_set_model_role,
            commands::runtime::engine_warm,
            commands::runtime::engine_data_paths,
            commands::capabilities::engine_skills,
            commands::capabilities::engine_skills_set,
            commands::capabilities::engine_mcp,
            commands::capabilities::engine_mcp_set_enabled,
            commands::capabilities::engine_mcp_upsert,
            commands::capabilities::engine_mcp_remove,
            commands::capabilities::engine_memory,
            commands::capabilities::engine_memory_action,
            commands::capabilities::engine_memory_catalog,
            commands::capabilities::engine_memory_reveal,
            commands::capabilities::engine_usage,
            commands::capabilities::engine_compaction_status,
            commands::capabilities::engine_compaction_set_enabled,
            commands::capabilities::engine_compaction_set_options,
            commands::capabilities::engine_rules,
            commands::capabilities::engine_rules_set,
            commands::mcp_import::mcp_import_scan,
            commands::mcp_import::mcp_import_apply,
            commands::omp_import::omp_import_probe,
            commands::omp_import::omp_import_scan,
            commands::omp_import::omp_import_apply,
            commands::omp_import::omp_import_dismiss,
            commands::plugins::engine_plugins,
            commands::plugins::engine_plugin_install,
            commands::plugins::engine_plugin_install_package,
            commands::plugins::engine_plugin_install_url,
            commands::plugins::engine_plugin_inspect_package,
            commands::plugins::engine_plugin_scaffold,
            commands::plugins::engine_plugin_uninstall,
            commands::plugins::engine_plugin_set_enabled,
            commands::plugins::engine_plugin_upgrade,
            commands::plugins::engine_plugin_update_switch,
            commands::plugins::engine_plugin_check_updates,
            commands::plugins::engine_plugin_engine_info,
            commands::plugins::engine_plugin_config,
            commands::plugins::engine_plugin_config_set,
            commands::plugins::engine_plugin_config_reset,
            commands::plugins::engine_plugin_reload,
            commands::plugins::engine_plugin_grants,
            commands::plugins::engine_plugin_grant_set,
            commands::plugin_process::engine_plugin_process,
            commands::plugin_process::engine_plugin_process_restart,
            commands::plugin_process::engine_plugin_command_run,
            commands::plugin_process::engine_plugin_activate,
            commands::plugin_process::engine_plugin_renderer_call,
            commands::plugins::engine_builtin_plugins,
            commands::plugins::engine_builtin_restore,
            commands::plugin_pages::engine_plugin_panel_open,
            commands::plugin_pages::plugin_prompt_answer,
            commands::plugin_pages::engine_plugin_workspace_set,
            commands::plugins::plugin_task_cancel,
            commands::plugin_marketplaces::engine_marketplaces,
            commands::plugin_marketplaces::engine_marketplace_add,
            commands::plugin_marketplaces::engine_marketplace_plugins,
            commands::plugin_marketplaces::engine_marketplace_remove,
            commands::plugin_marketplaces::engine_marketplace_update,
            commands::plugin_marketplaces::engine_marketplaces_refresh,
            commands::open_in_app::open_in_app_apps,
            commands::open_in_app::open_in_app_icon,
            commands::open_in_app::open_in_app_launch,
            commands::system::open_external,
            commands::terminal::terminal_open,
            commands::terminal::terminal_list_live,
            commands::terminal::terminal_attach,
            commands::terminal::terminal_tail,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_label_set,
            commands::terminal::terminal_close,
            commands::terminal::terminal_close_session,
            commands::terminal::terminal_close_workspace,
            commands::update::update_status,
            commands::update::update_check,
            commands::update::update_install,
            commands::update::update_relaunch,
            commands::browser::browser_open_tab,
            commands::browser::browser_navigate,
            commands::browser::browser_show_tab,
            commands::browser::browser_set_bounds,
            commands::browser::browser_set_visible,
            commands::browser::browser_action,
            commands::browser::browser_get_state,
            commands::browser::browser_pages,
            commands::browser::browser_open_external,
            commands::browser::browser_close_tab,
            commands::browser::browser_close_session,
            commands::workspaces::workspace_list,
            commands::workspaces::workspace_add,
            commands::workspaces::workspace_rename,
            commands::workspaces::workspace_remove,
            commands::workspaces::workspace_touch,
            commands::workspaces::workspace_reorder,
            commands::sessions::session_list,
            commands::sessions::session_children,
            commands::sessions::session_search,
            commands::sessions::session_open,
            commands::sessions::session_close,
            commands::sessions::session_delete,
            commands::sessions::session_watch,
            commands::sessions::child_watch,
            commands::sessions::session_history,
            commands::sessions::session_prompt,
            commands::sessions::session_abort,
            commands::sessions::session_force_stop,
            commands::sessions::session_stop_job,
            commands::sessions::session_set_model,
            commands::sessions::session_set_thinking,
            commands::sessions::session_rename,
            commands::sessions::session_ui_respond,
            commands::sessions::session_branch_points,
            commands::sessions::session_branch,
            commands::sessions::session_rewind,
            commands::sessions::session_branch_from,
            commands::sessions::session_read_marks,
            commands::sessions::session_mark_read,
            commands::sessions::session_set_pinned,
            commands::sessions::session_set_archived,
            commands::sessions::session_order_get,
            commands::sessions::session_order_set,
            commands::providers::provider_list,
            commands::providers::provider_keys_apply,
            commands::providers::provider_clear_key,
            commands::presence::presence_get,
            commands::presence::presence_set,
            commands::presence::main_window_ready,
            commands::presence::flash_taskbar,
            commands::presence::app_background,
            commands::appearance::startup_theme_get,
            commands::appearance::startup_theme_set,
            commands::presence::tray_language_set,
            commands::custom_providers::custom_provider_list,
            commands::custom_providers::custom_provider_save,
            commands::custom_providers::custom_provider_remove,
            commands::custom_providers::custom_provider_fetch_models,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the OMP Desktop application")
        .run(|app, event| {
            // The host is a separate process: leaving it behind would leave a program holding the
            // session files, so the application's own exit asks it to leave and waits briefly.
            if let tauri::RunEvent::Exit = event {
                // One shutdown sequence, shared with the updater's Windows exit hook: the host and
                // every child this process owns end before the run's closing log line.
                services::shutdown::run(app);
            }
            // macOS keeps no tray, so the Dock is the way back to a hidden window: without this
            // the window would stay hidden while the application is still running.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                services::presence::show_main_window(app);
            }
        });
}
