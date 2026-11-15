use super::*;

const MAX_LOG_BYTES: u64 = 64 * 1024 * 1024;
const KEEP_LOGS_FOR: Duration = Duration::from_secs(24 * 60 * 60);

static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
static LOG_SEQ: AtomicU64 = AtomicU64::new(1);

pub(crate) fn init_output_logs(cache_dir: PathBuf) {
    let dir = cache_dir.join("command-output");
    let _ = LOG_DIR.set(dir.clone());
    super::scope::add_read_only_root(dir.clone());
    std::thread::spawn(move || prune_old_logs(&dir, KEEP_LOGS_FOR));
}

fn log_dir() -> PathBuf {
    LOG_DIR
        .get()
        .cloned()
        .unwrap_or_else(|| std::env::temp_dir().join("nyxs-command-output"))
}

fn prune_old_logs(dir: &Path, keep_for: Duration) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > keep_for);
        if old {
            let _ = fs::remove_file(entry.path());
        }
    }
}

pub(crate) struct LogRequest {
    pub threshold: usize,
    pub stem: String,
}

impl LogRequest {
    pub(crate) fn new(threshold: Option<usize>) -> Option<Self> {
        let threshold = threshold?;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let seq = LOG_SEQ.fetch_add(1, Ordering::Relaxed);
        Some(LogRequest {
            threshold,
            stem: format!("{stamp}-{}-{seq}", std::process::id()),
        })
    }

    pub(crate) fn spill(&self, stream: &str, max_head: usize) -> Spill {
        Spill {
            threshold: self.threshold.min(max_head),
            path: log_dir().join(format!("{}-{stream}.log", self.stem)),
            file: None,
            written: 0,
            failed: false,
            truncated: false,
        }
    }
}

pub(crate) struct Spill {
    threshold: usize,
    path: PathBuf,
    file: Option<fs::File>,
    written: u64,
    failed: bool,
    truncated: bool,
}

impl Spill {
    pub(crate) fn feed(&mut self, total_before: usize, earlier: &[&[u8]], data: &[u8]) {
        if self.failed {
            return;
        }
        if self.file.is_none() {
            if total_before + data.len() <= self.threshold {
                return;
            }
            let opened = fs::create_dir_all(log_dir()).and_then(|_| fs::File::create(&self.path));
            match opened {
                Ok(f) => self.file = Some(f),
                Err(_) => {
                    self.failed = true;
                    return;
                }
            }
            for chunk in earlier {
                self.write(chunk);
            }
        }
        self.write(data);
    }

    fn write(&mut self, data: &[u8]) {
        let Some(file) = self.file.as_mut() else {
            return;
        };
        let room = MAX_LOG_BYTES.saturating_sub(self.written) as usize;
        let take = room.min(data.len());
        if take > 0 && file.write_all(&data[..take]).is_err() {
            self.failed = true;
            self.file = None;
            return;
        }
        self.written += take as u64;
        if take < data.len() {
            self.truncated = true;
        }
    }

    pub(crate) fn finish(&mut self) -> Option<String> {
        let mut file = self.file.take()?;
        if self.truncated {
            let _ = write!(file, "\n… [log cut at {MAX_LOG_BYTES} bytes]\n");
        }
        let _ = file.flush();
        Some(self.path.to_string_lossy().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spills_everything_once_the_threshold_is_crossed() {
        let req = LogRequest::new(Some(10)).unwrap();
        let mut spill = req.spill("stdout", 1024);
        spill.feed(0, &[], b"12345");
        assert!(spill.file.is_none());
        spill.feed(5, &[b"12345"], b"67890ab");
        spill.feed(12, &[], b"cd");
        let path = spill.finish().expect("log written");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "1234567890abcd");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn short_output_writes_no_log() {
        let req = LogRequest::new(Some(100)).unwrap();
        let mut spill = req.spill("stderr", 1024);
        spill.feed(0, &[], b"tiny");
        assert!(spill.finish().is_none());
    }

    #[test]
    fn prunes_only_old_logs() {
        let dir = std::env::temp_dir().join(format!("nyxs-prune-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.log");
        std::fs::write(&file, "x").unwrap();
        prune_old_logs(&dir, Duration::from_secs(3600));
        assert!(file.exists());
        prune_old_logs(&dir, Duration::ZERO);
        std::thread::sleep(Duration::from_millis(20));
        prune_old_logs(&dir, Duration::ZERO);
        assert!(!file.exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
