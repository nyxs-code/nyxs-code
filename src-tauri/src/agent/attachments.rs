use super::*;

const MAX_ATTACHMENT_BYTES: usize = 50 * 1024 * 1024;

fn safe_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "attachment".to_string()
    } else {
        trimmed.chars().take(120).collect()
    }
}

fn attachment_dir(root: &Path) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    root.join(format!("{stamp:x}"))
}

#[tauri::command(async)]
pub fn nyxs_save_attachment(name: String, data: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("Invalid attachment: {e}"))?;
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err("The attachment is larger than 50 MB".to_string());
    }
    let dir = attachment_dir(&home_dir()?.join(".nyxs").join("attachments"));
    fs::create_dir_all(&dir).map_err(|e| format!("Couldn't save the attachment: {e}"))?;
    let path = dir.join(safe_file_name(&name));
    fs::write(&path, bytes).map_err(|e| format!("Couldn't save the attachment: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_a_harmless_base_name() {
        assert_eq!(safe_file_name("informe.pdf"), "informe.pdf");
        assert_eq!(safe_file_name("..\\..\\Windows\\evil.exe"), "evil.exe");
        assert_eq!(safe_file_name("a/b/c:d?.txt"), "c_d_.txt");
        assert_eq!(safe_file_name(".."), "attachment");
        assert_eq!(safe_file_name(""), "attachment");
    }

    #[test]
    fn every_save_gets_its_own_folder() {
        let root = Path::new("root");
        let a = attachment_dir(root);
        std::thread::sleep(Duration::from_millis(2));
        assert_ne!(a, attachment_dir(root));
        assert!(a.starts_with(root));
    }
}
