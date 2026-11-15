/**
 * A session as text to copy out of Nyxs: the whole transcript as Markdown, or a handoff that
 * another model (another app, another chat) can pick the work up from. Only what was said goes
 * out: the app's tool markers, reasoning and notices are left behind.
 */

/** What a session's "Copy ▸" menu offers. */
export type SessionCopy = "handoff" | "markdown" | "id" | "dir";

interface ExportMessage {
  role: string;
  content: string;
  notice?: unknown;
}

export interface ExportLabels {
  user: string;
  assistant: string;
  /** Opens the handoff: what the other model is asked to do with what follows. */
  handoffIntro: string;
  /** "Project: {path}". */
  handoffProject: string;
}

/** A handoff longer than this keeps its newest part: a model's paste box and context are finite. */
const HANDOFF_MAX_CHARS = 60_000;

/** A message's text without the markers the chat uses for tool cards, reasoning, todos and plans. */
function plainText(content: string): string {
  return content
    .replace(/⟦(TOOL|TOOLEND|REASONING)⟧[\s\S]*?⟦\/\1⟧/g, "")
    .replace(/⟦(?:TODO|PLAN)⟧/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function turns(messages: ExportMessage[]): { role: "user" | "assistant"; text: string }[] {
  return messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && !m.notice)
    .map((m) => ({ role: m.role as "user" | "assistant", text: plainText(m.content ?? "") }))
    .filter((m) => m.text);
}

/** The conversation as Markdown: the title, then each message under who wrote it. */
export function sessionMarkdown(title: string, messages: ExportMessage[], labels: ExportLabels): string {
  const parts = [`# ${title.trim() || "Nyxs"}`];
  for (const m of turns(messages)) parts.push(`## ${m.role === "user" ? labels.user : labels.assistant}\n\n${m.text}`);
  return `${parts.join("\n\n")}\n`;
}

/** The conversation as a prompt for another model: what to do, where, and what was said. */
export function sessionHandoff(title: string, workspace: string | null | undefined, messages: ExportMessage[], labels: ExportLabels): string {
  let body = turns(messages)
    .map((m) => `[${m.role === "user" ? labels.user : labels.assistant}]\n${m.text}`)
    .join("\n\n");
  if (body.length > HANDOFF_MAX_CHARS) body = `…${body.slice(-HANDOFF_MAX_CHARS)}`;
  const head = [labels.handoffIntro, title.trim() ? `# ${title.trim()}` : "", workspace ? labels.handoffProject.replace("{path}", workspace) : ""].filter(Boolean);
  return `${head.join("\n")}\n\n${body}\n`;
}
