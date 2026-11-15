import type { ModelMessage } from "ai";
import { summarizeConversation, type ChatTurn } from "@/lib/ai";
import type { Chat } from "@/lib/chatStore";
import { claudeCodeSessionOf, compactClaudeCodeSession } from "@/lib/claudeCode";
import { getContinuationMessage } from "@/lib/compact";
import type { EffortLevel } from "@/lib/effort";
import { emitEvent } from "@/lib/events";
import { estimateMessageTokens } from "@/lib/microcompact";
import { getModel } from "@/lib/models";
import type { Settings } from "@/lib/settings";
import { clearSystemPromptCache } from "@/lib/systemPrompt";

/** Messages kept word for word after the summary. */
const KEEP_RECENT = 6;

interface CompactOptions {
  chat: Chat;
  modelId: string;
  settings: Settings;
  workspace: string | null;
  planMode: boolean;
  effort: EffortLevel;
  signal?: AbortSignal;
  /** Called once compacting really starts (not when there is too little to compact). */
  onStart: () => void;
}

type ChatPatch = Partial<Pick<Chat, "summary" | "compactedUpTo" | "contextTokens">>;

/** `/compact`: shrinks what the model sees of a chat. Returns the fields to update on the chat,
 *  or "tooShort" when there isn't enough conversation yet. Throws when it fails; the chat
 *  then stays as it was. */
export async function compactChat(o: CompactOptions): Promise<ChatPatch | "tooShort"> {
  const { chat, modelId, settings, signal } = o;
  const msgs = chat.messages;
  const model = getModel(modelId, settings);

  // Claude Code keeps the conversation itself and every turn resumes it, so only its
  // own /compact shrinks what the model sees.
  const claudeSessionId =
    model?.provider === "claude-code" ? claudeCodeSessionOf(msgs.map((m) => m.responseMessages)) : undefined;
  if (model && claudeSessionId) {
    o.onStart();
    const after = await compactClaudeCodeSession(
      { model, workspace: o.workspace, planMode: o.planMode, effort: o.effort, signal, chatKey: chat.id },
      claudeSessionId,
    );
    emitEvent({ type: "compaction.triggered", kind: "summary" });
    return after?.totalTokens ? { contextTokens: after.totalTokens } : {};
  }

  const compactedUpTo = chat.compactedUpTo ?? 0;
  if (msgs.length - compactedUpTo <= 2) return "tooShort";
  // Keeps the latest messages verbatim; when there's nothing older than them, summarizes them all
  // instead of re-summarizing only the previous summary.
  let upTo = Math.max(compactedUpTo, msgs.length - KEEP_RECENT);
  if (upTo === compactedUpTo) upTo = msgs.length;
  o.onStart();
  clearSystemPromptCache();
  const toSummarize: ChatTurn[] = [];
  if (chat.summary) toSummarize.push({ role: "user", content: `Previous conversation summary:\n${chat.summary}` });
  const summarized = msgs.slice(compactedUpTo, upTo);
  for (const m of summarized) toSummarize.push({ role: m.role, content: m.content, messages: m.responseMessages });
  const summary = await summarizeConversation(modelId, settings, toSummarize, signal);
  if (!summary.trim()) throw new Error("el modelo devolvió un resumen vacío.");
  emitEvent({ type: "compaction.triggered", kind: "summary" });
  // An estimate until the next reply reports the exact size: what was summarized
  // (and the old summary) leaves the context, the new summary enters it.
  const freed = estimateMessageTokens([
    ...(chat.summary ? [{ role: "user" as const, content: getContinuationMessage(chat.summary) }] : []),
    ...summarized.flatMap((m): ModelMessage[] =>
      m.responseMessages?.length ? m.responseMessages : [{ role: m.role, content: m.content } as ModelMessage],
    ),
  ]);
  const added = estimateMessageTokens([{ role: "user", content: getContinuationMessage(summary) }]);
  const before = chat.contextTokens ?? 0;
  return {
    summary,
    compactedUpTo: upTo,
    ...(before ? { contextTokens: Math.max(added, before - freed + added) } : {}),
  };
}
