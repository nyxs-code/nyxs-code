import type { ModelMessage } from "ai";

export interface RecallEntry {
  index: number;
  role: "user" | "assistant";
  content: string;
  responseMessages?: ModelMessage[];
}

const CONTEXT_CHARS = 300;
const MAX_HITS = 8;

function stripMarkers(text: string): string {
  return text
    .replace(/⟦TOOLEND⟧[\s\S]*?⟦\/TOOLEND⟧/g, "")
    .replace(/⟦TOOL⟧[\s\S]*?⟦\/TOOL⟧/g, "")
    .replace(/⟦REASONING⟧[\s\S]*?⟦\/REASONING⟧/g, "")
    .replace(/⟦TODO⟧|⟦PLAN⟧/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function partsText(messages: ModelMessage[]): string {
  const out: string[] = [];
  for (const m of messages) {
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string") {
      out.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const p of content as { type?: string; text?: string; toolName?: string; input?: unknown; output?: { value?: unknown } }[]) {
      if (p?.type === "text" && p.text) out.push(p.text);
      else if (p?.type === "tool-call") out.push(`[tool call ${p.toolName}] ${safeJson(p.input)}`);
      else if (p?.type === "tool-result") {
        const v = p.output?.value;
        out.push(`[tool result ${p.toolName}] ${typeof v === "string" ? v : safeJson(v)}`);
      }
    }
  }
  return out.join("\n");
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

function entryText(e: RecallEntry): string {
  return e.role === "assistant" && e.responseMessages?.length ? partsText(e.responseMessages) : stripMarkers(e.content);
}

function window(text: string, at: number, len: number): string {
  const start = Math.max(0, at - CONTEXT_CHARS);
  const end = Math.min(text.length, at + len + CONTEXT_CHARS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export function recallFromSession(entries: RecallEntry[], query: string, maxHits = MAX_HITS): string {
  const q = query.trim().toLowerCase();
  if (!q) return "Give a word, file name, error text or command to look for.";
  const words = q.split(/\s+/).filter((w) => w.length > 1);
  type Hit = { index: number; role: string; score: number; at: number; len: number; text: string };
  const hits: Hit[] = [];
  for (const e of entries) {
    const text = entryText(e);
    if (!text) continue;
    const lower = text.toLowerCase();
    let from = 0;
    let exact = lower.indexOf(q, from);
    while (exact !== -1 && hits.length < maxHits * 4) {
      hits.push({ index: e.index, role: e.role, score: 100 + words.length, at: exact, len: q.length, text });
      from = exact + q.length + CONTEXT_CHARS;
      exact = lower.indexOf(q, from);
    }
    if (lower.includes(q) || words.length < 2) continue;
    const lines = text.split("\n");
    let offset = 0;
    for (const line of lines) {
      const l = line.toLowerCase();
      const score = words.filter((w) => l.includes(w)).length;
      if (score >= Math.max(2, Math.ceil(words.length / 2))) {
        hits.push({ index: e.index, role: e.role, score, at: offset, len: line.length, text });
      }
      offset += line.length + 1;
    }
  }
  if (!hits.length) return `No match for "${query}" in this conversation.`;
  hits.sort((a, b) => b.score - a.score || b.index - a.index);
  const shown = hits.slice(0, maxHits);
  const body = shown
    .map((h) => `--- message ${h.index + 1} (${h.role}) ---\n${window(h.text, h.at, h.len)}`)
    .join("\n\n");
  const more = hits.length > shown.length ? `\n\n[${hits.length - shown.length} more matches; refine the query to see them.]` : "";
  return `${shown.length} match(es) for "${query}" in the full conversation history:\n\n${body}${more}`;
}
