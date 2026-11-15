import { useSyncExternalStore } from "react";
import type { ChatMessage } from "@/components/Message";
import type { Chat } from "@/lib/chatStore";
import { SESSION_OPTION_KEY } from "@/lib/claudeCodeText";
import { invoke } from "@/lib/ipc";

/** A Claude Code CLI session of the open project (see cli_sessions.rs). */
export interface CliSessionSummary {
  id: string;
  title: string;
  modifiedAt: number;
  messageCount: number;
  /** "cli" for the terminal, "claude-desktop" for the Claude app, "sdk-cli" for other apps. */
  entrypoint: string;
}

export interface CliMessage {
  role: "user" | "assistant";
  text: string;
}

export const listCliSessions = (workspace: string) => invoke<CliSessionSummary[]>("claude_cli_sessions", { workspace });
export const readCliSession = (workspace: string, id: string) => invoke<CliMessage[]>("claude_cli_session_read", { workspace, id });

/** A CLI session as a Nyxs chat on a Claude Code model. Its last reply carries the CLI's session
 *  id, so the next message resumes that same session (and when the CLI can't find it, from
 *  another Claude Code account say, the conversation goes along as context instead). */
export function chatFromCliSession(opts: {
  chatId: string;
  workspace: string;
  session: CliSessionSummary;
  messages: CliMessage[];
  model: string;
  permissionMode: Chat["permissionMode"];
}): Chat {
  const { chatId, session } = opts;
  const lastReply = opts.messages.map((m) => m.role).lastIndexOf("assistant");
  const messages: ChatMessage[] = opts.messages.map((m, i) => ({
    id: `${chatId}-cli-${i}`,
    role: m.role,
    content: m.text,
    createdAt: session.modifiedAt,
    ...(i === lastReply
      ? { responseMessages: [{ role: "assistant", content: m.text, providerOptions: { [SESSION_OPTION_KEY]: { sessionId: session.id } } }] }
      : {}),
  }));
  const title = session.title.replace(/\s+/g, " ").trim();
  return {
    id: chatId,
    title: title.length > 35 ? `${title.slice(0, 34)}…` : title || "Claude Code",
    workspace: opts.workspace,
    messages,
    model: opts.model,
    permissionMode: opts.permissionMode,
  };
}

/** Whether the /resume list is open. */
let open = false;
const listeners = new Set<() => void>();
export const openCliResume = () => {
  open = true;
  listeners.forEach((l) => l());
};
export const closeCliResume = () => {
  open = false;
  listeners.forEach((l) => l());
};
export const useCliResumeOpen = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
  );
