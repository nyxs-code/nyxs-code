mod discovery;
mod protocol;
mod provision;
pub(crate) use provision::managed_node_program;
mod registry;
mod server;
mod transport;

use std::collections::HashMap;
use std::process::Command;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use protocol::Diagnostic;

pub fn init_paths(app: &AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        provision::set_managed_root(dir.join("lsp"));
    }
}

fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryStatus {
    pub language: String,
    pub binary: Option<String>,
    pub installed: bool,
    pub source: String,
    pub expected_names: Vec<String>,
    pub provisionable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub language: String,
    pub workspace: String,
    pub state: String,
    pub binary: String,
    pub error: Option<String>,
}

fn status_of(server: &server::LspServer) -> ServerStatus {
    ServerStatus {
        language: server.language.clone(),
        workspace: server.workspace.clone(),
        state: server.state().as_str().to_string(),
        binary: server.binary.clone(),
        error: server.state_error(),
    }
}

fn binary_status(language: String) -> BinaryStatus {
    let lookup = discovery::lookup(&language);
    let installed = lookup.resolved.is_some();
    let provisionable = discovery::spec_for(&language).is_some();
    BinaryStatus {
        language,
        binary: lookup.resolved.map(|p| p.to_string_lossy().to_string()),
        installed,
        source: lookup.source.to_string(),
        expected_names: lookup.tried,
        provisionable,
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProvisionProgress {
    language: String,
    phase: String,
    received: u64,
    total: u64,
    message: String,
}

#[tauri::command]
pub async fn lsp_provision(app: AppHandle, language: String) -> Result<BinaryStatus, String> {
    if discovery::resolve(&language).is_some() {
        return Ok(binary_status(language));
    }
    let lang = language.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let app = app.clone();
        let lang_for_report = lang.clone();
        let report = move |phase: &str, received: u64, total: u64, message: &str| {
            let _ = app.emit(
                "lsp-provision-progress",
                ProvisionProgress {
                    language: lang_for_report.clone(),
                    phase: phase.to_string(),
                    received,
                    total,
                    message: message.to_string(),
                },
            );
        };
        let result = provision::provision(&lang, &report);
        match &result {
            Ok(()) => report("done", 0, 0, "Done"),
            Err(e) => report("error", 0, 0, e),
        }
        result
    })
    .await
    .map_err(|e| format!("The provisioning task failed: {e}"))??;
    registry::forget_failures(Some(&language));
    Ok(binary_status(language))
}

#[tauri::command(async)]
pub fn lsp_ensure_server(workspace: String, language: String) -> Result<ServerStatus, String> {
    let server = registry::ensure(&workspace, &language)?;
    Ok(status_of(&server))
}

#[tauri::command(async)]
pub fn lsp_dispose_workspace(workspace: String) -> u32 {
    registry::dispose_workspace(&workspace)
}

pub fn shutdown_all() -> u32 {
    registry::dispose_all()
}

#[tauri::command(async)]
pub fn lsp_did_open(
    workspace: String,
    language: String,
    uri: String,
    language_id: String,
    version: i32,
    text: String,
    saved: Option<bool>,
) -> Result<(), String> {
    let server = registry::ensure(&workspace, &language)?;
    let uri = server.to_server_uri(&uri);
    server.did_open(&uri, &language_id, version, &text);
    if saved == Some(true) {
        server.did_save(&uri);
    }
    Ok(())
}

#[tauri::command(async)]
pub fn lsp_did_change(
    workspace: String,
    language: String,
    uri: String,
    language_id: String,
    text: String,
    saved: Option<bool>,
) -> Result<(), String> {
    let server = registry::ensure(&workspace, &language)?;
    let uri = server.to_server_uri(&uri);
    server.did_change(&uri, &language_id, &text);
    if saved == Some(true) {
        server.did_save(&uri);
    }
    Ok(())
}

/// A quiet moment after a file's diagnostics arrive, for a second pass that follows the first.
const DIAGNOSTICS_SETTLE: std::time::Duration = std::time::Duration::from_millis(200);

/// With `uri`, waits for that file's diagnostics after its last change and answers only them,
/// or nothing at all when they didn't come in time (stale or missing, not "clean"). Without
/// it, the first publish of any file and everything stored.
#[tauri::command(async)]
pub fn lsp_diagnostics_wait(
    workspace: String,
    language: String,
    timeout_ms: u64,
    uri: Option<String>,
) -> Result<HashMap<String, Vec<Diagnostic>>, String> {
    let server = registry::get(&workspace, &language)
        .ok_or_else(|| "No LSP server for that language".to_string())?;
    if let Some(uri) = uri {
        let uri = server.to_server_uri(&uri);
        let timeout = std::time::Duration::from_millis(timeout_ms);
        if !server.wait_for_file(&uri, timeout, DIAGNOSTICS_SETTLE) {
            return Ok(HashMap::new());
        }
        let found = server.diagnostics_for(&uri);
        return Ok(if found.is_empty() {
            HashMap::from([(server.app_uri(&uri), Vec::new())])
        } else {
            found
        });
    }
    let baseline = server.publish_seq();
    server.wait_for_publish(baseline, std::time::Duration::from_millis(timeout_ms));
    Ok(server.get_diagnostics(None))
}

#[tauri::command(async)]
pub fn lsp_hover(
    workspace: String,
    language: String,
    uri: String,
    line: u32,
    character: u32,
) -> Result<Value, String> {
    let server = registry::ensure(&workspace, &language)?;
    let uri = server.to_server_uri(&uri);
    server
        .request("textDocument/hover", position_params(&uri, line, character))
        .map(|v| server.app_uris(v))
}

#[tauri::command(async)]
pub fn lsp_definition(
    workspace: String,
    language: String,
    uri: String,
    line: u32,
    character: u32,
) -> Result<Value, String> {
    let server = registry::ensure(&workspace, &language)?;
    let uri = server.to_server_uri(&uri);
    server
        .request(
            "textDocument/definition",
            position_params(&uri, line, character),
        )
        .map(|v| server.app_uris(v))
}

#[tauri::command(async)]
pub fn lsp_references(
    workspace: String,
    language: String,
    uri: String,
    line: u32,
    character: u32,
    include_declaration: bool,
) -> Result<Value, String> {
    let server = registry::ensure(&workspace, &language)?;
    let uri = server.to_server_uri(&uri);
    let mut params = position_params(&uri, line, character);
    params["context"] = serde_json::json!({ "includeDeclaration": include_declaration });
    server
        .request("textDocument/references", params)
        .map(|v| server.app_uris(v))
}

#[tauri::command(async)]
pub fn lsp_document_symbols(
    workspace: String,
    language: String,
    uri: String,
) -> Result<Value, String> {
    let server = registry::ensure(&workspace, &language)?;
    let uri = server.to_server_uri(&uri);
    server
        .request(
            "textDocument/documentSymbol",
            serde_json::json!({ "textDocument": { "uri": uri } }),
        )
        .map(|v| server.app_uris(v))
}

fn position_params(uri: &str, line: u32, character: u32) -> Value {
    serde_json::json!({
        "textDocument": { "uri": uri },
        "position": { "line": line, "character": character }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore]
    fn provision_managed() {
        let tmp = std::env::temp_dir().join("nyxs-lsp-test");
        let _ = std::fs::remove_dir_all(&tmp);
        provision::set_managed_root(tmp.clone());

        let report = |phase: &str, received: u64, total: u64, _msg: &str| {
            if phase == "downloading" && total > 0 {
                eprintln!("  {phase}: {received}/{total}");
            } else {
                eprintln!("  {phase}");
            }
        };

        eprintln!("provisioning rust...");
        provision::provision("rust", &report).expect("provision rust");
        let ra_bin = provision::managed_bin_dir().join(if cfg!(windows) {
            "rust-analyzer.exe"
        } else {
            "rust-analyzer"
        });
        assert!(
            ra_bin.is_file(),
            "the managed rust-analyzer should exist on disk"
        );
        assert!(discovery::resolve("rust").is_some(), "rust should resolve");

        eprintln!("provisioning typescript (node + npm)...");
        provision::provision("typescript", &report).expect("provision typescript");
        let ts =
            discovery::resolve("typescript").expect("typescript should resolve after provisioning");
        assert_eq!(ts.source, "managed");
        assert!(ts.program.to_string_lossy().to_lowercase().contains("node"));
        assert!(ts.args[0]
            .to_lowercase()
            .contains("typescript-language-server"));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    #[ignore]
    fn smoke_rust_analyzer() {
        let ws = env!("CARGO_MANIFEST_DIR").to_string();
        let status = lsp_ensure_server(ws.clone(), "rust".to_string())
            .expect("ensure_server should start rust-analyzer");
        assert_eq!(status.state, "ready", "the server should end up ready");
        assert!(status.binary.to_lowercase().contains("rust-analyzer"));

        let again = lsp_ensure_server(ws.clone(), "rust".to_string()).unwrap();
        assert_eq!(again.state, "ready");

        let n = lsp_dispose_workspace(ws);
        assert!(n >= 1, "should shut down at least one server");
    }
}
