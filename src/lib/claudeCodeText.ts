import type { ChatTurn } from "./ai";
import { EDIT_TOOLS } from "./permissions";
import { detectReplyLanguage, languageCheckNote } from "./replyLanguage";
import { describeToolCall } from "./agentTools";
import type { Json } from "./claudeCodeProcesses";

// Pure helpers between a chat's turns and Claude Code's stream-json messages (with tests).

export const SESSION_OPTION_KEY = "claudeCode";
const PRIOR_CONTEXT_CHAR_BUDGET = 60_000;
const MARKER_RE = /⟦(TOOL|TOOLEND|REASONING)⟧[\s\S]*?⟦\/\1⟧|⟦(?:TODO|PLAN)⟧/g;

export function sessionIdOf(turn: ChatTurn): string | undefined {
  return resumePointOf(turn)?.sessionId;
}

/** The session a reply came from and, when known, the uuid of its last message in that session. */
export function resumePointOf(turn: ChatTurn): { sessionId: string; at?: string } | undefined {
  for (const m of turn.messages ?? []) {
    const opts = (m as { providerOptions?: Record<string, Json> }).providerOptions;
    const { sessionId, at } = opts?.[SESSION_OPTION_KEY] ?? {};
    if (typeof sessionId === "string" && sessionId) return { sessionId, at: typeof at === "string" && at ? at : undefined };
  }
  return undefined;
}

export function plainText(content: string): string {
  return content.replace(MARKER_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function priorContext(turns: ChatTurn[]): string {
  const text = turns
    .map((t) => ({ role: t.role, body: plainText(t.content) }))
    .filter((t) => t.body)
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.body}`)
    .join("\n\n");
  if (!text) return "";
  const clipped = text.length > PRIOR_CONTEXT_CHAR_BUDGET ? `…${text.slice(-PRIOR_CONTEXT_CHAR_BUDGET)}` : text;
  return `<earlier_conversation>\n${clipped}\n</earlier_conversation>\n\n`;
}

export function userContent(turn: ChatTurn, preamble: string): Json[] {
  const blocks: Json[] = [];
  const lang = detectReplyLanguage(turn.content);
  const text = preamble + turn.content + (lang ? `\n\n${languageCheckNote(lang)}` : "");
  if (text.trim()) blocks.push({ type: "text", text });
  for (const img of turn.images ?? []) {
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(img.dataUrl);
    if (m) blocks.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
  }
  if (!blocks.length) blocks.push({ type: "text", text: "(empty message)" });
  return blocks;
}

export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: string; text: string } => !!c && (c as Json).type === "text" && typeof (c as Json).text === "string")
    .map((c) => c.text)
    .join("\n");
}

export function shortError(text: string): string {
  const flat = text.replace(/<\/?tool_use_error>/g, "").replace(/⟦|⟧/g, "").trim().split(/\r?\n/).slice(0, 3).join(" ");
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

export function toolLabel(name: string, input: Json): { name: string; detail: string } {
  if (name === "PowerShell") return { name, detail: String(input.command ?? "") };
  if (name === "Task") return describeToolCall("Agent", input);
  if (name === "NotebookEdit") return { name, detail: String(input.notebook_path ?? "") };
  return describeToolCall(name, input);
}

export function editedPath(toolName: string, input: Json): string | null {
  if (EDIT_TOOLS.has(toolName)) return typeof input.file_path === "string" ? input.file_path : null;
  if (toolName === "NotebookEdit") return typeof input.notebook_path === "string" ? input.notebook_path : null;
  return null;
}

export function isAuthFailure(text: string, apiError: string | null): boolean {
  return apiError === "authentication_failed" || /not logged in|please run \/login|invalid api key|oauth token/i.test(text);
}
