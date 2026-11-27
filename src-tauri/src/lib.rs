mod agent;
mod cli_sessions;
mod computer;
mod cookie_import;
mod device;
mod error;
mod fswatch;
mod headless;
mod identifier;
mod keep_awake;
mod logs_export;
mod lsp;
mod mcp_host;
mod mods;
mod music;
mod nav_guard;
mod plans;
mod preview_cdp;
mod preview_frames;
mod preview_webview;
mod project_paths;
mod pty;
mod quick_window;
mod rag;
mod remote;
#[cfg(test)]
mod security_config;
mod test_data_dir;
mod update_prep;
mod video;
mod walk;
mod worktree;

#[cfg(windows)]
pub use agent::detach_helper_main;
pub use agent::{mcp_proxy_main, MCP_PROXY_FLAG};

/// Writes where the window is to disk now. Called right before an update installs: on Windows
/// the installer ends the app without the normal exit that would otherwise save it, and the
/// relaunched app would open on the primary monitor again.
#[tauri::command]
fn save_window_state(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_window_state::{AppHandleExt, StateFlags};
    app.save_window_state(StateFlags::all() - StateFlags::FULLSCREEN)
        .map_err(|e| e.to_string())
}

const MAIN_LABEL: &str = "main";

/// How long the normal exit (and its cleanup in `RunEvent::Exit`) gets before the process is
/// ended anyway.
const EXIT_GRACE: std::time::Duration = std::time::Duration::from_secs(8);

/// Closing the main window is closing Nyxs. Tauri only exits once every window is gone, and the
/// quick-prompt window lives hidden for the whole session (built at start-up so the shortcut
/// opens it instantly), so on its own the process stayed alive with no window at all. Ask for
/// the normal exit, which runs the cleanup below and saves the window state, and keep a watchdog
/// in case something still holds the process.
fn exit_after_main_closed(app: &tauri::AppHandle) {
    std::thread::spawn(|| {
        std::thread::sleep(EXIT_GRACE);
        log::warn!("the app didn't exit {EXIT_GRACE:?} after its window closed; ending it");
        std::process::exit(0);
    });
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First: a test run (NYXS_DATA_DIR) points every data folder at its own before anything
    // reads them.
    test_data_dir::isolate();
    // Before the builder: its plugins and the main window's WebView open their data folders.
    identifier::migrate_folders();
    agent::allow_local_powershell_scripts();
    agent::warm_shell_env();
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // Where the window was: its size, position and monitor, saved on exit and restored on
        // start. Without it every launch opened maximized on the primary monitor, including the
        // relaunch after an update, so on a two-screen desk the app jumped screens by itself.
        // Registered before the updater so the state is back when an update relaunches the app.
        // Full screen is left out: a launch must never come back stuck in it. The quick-prompt
        // window is left out too: it is built hidden at start-up and only shown by its
        // shortcut, and restoring its saved visibility popped it open on its own after updates.
        // A test run leaves the main window out as well: the restore shows and focuses it, which
        // would pull it back over the user's work (see `test_data_dir::move_window_off_screen`).
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .with_denylist(if test_data_dir::active() {
                    &[quick_window::QUICK_LABEL, MAIN_LABEL][..]
                } else {
                    &[quick_window::QUICK_LABEL][..]
                })
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // A reload of the app hides the browser's websites as soon as it starts: the page-load
        // event below only comes once the new page's content loads, when the splash is already
        // up and the websites (drawn over everything) still showed on top of it.
        // It also keeps the main window on the app's own pages (see `nav_guard`).
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("nyxs-reload-guard")
                .on_navigation(|webview, url| {
                    if webview.label() != MAIN_LABEL {
                        return true;
                    }
                    let app_url = nav_guard::app_url(tauri::Manager::config(webview));
                    if !app_url
                        .as_ref()
                        .is_some_and(|app| nav_guard::main_may_open(url, app))
                    {
                        // macOS also asks about iframes (see `main_iframe_may_open`); those
                        // aren't a reload, so the websites stay where they are.
                        if nav_guard::main_iframe_may_open(url) {
                            return true;
                        }
                        log::warn!("blocked the main window from navigating to {url}");
                        return false;
                    }
                    let app = tauri::Manager::app_handle(webview).clone();
                    tauri::async_runtime::spawn(async move {
                        preview_webview::hide_all_for_reload(&app)
                    });
                    true
                })
                .build(),
        )
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::ThemeChanged(_) => {
                preview_webview::reapply_scheme(tauri::Manager::app_handle(window));
            }
            tauri::WindowEvent::Destroyed if window.label() == MAIN_LABEL => {
                exit_after_main_closed(tauri::Manager::app_handle(window));
            }
            _ => {}
        })
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && payload.event() == tauri::webview::PageLoadEvent::Started
            {
                let app = tauri::Manager::app_handle(webview).clone();
                tauri::async_runtime::spawn(async move {
                    preview_webview::hide_all_for_reload(&app);
                    agent::drop_pending_requests();
                    agent::claude_code_detach_all();
                    agent::agent_cli_detach_all();
                    video::player_mark_all_idle();
                });
            }
        })
        .register_asynchronous_uri_scheme_protocol("nyxspreview", |ctx, request, responder| {
            let webview = ctx.webview_label().to_string();
            tauri::async_runtime::spawn(async move {
                responder.respond(agent::proxy_preview(&webview, request).await);
            });
        })
        .invoke_handler(tauri::generate_handler![
            save_window_state,
            agent::agent_read_file,
            agent::agent_read_file_range,
            agent::agent_read_text,
            agent::agent_path_exists,
            agent::agent_file_mtime,
            agent::agent_write_file,
            plans::plan_write,
            agent::agent_edit_file,
            agent::agent_multi_edit,
            agent::agent_delete_file,
            agent::nyxs_copy_managed_dir,
            agent::nyxs_remove_managed_dir,
            agent::agent_glob,
            agent::agent_grep,
            agent::agent_run,
            agent::agent_run_cancel,
            agent::agent_run_to_background,
            agent::agent_git,
            agent::agent_exec,
            agent::agent_run_background,
            agent::agent_bg_output,
            agent::agent_bg_kill,
            agent::agent_shell_info,
            agent::agent_bg_list,
            agent::agent_bg_clear,
            agent::agent_wait_for_server,
            agent::agent_open_external,
            agent::agent_open_path,
            agent::agent_reveal_path,
            agent::agent_editors,
            agent::agent_open_in_editor,
            agent::agent_fetch_html,
            agent::agent_set_preview_root,
            agent::agent_preview_config_read,
            agent::agent_preview_config_write,
            agent::agent_preview_sites,
            agent::agent_forget_preview_sites,
            agent::preview_mockup_put,
            agent::preview_mockup_save,
            preview_webview::preview_open,
            preview_webview::preview_set_bounds,
            preview_webview::preview_hide,
            preview_webview::preview_set_holes,
            preview_webview::preview_set_dim,
            preview_webview::preview_set_theme,
            preview_webview::preview_claim,
            preview_webview::preview_reload,
            preview_webview::preview_history,
            preview_webview::preview_close,
            preview_webview::preview_clear_data,
            cookie_import::browser_cookie_sources,
            cookie_import::browser_cookie_sites,
            cookie_import::browser_cookie_import,
            preview_webview::preview_capture,
            preview_webview::preview_capture_png,
            preview_webview::preview_agent_status,
            preview_webview::preview_pick,
            preview_webview::preview_agent_run,
            keep_awake::keep_awake_set,
            keep_awake::keep_awake_get,
            preview_webview::default_browser_name,
            agent::agent_set_path_scope,
            agent::agent_add_path_scope,
            agent::agent_remove_path_scope,
            agent::agent_allow_ui_path,
            agent::agent_list_dir,
            fswatch::fs_watch_start,
            fswatch::fs_watch_stop,
            agent::path_is_dir,
            agent::agent_list_files,
            agent::agent_list_skills,
            agent::agent_read_memory,
            agent::agent_read_claude_memory,
            agent::nyxs_read_text,
            mods::mods_fs_stat,
            agent::agent_fh_backup,
            agent::agent_shadow_snapshot,
            agent::agent_shadow_changed,
            agent::agent_shadow_restore,
            agent::agent_shadow_read,
            agent::agent_fh_origin_changed,
            agent::agent_fh_restore,
            agent::agent_fh_hash,
            agent::agent_fh_read_backup,
            agent::agent_review_read,
            agent::agent_review_write,
            agent::agent_review_save,
            agent::agent_review_load,
            agent::agent_read_pdf,
            agent::agent_read_pdf_text,
            agent::agent_read_image,
            agent::agent_read_upload,
            agent::agent_read_model,
            agent::agent_prepare_video,
            computer::computer_screenshot,
            computer::computer_act,
            computer::computer_windows,
            computer::computer_focus,
            computer::computer_window_state,
            computer::computer_element,
            computer::computer_set_label,
            computer::computer_release,
            computer::permissions::computer_permissions,
            computer::permissions::computer_request_permission,
            agent::agent_read_video,
            agent::agent_write_pdf,
            agent::agent_html_to_pdf,
            agent::nyxs_set_account,
            agent::nyxs_adopt_account_data,
            agent::nyxs_load_chats,
            agent::nyxs_load_chat_index,
            agent::nyxs_save_chat_index,
            agent::nyxs_load_chat,
            agent::nyxs_save_chat,
            agent::nyxs_delete_chat,
            agent::nyxs_session_append,
            agent::nyxs_session_write_transcript,
            agent::nyxs_session_write_meta,
            agent::nyxs_session_read,
            agent::nyxs_session_read_meta,
            agent::nyxs_session_delete,
            agent::nyxs_list_sessions,
            agent::nyxs_search_sessions,
            agent::nyxs_cleanup_old_sessions,
            agent::nyxs_project_hubs_list,
            agent::nyxs_project_hubs_save,
            agent::nyxs_project_hubs_delete,
            agent::nyxs_project_hub_memory_read,
            agent::nyxs_project_hub_memory_write,
            agent::nyxs_project_hub_dir,
            agent::nyxs_project_hub_files,
            agent::nyxs_project_hub_add_files,
            agent::nyxs_project_hub_remove_file,
            agent::nyxs_read_settings,
            agent::nyxs_write_settings,
            agent::nyxs_secret_get,
            agent::nyxs_secret_set,
            agent::nyxs_secret_delete,
            agent::nyxs_save_attachment,
            agent::nyxs_notify,
            agent::oauth_reserve,
            agent::oauth_wait,
            agent::oauth_cancel,
            agent::claude_code_status,
            agent::claude_code_initialize,
            agent::claude_code_list_models,
            agent::claude_code_update,
            agent::claude_code_remote_status,
            agent::claude_code_remote_install,
            agent::claude_code_remote_update,
            agent::claude_code_remote_login_start,
            agent::claude_code_remote_login_wait,
            agent::claude_code_remote_login_code,
            agent::claude_code_remote_login_cancel,
            agent::claude_code_keep_login_fresh,
            agent::claude_code_runs,
            agent::claude_code_attach,
            agent::claude_code_usage,
            agent::claude_code_default_effort,
            agent::claude_code_context_baseline,
            agent::claude_code_open_terminal,
            agent::claude_code_start,
            agent::claude_code_send,
            agent::claude_code_close_input,
            agent::claude_code_kill,
            agent::claude_code_task_output,
            agent::agent_cli_status,
            agent::agent_cli_models,
            agent::agent_cli_open_terminal,
            agent::agent_cli_start,
            agent::agent_cli_send,
            agent::agent_cli_close_input,
            agent::agent_cli_kill,
            agent::agent_cli_register_mcp,
            agent::agent_cli_runs,
            agent::agent_cli_attach,
            agent::agent_cli_antigravity_permissions,
            agent::agent_cli_usage,
            agent::cli_accounts_list,
            agent::cli_accounts_activate,
            agent::cli_accounts_forget,
            agent::cli_accounts_add_start,
            agent::cli_accounts_add_poll,
            agent::cli_accounts_add_cancel,
            agent::cli_install,
            agent::cli_install_cancel,
            agent::agent_port_listeners,
            agent::agent_stop_port,
            agent::agent_free_port,
            agent::mcp_bridge_start,
            agent::hosted_mcp_reply,
            device::device_info,
            pty::term_open,
            pty::term_attach,
            pty::term_write,
            pty::term_resize,
            pty::term_close,
            pty::term_busy,
            rag::rag_collect_chunks,
            rag::rag_store,
            rag::rag_stats,
            rag::rag_search,
            lsp::lsp_ensure_server,
            lsp::lsp_dispose_workspace,
            lsp::lsp_did_open,
            lsp::lsp_did_change,
            lsp::lsp_diagnostics_wait,
            lsp::lsp_hover,
            lsp::lsp_definition,
            lsp::lsp_references,
            lsp::lsp_document_symbols,
            lsp::lsp_provision,
            worktree::worktree_create,
            worktree::worktree_remove,
            worktree::session_worktree_create,
            worktree::session_worktree_remove,
            worktree::session_worktrees_measure,
            logs_export::nyxs_export_logs,
            cli_sessions::claude_cli_sessions,
            cli_sessions::claude_cli_session_read,
            logs_export::nyxs_log_frontend,
            worktree::worktree_list,
            worktree::worktree_export_patch,
            worktree::worktree_check_patch,
            worktree::worktree_apply_patch,
            worktree::worktree_supported,
            quick_window::quick_hide,
            quick_window::quick_submit,
            mcp_host::mcp_stdio_start,
            mcp_host::mcp_stdio_request,
            mcp_host::mcp_stdio_stop,
            headless::nyxs_headless_args,
            headless::nyxs_headless_write,
            headless::nyxs_headless_exit,
            headless::nyxs_headless_save_session,
            remote::askpass::ssh_askpass_answer,
            remote::node::remote_project_check,
            remote::node::remote_node_install_command,
            remote::commands::remote_config_hosts,
            remote::commands::remote_connect,
            remote::commands::remote_disconnect,
            remote::commands::remote_forward,
            remote::commands::remote_home,
            remote::commands::remote_list_folders,
            remote::commands::remote_create_folder,
            music::music_scan_folder,
            music::music_allow_track,
            music::music_track_cover,
            music::music_page_run,
            music::music_system_state,
            music::music_system_cover,
            music::music_system_control,
            video::video_check_env,
            video::video_runtime_status,
            video::video_runtime_install,
            video::video_list_projects,
            video::video_delete_project,
            video::video_rename_project,
            video::video_duplicate_project,
            video::video_reveal_project,
            video::video_create_project,
            video::video_install,
            video::video_player_start,
            video::video_player_stop,
            video::video_player_kill,
            video::video_read_timeline,
            video::video_write_timeline,
            video::video_import_media,
            video::video_list_media,
            video::video_thumbnails,
            video::video_waveform,
            video::video_render,
            video::video_render_cancel,
            video::video_still,
            video::video_open_output,
            video::video_create_from_media,
            video::video_adopt_project,
            video::video_detect_silences,
            video::video_extract_audio,
            video::video_asset_frame,
            video::video_contact_sheet,
            video::video_proxy,
            video::video_record,
            video::video_music,
            video::video_tool_cancel,
            video::video_export_standalone,
            video::video_convert_to_light,
            video::video_stage_file,
            update_prep::nyxs_prepare_update,
            update_prep::nyxs_update_install_failed,
        ])
        .setup(|app| {
            test_data_dir::check_identifier(&app.config().identifier);
            test_data_dir::move_window_off_screen(app.handle(), MAIN_LABEL);
            // Development logs to the terminal too; a release keeps a small rotating log file
            // (2 MB × 4), which Diagnostics › Save logs zips for support.
            {
                use tauri_plugin_log::{RotationStrategy, Target, TargetKind};
                let log = tauri_plugin_log::Builder::default().level(log::LevelFilter::Info);
                let log = if cfg!(debug_assertions) {
                    log
                } else {
                    log.clear_targets()
                        .target(Target::new(TargetKind::LogDir { file_name: None }))
                        .max_file_size(2_000_000)
                        .rotation_strategy(RotationStrategy::KeepSome(4))
                };
                app.handle().plugin(log.build())?;
            }
            identifier::log_migration();

            lsp::init_paths(app.handle());
            remote::init(app.handle());
            agent::init_path_roots(app.handle());
            if headless::is_headless() {
                if let Some(w) = tauri::Manager::get_webview_window(app, "main") {
                    let _ = w.hide();
                }
                return Ok(());
            }
            #[cfg(desktop)]
            {
                // A test run (NYXS_DATA_DIR) leaves the desktop's shortcuts alone, and so has no
                // use for the quick window, whose start-up build took the foreground.
                if !test_data_dir::active() {
                    quick_window::register_shortcut(app.handle());
                    quick_window::prewarm(app.handle());
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                update_prep::shutdown_children();
            }
        });
}
