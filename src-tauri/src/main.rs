#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(windows)]
    if std::env::args().nth(1).as_deref() == Some("--nyxs-detach") {
        std::process::exit(app_lib::detach_helper_main());
    }
    // A stdio MCP server for Antigravity CLI, checked before anything of the app starts.
    if std::env::args().nth(1).as_deref() == Some(app_lib::MCP_PROXY_FLAG) {
        let server = std::env::args().nth(2).unwrap_or_default();
        std::process::exit(app_lib::mcp_proxy_main(&server));
    }
    app_lib::run();
}
