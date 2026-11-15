use serde::Serialize;
use serde_json::{json, Value};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pos {
    pub line: u32,
    pub character: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Range {
    pub start: Pos,
    pub end: Pos,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub range: Range,
    pub severity: u8,
    pub message: String,
    pub source: Option<String>,
    pub code: Option<String>,
}

impl Diagnostic {
    pub fn from_value(v: &Value) -> Option<Diagnostic> {
        let range = v.get("range")?;
        let start = parse_pos(range.get("start")?)?;
        let end = parse_pos(range.get("end")?)?;
        let message = v.get("message")?.as_str()?.to_string();
        let severity = v.get("severity").and_then(|s| s.as_u64()).unwrap_or(1) as u8;
        let source = v.get("source").and_then(|s| s.as_str()).map(String::from);
        let code = v.get("code").and_then(|c| match c {
            Value::String(s) => Some(s.clone()),
            Value::Number(n) => Some(n.to_string()),
            _ => None,
        });
        Some(Diagnostic {
            range: Range { start, end },
            severity,
            message,
            source,
            code,
        })
    }
}

fn parse_pos(v: &Value) -> Option<Pos> {
    Some(Pos {
        line: v.get("line")?.as_u64()? as u32,
        character: v.get("character")?.as_u64()? as u32,
    })
}

pub enum Incoming {
    Response {
        id: i64,
        result: Result<Value, String>,
    },
    ServerRequest {
        id: Value,
        method: String,
        #[allow(dead_code)]
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
}

impl Incoming {
    pub fn classify(v: Value) -> Option<Incoming> {
        let has_id = v.get("id").map(|i| !i.is_null()).unwrap_or(false);
        let method = v.get("method").and_then(|m| m.as_str()).map(String::from);

        match (has_id, method) {
            (true, Some(method)) => Some(Incoming::ServerRequest {
                id: v.get("id").cloned().unwrap_or(Value::Null),
                method,
                params: v.get("params").cloned().unwrap_or(Value::Null),
            }),
            (false, Some(method)) => Some(Incoming::Notification {
                method,
                params: v.get("params").cloned().unwrap_or(Value::Null),
            }),
            (true, None) => {
                let id = v.get("id").and_then(|i| i.as_i64())?;
                let result = if let Some(err) = v.get("error") {
                    let msg = err
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("unknown LSP error");
                    Err(msg.to_string())
                } else {
                    Ok(v.get("result").cloned().unwrap_or(Value::Null))
                };
                Some(Incoming::Response { id, result })
            }
            _ => None,
        }
    }
}

pub fn request_envelope(id: i64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

pub fn notify_envelope(method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "method": method, "params": params })
}

pub fn response_envelope(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

pub fn error_envelope(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

pub fn path_to_uri(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let mut encoded = String::with_capacity(normalized.len() + 8);
    for ch in normalized.chars() {
        match ch {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '/' | '-' | '.' | '_' | '~' | ':' => {
                encoded.push(ch)
            }
            _ => {
                let mut buf = [0u8; 4];
                for b in ch.encode_utf8(&mut buf).bytes() {
                    encoded.push('%');
                    encoded.push_str(&format!("{b:02X}"));
                }
            }
        }
    }
    if encoded.starts_with('/') {
        format!("file://{encoded}")
    } else {
        format!("file:///{encoded}")
    }
}

/// A `file://` URI from a server on another machine, as a path there with forward slashes
/// (`file:///C:/a` → `C:/a`, `file:///home/a` → `/home/a`).
pub fn uri_to_remote_path(uri: &str) -> String {
    let rest = uri.strip_prefix("file://").unwrap_or(uri);
    let decoded = percent_decode(rest);
    let b = decoded.as_bytes();
    if b.len() >= 3 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b':' {
        decoded[1..].to_string()
    } else {
        decoded
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = hex_val(bytes[i + 1]);
            let lo = hex_val(bytes[i + 2]);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn windows_uri_roundtrip() {
        let uri = path_to_uri("C:\\Users\\me\\proj\\src\\main.rs");
        assert_eq!(uri, "file:///C:/Users/me/proj/src/main.rs");
    }

    #[test]
    fn uri_encodes_spaces() {
        let uri = path_to_uri("C:\\my docs\\a.ts");
        assert_eq!(uri, "file:///C:/my%20docs/a.ts");
        assert!(percent_decode("my%20docs").contains("my docs"));
    }

    #[test]
    fn posix_uri() {
        let uri = path_to_uri("/home/me/a.py");
        assert_eq!(uri, "file:///home/me/a.py");
    }

    #[test]
    fn classify_response_ok() {
        let v = json!({ "jsonrpc": "2.0", "id": 7, "result": { "x": 1 } });
        match Incoming::classify(v).unwrap() {
            Incoming::Response { id, result } => {
                assert_eq!(id, 7);
                assert_eq!(result.unwrap(), json!({ "x": 1 }));
            }
            _ => panic!("se esperaba Response"),
        }
    }

    #[test]
    fn classify_response_error() {
        let v = json!({ "id": 7, "error": { "code": -1, "message": "boom" } });
        match Incoming::classify(v).unwrap() {
            Incoming::Response { result, .. } => assert_eq!(result.unwrap_err(), "boom"),
            _ => panic!("se esperaba Response"),
        }
    }

    #[test]
    fn classify_notification_and_server_request() {
        let n = json!({ "method": "textDocument/publishDiagnostics", "params": {} });
        assert!(matches!(
            Incoming::classify(n).unwrap(),
            Incoming::Notification { .. }
        ));
        let r = json!({ "id": 3, "method": "workspace/configuration", "params": {} });
        assert!(matches!(
            Incoming::classify(r).unwrap(),
            Incoming::ServerRequest { .. }
        ));
    }

    #[test]
    fn diagnostic_from_value() {
        let v = json!({
            "range": { "start": { "line": 4, "character": 2 }, "end": { "line": 4, "character": 9 } },
            "severity": 1,
            "message": "type error",
            "source": "tsserver",
            "code": 2304
        });
        let d = Diagnostic::from_value(&v).unwrap();
        assert_eq!(d.range.start.line, 4);
        assert_eq!(d.severity, 1);
        assert_eq!(d.code.as_deref(), Some("2304"));
    }
}
