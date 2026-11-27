import type { ChatMessage } from "@/components/Message";
import type { CloudEvent, CloudThreadStatus } from "@/lib/cloud/cloudApi";
import type { ThreadStatus } from "./types";

// A cloud thread is a Nyxs session whose replies come from the events API instead of a local
// turn (docs/proyectos-nube-spec.md, Phase 3). These turn the worker's events into the chat's
// messages, the same markers a local turn writes, so the transcript reads the same.

/** A cloud thread's status as the app keeps it. */
export function threadStatusOfCloud(s: CloudThreadStatus | string | undefined): ThreadStatus | undefined {
  switch (s) {
    case "queued":
    case "working":
      return "working";
    case "needs_input":
    case "review":
    case "resolved":
    case "failed":
      return s;
    case "stopped":
      return "idle";
    default:
      return undefined;
  }
}

/** What an event asks of the app besides the transcript. */
export type CloudEffect =
  | { kind: "status"; status: ThreadStatus }
  | { kind: "report"; text: string; status: ThreadStatus }
  | { kind: "done"; status: ThreadStatus; preview: string; prUrl?: string; branch?: string; error?: string };

/** A failure as the transcript shows it: quoted, line by line. */
const quoted = (text: string) => `> ${text.replace(/\n/g, "\n> ")}`;

const str = (v: unknown) => (typeof v === "string" ? v : "");
const REPORTABLE: ThreadStatus[] = ["working", "needs_input", "review", "failed"];

/** The thread's messages after `events`, and what they ask of the app. Events at or before
 *  `seq` were applied already (a reload, a second follower) and are skipped. */
export function applyCloudEvents(
  messages: ChatMessage[],
  events: CloudEvent[],
  seq: number,
  idFor: (seq: number) => string,
): { messages: ChatMessage[]; seq: number; effects: CloudEffect[] } {
  let out = messages;
  let last = seq;
  const effects: CloudEffect[] = [];
  /** The reply events go into: the last message when it's the assistant's, else a new one. */
  const reply = (ev: CloudEvent, fresh = false): ChatMessage => {
    const tail = out[out.length - 1];
    if (!fresh && tail?.role === "assistant") return tail;
    if (fresh && tail?.role === "assistant" && !tail.content.trim()) return tail;
    const at = Date.parse(ev.at) || Date.now();
    const m: ChatMessage = { id: idFor(ev.seq), role: "assistant", content: "", createdAt: at, startedAt: at, streaming: true };
    out = [...out, m];
    return m;
  };
  const patch = (m: ChatMessage, next: Partial<ChatMessage>) => {
    out = out.map((x) => (x.id === m.id ? { ...x, ...next } : x));
  };
  for (const ev of events) {
    if (ev.seq <= last) continue;
    last = ev.seq;
    const d = ev.data ?? {};
    switch (ev.type) {
      // A prompt or follow-up. One sent from this app is in the transcript already, marked as
      // waiting for its event: it takes the mark off instead of showing twice. Any other (from a
      // catch-up, another computer) comes in under an id from its seq.
      case "user": {
        const text = str(d.text);
        const pending = out.find((m) => m.role === "user" && m.cloudPending);
        if (pending) {
          out = out.map((m) => (m.id === pending.id ? { ...m, cloudPending: undefined } : m));
          break;
        }
        if (!text) break;
        const tail = out[out.length - 1];
        if (tail?.role === "assistant") patch(tail, { streaming: false });
        out = [...out, { id: idFor(ev.seq), role: "user", content: text, createdAt: Date.parse(ev.at) || Date.now() }];
        break;
      }
      case "start":
        reply(ev, true);
        break;
      case "text": {
        const m = reply(ev);
        patch(m, { content: m.content + str(d.text), streaming: true });
        break;
      }
      case "tool": {
        const id = str(d.id) || `cloud-tool-${ev.seq}`;
        const name = str(d.name) || "Tool";
        const m = reply(ev);
        patch(m, {
          content: `${m.content}\n\n⟦TOOL⟧${id}⟦SEP⟧${name}⟦SEP⟧${str(d.detail)}⟦/TOOL⟧\n\n`,
          toolData: { ...m.toolData, [id]: { name, detail: str(d.detail) } },
        });
        break;
      }
      case "tool_result": {
        const id = str(d.id);
        if (!id) break;
        const m = reply(ev);
        const before = m.toolData?.[id] ?? { name: str(d.name), detail: "" };
        const extra = {
          ...(str(d.output) ? { output: str(d.output) } : {}),
          ...(typeof d.added === "number" ? { added: d.added, removed: typeof d.removed === "number" ? d.removed : 0 } : {}),
        };
        patch(m, { content: `${m.content}⟦TOOLEND⟧${id}⟦SEP⟧ok⟦/TOOLEND⟧`, toolData: { ...m.toolData, [id]: { ...before, ...extra } } });
        break;
      }
      case "error": {
        const m = reply(ev);
        const message = str(d.message);
        if (message) patch(m, { content: `${m.content}${m.content.trim() ? "\n\n" : ""}${quoted(message)}` });
        break;
      }
      case "status": {
        const status = threadStatusOfCloud(str(d.status));
        if (status) effects.push({ kind: "status", status });
        break;
      }
      case "report": {
        const status = str(d.status) as ThreadStatus;
        effects.push({ kind: "report", text: str(d.text), status: REPORTABLE.includes(status) ? status : "review" });
        break;
      }
      case "done": {
        // Publishing can fail with the turn's work done ("push failed", "no GitHub token"): the
        // status stays, and the reason shows, so the user knows why there's no pull request.
        const error = str(d.error);
        if (error) {
          const m = reply(ev);
          if (!m.content.includes(quoted(error))) patch(m, { content: `${m.content}${m.content.trim() ? "\n\n" : ""}${quoted(error)}` });
        }
        const tail = out[out.length - 1];
        if (tail?.role === "assistant") patch(tail, { streaming: false });
        effects.push({
          kind: "done",
          status: threadStatusOfCloud(str(d.status)) ?? "review",
          preview: str(d.preview),
          ...(str(d.prUrl) ? { prUrl: str(d.prUrl) } : {}),
          ...(str(d.branch) ? { branch: str(d.branch) } : {}),
          ...(error ? { error } : {}),
        });
        break;
      }
      default:
        // start of a dry run, todos, usage, output limits: nothing to show here.
        break;
    }
  }
  return { messages: out, seq: last, effects };
}
