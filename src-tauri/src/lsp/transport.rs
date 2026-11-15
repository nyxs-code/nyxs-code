use std::io::{BufRead, Read, Write};

use serde_json::Value;

pub fn write_message<W: Write>(out: &mut W, payload: &Value) -> std::io::Result<()> {
    let body = serde_json::to_vec(payload)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    out.write_all(header.as_bytes())?;
    out.write_all(&body)?;
    out.flush()
}

pub fn read_message<R: BufRead>(reader: &mut R) -> std::io::Result<Option<Value>> {
    let mut content_length: Option<usize> = None;

    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            return Ok(None);
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((key, value)) = trimmed.split_once(':') {
            if key.trim().eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse::<usize>().ok();
            }
        }
    }

    let len = match content_length {
        Some(len) => len,
        None => {
            return Ok(Some(Value::Null));
        }
    };

    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;

    match serde_json::from_slice::<Value>(&body) {
        Ok(v) => Ok(Some(v)),
        Err(e) => {
            log::warn!("LSP: cuerpo JSON malformado, frame descartado: {e}");
            Ok(Some(Value::Null))
        }
    }
}

pub fn drain_to_log<R: Read>(reader: R, label: String) {
    let mut buf = std::io::BufReader::new(reader);
    let mut line = String::new();
    loop {
        line.clear();
        match buf.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let t = line.trim_end();
                if !t.is_empty() {
                    log::debug!("[{label}] {t}");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    #[test]
    fn write_then_read_roundtrip() {
        let msg = json!({ "jsonrpc": "2.0", "id": 1, "method": "test", "params": { "a": 1 } });
        let mut buf: Vec<u8> = Vec::new();
        write_message(&mut buf, &msg).unwrap();
        let text = String::from_utf8(buf.clone()).unwrap();
        assert!(text.starts_with("Content-Length: "));
        assert!(text.contains("\r\n\r\n"));

        let mut reader = std::io::BufReader::new(Cursor::new(buf));
        let got = read_message(&mut reader).unwrap().unwrap();
        assert_eq!(got, msg);
    }

    #[test]
    fn read_two_consecutive_messages() {
        let a = json!({ "id": 1, "result": "a" });
        let b = json!({ "id": 2, "result": "b" });
        let mut buf: Vec<u8> = Vec::new();
        write_message(&mut buf, &a).unwrap();
        write_message(&mut buf, &b).unwrap();
        let mut reader = std::io::BufReader::new(Cursor::new(buf));
        assert_eq!(read_message(&mut reader).unwrap().unwrap(), a);
        assert_eq!(read_message(&mut reader).unwrap().unwrap(), b);
        assert!(read_message(&mut reader).unwrap().is_none());
    }

    #[test]
    fn eof_returns_none() {
        let mut reader = std::io::BufReader::new(Cursor::new(Vec::<u8>::new()));
        assert!(read_message(&mut reader).unwrap().is_none());
    }

    #[test]
    fn header_is_case_insensitive() {
        let body = b"{\"id\":1,\"result\":null}";
        let raw = format!("content-length: {}\r\n\r\n", body.len());
        let mut bytes = raw.into_bytes();
        bytes.extend_from_slice(body);
        let mut reader = std::io::BufReader::new(Cursor::new(bytes));
        let got = read_message(&mut reader).unwrap().unwrap();
        assert_eq!(got, json!({ "id": 1, "result": null }));
    }
}
