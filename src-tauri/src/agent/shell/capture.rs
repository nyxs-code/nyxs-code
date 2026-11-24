//! Killing a command's process tree and capturing its output, keeping the head and tail.

use crate::agent::output_log::{LogRequest, Spill};
use crate::agent::*;
use std::sync::atomic::AtomicBool;

const RUN_HEAD_BYTES: usize = 256 * 1024;
const RUN_TAIL_BYTES: usize = 256 * 1024;
const READER_GRACE: Duration = Duration::from_millis(1500);

pub(crate) fn kill_tree(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        let mut tk = Command::new("taskkill");
        tk.args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_console(&mut tk);
        let _ = tk.status();
    }
    #[cfg(not(target_os = "windows"))]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
}

#[derive(Default)]
pub(crate) struct CaptureBuf {
    head: Vec<u8>,
    tail: Vec<u8>,
    omitted: usize,
    total: usize,
    spill: Option<Spill>,
}

impl CaptureBuf {
    pub(crate) fn logged(log: Option<&LogRequest>, stream: &str) -> Self {
        CaptureBuf {
            spill: log.map(|l| l.spill(stream, RUN_HEAD_BYTES)),
            ..Default::default()
        }
    }

    pub(crate) fn finish_log(&mut self) -> Option<String> {
        self.spill.as_mut().and_then(Spill::finish)
    }

    pub(crate) fn push(&mut self, data: &[u8]) {
        if let Some(spill) = self.spill.as_mut() {
            spill.feed(self.total, &[&self.head, &self.tail], data);
        }
        self.total += data.len();
        let room = RUN_HEAD_BYTES
            .saturating_sub(self.head.len())
            .min(data.len());
        self.head.extend_from_slice(&data[..room]);
        let rest = &data[room..];
        if rest.is_empty() {
            return;
        }
        self.tail.extend_from_slice(rest);
        if self.tail.len() > RUN_TAIL_BYTES * 2 {
            let cut = self.tail.len() - RUN_TAIL_BYTES;
            self.tail.drain(..cut);
            self.omitted += cut;
        }
    }

    pub(crate) fn text(&self) -> String {
        if self.omitted == 0 {
            let mut all = Vec::with_capacity(self.head.len() + self.tail.len());
            all.extend_from_slice(&self.head);
            all.extend_from_slice(&self.tail);
            return String::from_utf8_lossy(&all).into_owned();
        }
        format!(
            "{}\n… [{} bytes de salida omitidos] …\n{}",
            String::from_utf8_lossy(&self.head),
            self.omitted,
            String::from_utf8_lossy(&self.tail)
        )
    }
}

/// Where a reader sends what it reads once its command moved to the background; an empty
/// slice says the stream ended.
pub(super) type Sink = Box<dyn FnMut(&[u8]) + Send>;

pub(super) struct Capture {
    buf: Arc<Mutex<CaptureBuf>>,
    done: Arc<AtomicBool>,
    sink: Arc<Mutex<Option<Sink>>>,
}

impl Capture {
    /// From now on what the reader reads goes to `sink` instead of the buffer. Whatever came
    /// before is in the buffer: the reader holds the sink's lock while it writes either.
    pub(super) fn hand_over(&self, sink: Sink) {
        *self.sink.lock().unwrap_or_else(|e| e.into_inner()) = Some(sink);
    }

    /// True once the reader has read its stream to the end.
    pub(super) fn done_flag(&self) -> Arc<AtomicBool> {
        self.done.clone()
    }

    fn finished(&self) -> bool {
        self.done.load(Ordering::Acquire)
    }

    pub(super) fn settle(&self) {
        let start = Instant::now();
        while !self.finished() && start.elapsed() < READER_GRACE {
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    pub(super) fn text(&self) -> String {
        self.buf.lock().map(|b| b.text()).unwrap_or_default()
    }

    pub(super) fn finish_log(&self) -> Option<String> {
        self.buf.lock().ok().and_then(|mut b| b.finish_log())
    }
}

pub(super) fn capture<R: Read + Send + 'static>(
    reader: Option<R>,
    log: Option<&LogRequest>,
    stream: &str,
) -> Capture {
    let buf = Arc::new(Mutex::new(CaptureBuf::logged(log, stream)));
    let done = Arc::new(AtomicBool::new(reader.is_none()));
    let sink: Arc<Mutex<Option<Sink>>> = Arc::new(Mutex::new(None));
    if let Some(mut reader) = reader {
        let (buf, done, sink) = (buf.clone(), done.clone(), sink.clone());
        std::thread::spawn(move || {
            let mut chunk = [0u8; 16 * 1024];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut s = sink.lock().unwrap_or_else(|e| e.into_inner());
                        match s.as_mut() {
                            Some(forward) => forward(&chunk[..n]),
                            None => {
                                if let Ok(mut b) = buf.lock() {
                                    b.push(&chunk[..n]);
                                }
                            }
                        }
                    }
                }
            }
            if let Some(forward) = sink.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
                forward(&[]);
            }
            done.store(true, Ordering::Release);
        });
    }
    Capture { buf, done, sink }
}
