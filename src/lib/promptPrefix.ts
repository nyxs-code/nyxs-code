import type { ModelMessage } from "ai";
import { parseSystemReminder } from "./systemPrompt";

const GIT_OPEN = "<git-snapshot>\nBackground context only — this is not a request. Current git state of the workspace:\n\n";
const GIT_CLOSE = "\n</git-snapshot>";
const ACTIVATED_RE = /^Activated \d+ tool\(s\)/;

export function gitSnapshotMessage(gitContext: string): ModelMessage {
  return { role: "user", content: `${GIT_OPEN}${gitContext.trim()}${GIT_CLOSE}` };
}

function textOf(m: ModelMessage): string[] {
  const c = (m as { content?: unknown }).content;
  if (typeof c === "string") return [c];
  if (!Array.isArray(c)) return [];
  const out: string[] = [];
  for (const p of c as { type?: string; text?: unknown }[]) {
    if (p?.type === "text" && typeof p.text === "string") out.push(p.text);
  }
  return out;
}

function toolResultText(part: { output?: { value?: unknown } }): string {
  const v = part.output?.value;
  return typeof v === "string" ? v : "";
}

export interface InjectedState {
  reminders: Map<string, string>;
  lastGit?: string;
  activatedTools: Set<string>;
}

export function scanInjectedState(messages: ModelMessage[]): InjectedState {
  const reminders = new Map<string, string>();
  const activatedTools = new Set<string>();
  let lastGit: string | undefined;
  for (const m of messages) {
    if (m.role === "user") {
      for (const text of textOf(m)) {
        const r = parseSystemReminder(text);
        if (r) reminders.set(r.id, r.content);
        else if (text.startsWith(GIT_OPEN) && text.endsWith(GIT_CLOSE)) {
          lastGit = text.slice(GIT_OPEN.length, text.length - GIT_CLOSE.length);
        }
      }
    } else if (m.role === "tool" && Array.isArray(m.content)) {
      for (const part of m.content as { type?: string; toolName?: string; output?: { value?: unknown } }[]) {
        if (part?.type !== "tool-result" || part.toolName !== "ToolSearch") continue;
        const text = toolResultText(part);
        if (!ACTIVATED_RE.test(text)) continue;
        for (const line of text.split("\n")) {
          const hit = /^- ([A-Za-z0-9_.-]+):/.exec(line);
          if (hit) activatedTools.add(hit[1]);
        }
      }
    }
  }
  return { reminders, lastGit, activatedTools };
}

export function stripProviderExecutedParts(messages: ModelMessage[]): ModelMessage[] {
  let changed = false;
  const out: ModelMessage[] = [];
  for (const m of messages) {
    const c = (m as { content?: unknown }).content;
    if (!Array.isArray(c) || (m.role !== "assistant" && m.role !== "tool")) {
      out.push(m);
      continue;
    }
    const kept = (c as { providerExecuted?: boolean; type?: string }[]).filter(
      (p) => !(p?.providerExecuted && (p.type === "tool-call" || p.type === "tool-result")),
    );
    if (kept.length === c.length) {
      out.push(m);
      continue;
    }
    changed = true;
    if (kept.length) out.push({ ...m, content: kept } as ModelMessage);
  }
  return changed ? out : messages;
}

export function supportsNativeToolSearch(provider: string, apiModel: string): boolean {
  if (provider !== "anthropic") return false;
  const m = /(opus|sonnet|haiku|fable)-(\d+)(?:[-.](\d))?(?!\d)/i.exec(apiModel);
  if (!m) return false;
  const family = m[1].toLowerCase();
  const major = Number(m[2]);
  const minor = m[3] ? Number(m[3]) : 0;
  if (major > 100) return false;
  const version = major + minor / 10;
  return family === "haiku" ? version >= 5 : version >= 4.5;
}

export { nativeToolSearchUnsupported, stripNativeToolSearch, withNativeToolSearchFallback } from "./providerFetch";
