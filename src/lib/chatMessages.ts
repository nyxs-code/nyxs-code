import type { ChatMessage } from "@/components/Message";
import type { SendPayload } from "@/components/ui/claude-style-chat-input";
import type { Chat, CompactionMark } from "@/lib/chatStore";
import { pickedElementsOf } from "@/lib/pickedElement";
import { closeOpenTools } from "@/lib/toolMarkers";

/** A compaction during the reply `replyId` (Nyxs' own or Claude Code's), as the divider `/compact`
 *  leaves: right before that reply, after the message it answers. It summarized what came before
 *  the reply, and the reply went on from the summary. */
export function compactionBeforeReply(messages: ChatMessage[], replyId: string, mark: Omit<CompactionMark, "afterId">): CompactionMark | null {
  const idx = messages.findIndex((m) => m.id === replyId);
  if (idx < 0) return null;
  // A reply with nothing before it (a turn Claude Code woke on its own) has the divider after it.
  return { afterId: messages[idx - 1]?.id ?? replyId, ...mark };
}

/** A plain text message for the chat box's send path. */
export const textPayload = (message: string, model: string): SendPayload => ({
  message,
  files: [],
  pastedContent: [],
  model,
  isThinkingEnabled: false,
});

/** A copy of `chat` up to and including `messageId`, as a new chat `id`. The summary comes along
 *  only if it covers messages the copy still has. */
export function forkChat(chat: Chat, messageId: string, id: string, title: string): Chat | null {
  const idx = chat.messages.findIndex((m) => m.id === messageId);
  if (idx < 0) return null;
  const messages = chat.messages.slice(0, idx + 1).map((m) => ({ ...m, streaming: false }));
  const keepSummary = (chat.compactedUpTo ?? 0) <= messages.length;
  return {
    id,
    title,
    workspace: chat.workspace,
    messages,
    model: chat.model,
    permissionMode: chat.permissionMode,
    contextTokens: chat.contextTokens,
    summary: keepSummary ? chat.summary : undefined,
    compactedUpTo: keepSummary ? chat.compactedUpTo : undefined,
  };
}

/** Sending a user message again (or an edited version, `text`): the chat goes back to just
 *  before it and the message is sent with its pasted text and picked elements. Null when it
 *  can't be resent (not a user message, has images, or is empty). */
export function resendOf(
  messages: ChatMessage[],
  userMessageId: string,
  text: string | undefined,
  model: string,
): { messages: ChatMessage[]; payload: SendPayload } | null {
  const idx = messages.findIndex((m) => m.id === userMessageId);
  const original = messages[idx];
  if (!original || original.role !== "user" || original.images?.length) return null;
  const message = (text ?? original.content).trim();
  if (!message) return null;
  return {
    messages: messages.slice(0, idx),
    payload: {
      ...textPayload(message, model),
      pastedContent: (original.pasted ?? []).map((content, i) => ({ id: `resend-${i}`, content, timestamp: new Date() })),
      elements: pickedElementsOf(original),
    },
  };
}

/** The user message a reply answered. */
export function userMessageBefore(messages: ChatMessage[], replyId: string): ChatMessage | undefined {
  const idx = messages.findIndex((m) => m.id === replyId);
  for (let i = idx - 1; i >= 0; i--) if (messages[i].role === "user") return messages[i];
  return undefined;
}

/** Whether the reply at `index` can be asked for again: the user message before it must not
 *  carry images, which aren't kept for resending. */
export function canResendBefore(messages: ChatMessage[], index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    if (messages[i].role === "user") return !messages[i].images?.length;
  }
  return false;
}

/** The chat without the reply a reload cut short: everything after its last user message. */
export function dropInterruptedReply(messages: ChatMessage[]): ChatMessage[] {
  let end = messages.length;
  while (end > 0 && messages[end - 1].role === "assistant") end--;
  return end === messages.length ? messages : messages.slice(0, end);
}

/** A reply's text without the markers the chat uses to place tool cards, todos and plans. */
export function stripToolMarkers(text: string): string {
  return text
    .replace(/⟦TOOLEND⟧[\s\S]*?⟦\/TOOLEND⟧/g, "")
    .replace(/⟦TOOL⟧[\s\S]*?⟦\/TOOL⟧/g, "")
    .replace(/⟦TODO⟧|⟦PLAN⟧/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A message that starts a turn in the minimap: one of yours with text, not a notice. */
export const isMinimapTurn = (m: { role: string; notice?: unknown; content?: string }) =>
  m.role === "user" && !m.notice && !!m.content?.trim();

/** A reply that ended without writing anything or calling a tool. */
export const isEmptyReply = (m: ChatMessage) => m.role === "assistant" && !m.content.trim() && !m.toolData;

/** Drops the reply `id` if it ended up empty. */
export function withoutEmptyReply(messages: ChatMessage[], id: string): ChatMessage[] {
  return messages.filter((m) => m.id !== id || !isEmptyReply(m));
}

/** Messages the user queued during a reply were delivered to the model mid-turn: the reply so
 *  far ends there (dropped if still empty), the queued messages follow it, and a new reply
 *  `nextId` starts after them. */
export function withNextSegment(
  messages: ChatMessage[],
  prevId: string,
  delivered: ChatMessage[],
  nextId: string,
  now: number,
): ChatMessage[] {
  const kept = withoutEmptyReply(messages, prevId).map((m) => (m.id === prevId ? { ...m, streaming: false } : m));
  return [...kept, ...delivered, { id: nextId, role: "assistant", content: "", streaming: true, startedAt: now, createdAt: now }];
}

/** The reply after the user stopped it: the tools it was still running show as stopped. */
export function interruptedReply(m: ChatMessage): ChatMessage {
  const content = m.content ? closeOpenTools(m.content.trimEnd()) : "";
  return { ...m, content: (content ? content + "\n\n" : "") + "_⏹ Interrumpido por el usuario._", streaming: false };
}
