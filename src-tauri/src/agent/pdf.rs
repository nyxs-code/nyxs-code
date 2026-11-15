use super::vfs;
use super::*;

const PDF_MAX_READ_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Serialize)]
pub struct PdfRead {
    pub base64: String,
    pub size: u64,
}

#[tauri::command(async)]
pub fn agent_read_pdf(path: String, scope: Option<String>) -> Result<PdfRead, String> {
    use base64::Engine;
    confine(&path, scope.as_deref())?;
    let meta = vfs::metadata(&path).map_err(|e| format!("Couldn't open {path}: {e}"))?;
    if meta.is_dir {
        return Err(format!("{path} is a folder, not a file."));
    }
    let size = meta.len;
    if size == 0 {
        return Err(format!("The PDF is empty: {path}"));
    }
    if size > PDF_MAX_READ_BYTES {
        return Err(format!(
            "The PDF exceeds the maximum size of {} MB.",
            PDF_MAX_READ_BYTES / (1024 * 1024)
        ));
    }
    let bytes = vfs::read(&path).map_err(|e| format!("Couldn't read {path}: {e}"))?;
    if bytes.len() < 5 || &bytes[0..5] != b"%PDF-" {
        return Err(format!(
            "This isn't a valid PDF (missing the %PDF- header): {path}"
        ));
    }
    let base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(PdfRead { base64, size })
}

#[tauri::command(async)]
pub fn agent_read_pdf_text(path: String, scope: Option<String>) -> Result<String, String> {
    confine(&path, scope.as_deref())?;
    let meta = vfs::metadata(&path).map_err(|e| format!("Couldn't open {path}: {e}"))?;
    if meta.is_dir {
        return Err(format!("{path} is a folder, not a file."));
    }
    let size = meta.len;
    if size == 0 {
        return Err(format!("The PDF is empty: {path}"));
    }
    if size > PDF_MAX_READ_BYTES {
        return Err(format!(
            "The PDF exceeds the maximum size of {} MB.",
            PDF_MAX_READ_BYTES / (1024 * 1024)
        ));
    }
    let bytes = vfs::read(&path).map_err(|e| format!("Couldn't read {path}: {e}"))?;
    if bytes.len() < 5 || &bytes[0..5] != b"%PDF-" {
        return Err(format!(
            "This isn't a valid PDF (missing the %PDF- header): {path}"
        ));
    }
    let text = pdf_extract::extract_text_from_mem(&bytes)
        .map_err(|e| format!("Couldn't extract the text from the PDF: {e}"))?;
    Ok(text.trim().to_string())
}

#[tauri::command(async)]
pub fn agent_write_pdf(
    path: String,
    title: Option<String>,
    content: String,
    scope: Option<String>,
) -> Result<String, String> {
    confine_write(&path, scope.as_deref(), false)?;
    use printpdf::{BuiltinFont, Mm, PdfDocument};
    use std::io::BufWriter;

    if let Some(parent) = Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Couldn't create the folder for {path}: {e}"))?;
        }
    }

    const PAGE_W: f32 = 210.0;
    const PAGE_H: f32 = 297.0;
    const MARGIN: f32 = 20.0;
    const USABLE_W: f32 = PAGE_W - 2.0 * MARGIN;
    let top = PAGE_H - MARGIN;
    let bottom = MARGIN;

    let doc_title = title.clone().unwrap_or_else(|| "Document".into());
    let (doc, mut page, mut layer_idx) =
        PdfDocument::new(&doc_title, Mm(PAGE_W), Mm(PAGE_H), "Layer 1");
    let regular = doc
        .add_builtin_font(BuiltinFont::Helvetica)
        .map_err(|e| format!("Couldn't load the font: {e}"))?;
    let bold = doc
        .add_builtin_font(BuiltinFont::HelveticaBold)
        .map_err(|e| format!("Couldn't load the font: {e}"))?;

    let mut layer = doc.get_page(page).get_layer(layer_idx);
    let mut y = top;

    let max_chars = |font_pt: f32| -> usize {
        let char_w_mm = font_pt * 0.3528 * 0.5;
        ((USABLE_W / char_w_mm).floor() as usize).max(8)
    };
    let line_h = |font_pt: f32| -> f32 { font_pt * 0.3528 * 1.35 };

    let wrap = |text: &str, limit: usize| -> Vec<String> {
        let mut lines: Vec<String> = Vec::new();
        let mut cur = String::new();
        for word in text.split_whitespace() {
            if cur.is_empty() {
                cur = word.to_string();
            } else if cur.chars().count() + 1 + word.chars().count() <= limit {
                cur.push(' ');
                cur.push_str(word);
            } else {
                lines.push(std::mem::take(&mut cur));
                cur = word.to_string();
            }
        }
        if !cur.is_empty() {
            lines.push(cur);
        }
        if lines.is_empty() {
            lines.push(String::new());
        }
        lines
    };

    let draw = |doc: &printpdf::PdfDocumentReference,
                layer: &mut printpdf::PdfLayerReference,
                page: &mut printpdf::PdfPageIndex,
                layer_idx: &mut printpdf::PdfLayerIndex,
                y: &mut f32,
                text: &str,
                font_pt: f32,
                use_bold: bool,
                indent: f32| {
        let lh = line_h(font_pt);
        for line in wrap(text, max_chars(font_pt)) {
            if *y - lh < bottom {
                let (np, nl) = doc.add_page(Mm(PAGE_W), Mm(PAGE_H), "Layer 1");
                *page = np;
                *layer_idx = nl;
                *layer = doc.get_page(*page).get_layer(*layer_idx);
                *y = top;
            }
            let font = if use_bold { &bold } else { &regular };
            layer.use_text(line, font_pt, Mm(MARGIN + indent), Mm(*y), font);
            *y -= lh;
        }
    };

    if let Some(t) = title.as_ref().filter(|t| !t.trim().is_empty()) {
        draw(
            &doc,
            &mut layer,
            &mut page,
            &mut layer_idx,
            &mut y,
            t,
            22.0,
            true,
            0.0,
        );
        y -= 4.0;
    }

    for raw in content.replace('\r', "").split('\n') {
        let line = raw.trim_end();
        let trimmed = line.trim_start();
        if trimmed.is_empty() {
            y -= line_h(11.0) * 0.6;
            continue;
        }
        let (text, size, is_bold, indent) = if let Some(r) = trimmed.strip_prefix("### ") {
            (r.to_string(), 12.0, true, 0.0)
        } else if let Some(r) = trimmed.strip_prefix("## ") {
            (r.to_string(), 14.0, true, 0.0)
        } else if let Some(r) = trimmed.strip_prefix("# ") {
            (r.to_string(), 18.0, true, 0.0)
        } else if let Some(r) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
        {
            (format!("• {r}"), 11.0, false, 4.0)
        } else {
            (trimmed.to_string(), 11.0, false, 0.0)
        };
        if is_bold {
            y -= line_h(size) * 0.4;
        }
        draw(
            &doc,
            &mut layer,
            &mut page,
            &mut layer_idx,
            &mut y,
            &text,
            size,
            is_bold,
            indent,
        );
    }

    let file = fs::File::create(&path).map_err(|e| format!("Couldn't create {path}: {e}"))?;
    doc.save(&mut BufWriter::new(file))
        .map_err(|e| format!("Couldn't save the PDF {path}: {e}"))?;
    Ok(format!("OK: PDF written to {path}"))
}

fn find_chromium_browser() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let candidates: [(&str, &str); 5] = [
            (
                "ProgramFiles(x86)",
                r"Microsoft\Edge\Application\msedge.exe",
            ),
            ("ProgramFiles", r"Microsoft\Edge\Application\msedge.exe"),
            ("ProgramFiles", r"Google\Chrome\Application\chrome.exe"),
            ("ProgramFiles(x86)", r"Google\Chrome\Application\chrome.exe"),
            ("LOCALAPPDATA", r"Google\Chrome\Application\chrome.exe"),
        ];
        for (env_key, rel) in candidates {
            if let Ok(base) = std::env::var(env_key) {
                let p = Path::new(&base).join(rel);
                if p.exists() {
                    return Some(p);
                }
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        let candidates = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/microsoft-edge",
        ];
        candidates.iter().map(PathBuf::from).find(|p| p.exists())
    }
}

#[tauri::command(async)]
pub fn agent_html_to_pdf(
    out_path: String,
    html: String,
    scope: Option<String>,
) -> Result<String, String> {
    confine_write(&out_path, scope.as_deref(), false)?;
    let browser = find_chromium_browser()
        .ok_or_else(|| "no-browser: Edge/Chrome not found to render HTML to PDF".to_string())?;

    if let Some(parent) = Path::new(&out_path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Couldn't create the folder for {out_path}: {e}"))?;
        }
    }

    let tmp_html = Path::new(&out_path).with_extension("nyxs-tmp.html");
    fs::write(&tmp_html, html).map_err(|e| format!("Couldn't write the temporary HTML: {e}"))?;
    let udd = pdf_profile_dir();

    let mut cmd = Command::new(&browser);
    cmd.arg("--headless=new")
        .arg("--disable-gpu")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg(format!("--user-data-dir={}", udd.display()))
        .arg("--no-pdf-header-footer")
        .arg(format!("--print-to-pdf={out_path}"))
        .arg(tmp_html.to_string_lossy().to_string());
    let result = run_headless(cmd, PDF_TIMEOUT);

    let _ = fs::remove_file(&tmp_html);
    let _ = fs::remove_dir_all(&udd);

    let stderr = result?;
    if !Path::new(&out_path).exists() {
        return Err(format!("The browser didn't produce the PDF: {stderr}"));
    }
    Ok(format!("OK: styled PDF generated at {out_path}"))
}

/// How long the headless browser gets to print a document before it is stopped.
const PDF_TIMEOUT: Duration = Duration::from_secs(120);

/// A browser profile of its own for each call: two PDFs made at once shared one, and the first
/// to finish deleted it under the other.
fn pdf_profile_dir() -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    std::env::temp_dir().join(format!(
        "nyxs-pdf-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
}

/// Runs the headless browser to its end, inside the agent's job so it ends with Nyxs, and stops
/// it (with what it started) after `timeout`. Returns what it wrote to stderr.
fn run_headless(mut cmd: Command, timeout: Duration) -> Result<String, String> {
    use super::cli_process::{await_readers, spawn_contained, StreamCapture, EXIT_DRAIN_GRACE};
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child =
        spawn_contained(&mut cmd).map_err(|e| format!("Couldn't launch the browser: {e}"))?;
    let err = StreamCapture::start(child.stderr.take().ok_or("No stderr from the browser")?);
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(100))
            }
            _ => {
                kill_tree(&mut child);
                let _ = child.wait();
                return Err(format!(
                    "The browser didn't finish the PDF within {} s",
                    timeout.as_secs()
                ));
            }
        }
    }
    await_readers([err.reader()], EXIT_DRAIN_GRACE);
    Ok(err.take())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pdf_gets_a_browser_profile_of_its_own() {
        assert_ne!(pdf_profile_dir(), pdf_profile_dir());
    }

    #[test]
    fn a_browser_that_never_finishes_is_stopped_after_the_timeout() {
        #[cfg(windows)]
        let cmd = {
            let mut cmd = Command::new("cmd");
            cmd.args(["/c", "ping -n 30 127.0.0.1 >nul"]);
            cmd
        };
        #[cfg(not(windows))]
        let cmd = {
            use std::os::unix::process::CommandExt;
            let mut cmd = Command::new("sh");
            cmd.args(["-c", "sleep 30"]).process_group(0);
            cmd
        };
        let started = Instant::now();
        let err = run_headless(cmd, Duration::from_millis(500)).unwrap_err();
        assert!(err.contains("didn't finish"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
