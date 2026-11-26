//! Where a run's output goes: to the page's channel, and into a log of the turn in progress
//! that is replayed when a reloaded page attaches again.

use crate::agent::*;
use serde::Deserialize;
use tauri::ipc::Channel;

/// Where a run's output goes. The app's page can reload while Claude Code keeps working: the
/// output of the turn in progress is kept, and replayed to the reloaded page when it attaches
/// again, so the reply is rebuilt whole and the turn carries on.
#[derive(Default)]
pub(super) struct RunSink {
    pub(super) channel: Option<Channel<ClaudeCodeEvent>>,
    log: Vec<ClaudeCodeEvent>,
    log_bytes: usize,
    /// The last turn ended: the next line starts a new one, and a new log.
    after_result: bool,
    /// Control requests already answered, left out of a replay so they aren't asked twice.
    pub(super) answered: std::collections::HashSet<String>,
    pub(super) session_id: Option<String>,
    pub(super) exit: Option<Option<i32>>,
}

/// Past this a turn's log stops growing; a replay then rebuilds only its start.
const MAX_LOG_BYTES: usize = 128 * 1024 * 1024;

#[derive(Deserialize)]
struct LineHead {
    #[serde(rename = "type")]
    kind: Option<String>,
    subtype: Option<String>,
    session_id: Option<String>,
    request_id: Option<String>,
}

impl RunSink {
    pub(super) fn attached(channel: Channel<ClaudeCodeEvent>) -> Self {
        RunSink {
            channel: Some(channel),
            ..RunSink::default()
        }
    }

    pub(super) fn emit(&mut self, event: ClaudeCodeEvent) {
        if let ClaudeCodeEvent::Stdout { line } = &event {
            let head = serde_json::from_str::<LineHead>(line).ok();
            let kind = head.as_ref().and_then(|h| h.kind.as_deref()).unwrap_or("");
            if let Some(h) = head.as_ref().filter(|h| {
                h.kind.as_deref() == Some("system") && h.subtype.as_deref() == Some("init")
            }) {
                self.session_id = h.session_id.clone().or(self.session_id.take());
            }
            // Answers to the app's own requests (usage, context) are only for whoever asked, and
            // the guessed next prompt comes after the turn's result without starting a new one.
            if kind != "control_response" && kind != "prompt_suggestion" {
                if self.after_result {
                    self.log.clear();
                    self.log_bytes = 0;
                    self.answered.clear();
                    self.after_result = false;
                }
                self.record(event.clone(), line.len());
                if kind == "result" {
                    self.after_result = true;
                }
            }
        } else {
            let size = match &event {
                ClaudeCodeEvent::Stderr { line } => line.len(),
                _ => 0,
            };
            self.record(event.clone(), size);
        }
        if let Some(channel) = &self.channel {
            if channel.send(event).is_err() {
                self.channel = None;
            }
        }
    }

    fn record(&mut self, event: ClaudeCodeEvent, size: usize) {
        if self.log_bytes + size <= MAX_LOG_BYTES {
            self.log_bytes += size;
            self.log.push(event);
        }
    }

    /// A turn is in progress: it started and hasn't sent its result yet.
    pub(super) fn busy(&self) -> bool {
        !self.after_result
            && self
                .log
                .iter()
                .any(|e| matches!(e, ClaudeCodeEvent::Stdout { .. }))
    }

    pub(super) fn replay_to(&self, channel: &Channel<ClaudeCodeEvent>) {
        for event in &self.log {
            if let ClaudeCodeEvent::Stdout { line } = event {
                let head = serde_json::from_str::<LineHead>(line).ok();
                let answered = head
                    .filter(|h| h.kind.as_deref() == Some("control_request"))
                    .and_then(|h| h.request_id)
                    .is_some_and(|id| self.answered.contains(&id));
                if answered {
                    continue;
                }
            }
            let _ = channel.send(event.clone());
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ClaudeCodeEvent {
    Stdout { line: String },
    Stderr { line: String },
    Exit { code: Option<i32> },
}

#[cfg(test)]
mod run_sink_tests {
    use super::*;

    fn out(line: &str) -> ClaudeCodeEvent {
        ClaudeCodeEvent::Stdout {
            line: line.to_string(),
        }
    }

    #[test]
    fn keeps_only_the_turn_in_progress() {
        let mut sink = RunSink::default();
        assert!(!sink.busy());
        sink.emit(out(
            r#"{"type":"system","subtype":"init","session_id":"s-1"}"#,
        ));
        sink.emit(out(r#"{"type":"stream_event","event":{}}"#));
        assert!(sink.busy());
        assert_eq!(sink.session_id.as_deref(), Some("s-1"));
        sink.emit(out(r#"{"type":"result","subtype":"success"}"#));
        assert!(!sink.busy());
        assert_eq!(sink.log.len(), 3);

        // The app's own requests while idle neither start a turn nor clear the last one.
        sink.emit(out(
            r#"{"type":"control_response","response":{"request_id":"nyxs-1"}}"#,
        ));
        assert!(!sink.busy());
        assert_eq!(sink.log.len(), 3);

        // Nor does the next-prompt guess the CLI sends once the turn is over.
        sink.emit(out(
            r#"{"type":"prompt_suggestion","suggestion":"Run the tests","session_id":"s-1"}"#,
        ));
        assert!(!sink.busy());
        assert_eq!(sink.log.len(), 3);

        sink.answered.insert("old".into());
        sink.emit(out(r#"{"type":"user","isReplay":true}"#));
        assert!(sink.busy());
        assert_eq!(sink.log.len(), 1);
        assert!(sink.answered.is_empty());
    }
}
