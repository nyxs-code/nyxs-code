import type { Dispatch, SetStateAction } from "react";
import type { ChatMessage } from "@/components/Message";
import { RESUME_AFTER_RELOAD_PROMPT, type AssistantTurn } from "@/lib/assistantTurn";
import { backgroundNotice, type FinishedShell } from "@/lib/backgroundWake";
import type { ChatHistory } from "@/lib/chatHistory";
import { dropInterruptedReply, isEmptyReply } from "@/lib/chatMessages";
import type { Chat } from "@/lib/chatStore";
import { claudeCodeSessionOf } from "@/lib/claudeCode";
import { takeInterruptedApiTurns, type InterruptedTurn } from "@/lib/interruptedTurns";
import { getModel } from "@/lib/models";
import { hasKey, type Settings } from "@/lib/settings";

const uid = () => Math.random().toString(36).slice(2, 11);

/** What waking a chat reads and changes in the app; built when the chat is woken. */
export interface WakeEnv {
  settings: Settings;
  /** The model in use, for a chat that doesn't keep one of its own. */
  effectiveModel: string;
  workspace: string | null;
  /** The chats as they are right now. */
  liveChats: () => Chat[];
  /** A turn is already running in the chat (it has an abort controller). */
  turnRunning: (chatId: string) => boolean;
  /** The chat shows a reply streaming. */
  streaming: (chatId: string) => boolean;
  ensureHydrated: (chatId: string) => Promise<unknown>;
  setChats: Dispatch<SetStateAction<Chat[]>>;
  buildChatHistory: (chatId: string) => Promise<Pick<ChatHistory, "history" | "compaction">>;
  streamTurn: (turn: AssistantTurn) => Promise<void>;
}

const turnDirs = (chat: Chat, workspace: string | null) => ({
  workspace: chat.worktree?.path ?? chat.workspace ?? workspace,
  sessionWorkspace: chat.workspace ?? workspace,
});

/** An API model that can run a turn in this page: known, not Claude Code, with a key. */
function canRunApiTurn(modelId: string, settings: Settings): boolean {
  const model = getModel(modelId, settings);
  return !!model && model.provider !== "claude-code" && hasKey(settings, model.provider);
}

/** Background shells a chat started have finished while it was idle: a notice listing them
 *  goes in the chat and the agent gets a turn to deal with their output. Claude Code chats
 *  are woken by Claude Code itself (`wakeClaudeCodeChat`). */
export async function wakeChatForShells(chatId: string, shells: FinishedShell[], env: WakeEnv): Promise<void> {
  const chat = env.liveChats().find((c) => c.id === chatId);
  if (!chat || env.turnRunning(chatId)) return;
  const modelId = chat.model && getModel(chat.model, env.settings) ? chat.model : env.effectiveModel;
  if (!canRunApiTurn(modelId, env.settings)) return;
  const { history, compaction } = await env.buildChatHistory(chatId);
  const content = backgroundNotice(shells);
  const notice: ChatMessage = {
    id: uid(),
    role: "user",
    content,
    notice: { kind: "background", items: shells.map((s) => ({ id: s.id, title: s.title, status: s.status, code: s.code, ...(s.lines !== undefined && { lines: s.lines }) })) },
    createdAt: Date.now(),
  };
  env.setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, messages: [...c.messages, notice] } : c)));
  history.push({ role: "user", content });
  await env.streamTurn({ chatId, modelId, history, thinking: false, ...turnDirs(chat, env.workspace), snapshotId: notice.id, compaction });
}

/** When a background task wakes Claude Code after a turn has ended, its new turn shows as a
 *  reply in the chat that owns the session, like in Claude Code itself. A turn that was
 *  running when the app's page reloaded comes back the same way (`resumed`): Claude Code kept
 *  working, and its reply is rebuilt from the start in place of the one cut short. Returns
 *  whether a chat took the turn. */
export function wakeClaudeCodeChat(sessionId: string, opts: { chatKey?: string; resumed: boolean }, env: WakeEnv): boolean {
  const chats = env.liveChats();
  const chat =
    (opts.chatKey ? chats.find((c) => c.id === opts.chatKey) : undefined) ??
    chats.find((c) => claudeCodeSessionOf(c.messages.map((m) => m.responseMessages)) === sessionId);
  if (!chat || env.streaming(chat.id)) return false;
  const modelId = chat.model && getModel(chat.model, env.settings)?.provider === "claude-code" ? chat.model : env.effectiveModel;
  if (getModel(modelId, env.settings)?.provider !== "claude-code") return false;
  void (async () => {
    if (opts.resumed) {
      await env.ensureHydrated(chat.id);
      env.setChats((prev) => prev.map((c) => (c.id === chat.id ? { ...c, messages: dropInterruptedReply(c.messages) } : c)));
    }
    await env.streamTurn({ chatId: chat.id, modelId, history: [], thinking: false, ...turnDirs(chat, env.workspace), attachSession: sessionId });
  })();
  return true;
}

/** Starts a new turn that picks up the task where the cut reply left it: the reply stays as it
 *  was (no longer streaming, without the cut mark), and a resume notice goes after it. */
async function resumeTurn(chat: Chat, saved: Pick<InterruptedTurn, "modelId" | "thinking">, env: WakeEnv): Promise<void> {
  const chatId = chat.id;
  const notice: ChatMessage = {
    id: uid(),
    role: "user",
    content: RESUME_AFTER_RELOAD_PROMPT,
    notice: { kind: "resume", items: [] },
    createdAt: Date.now(),
  };
  env.setChats((prev) =>
    prev.map((c) =>
      c.id === chatId
        ? {
            ...c,
            messages: [
              ...c.messages
                .map((m) => (m.streaming || m.cutOff ? { ...m, streaming: false, cutOff: undefined } : m))
                .filter((m) => !isEmptyReply(m)),
              notice,
            ],
          }
        : c,
    ),
  );
  // The history is read back from the chats once the change above has landed.
  await new Promise((r) => setTimeout(r, 0));
  const { history, compaction } = await env.buildChatHistory(chatId);
  void env.streamTurn({ chatId, modelId: saved.modelId, history, thinking: saved.thinking, ...turnDirs(chat, env.workspace), snapshotId: notice.id, compaction });
}

/** Leaves the cut reply marked as such, with the model it ran on, so the chat offers to continue
 *  it. A reply that never got saved is added empty to carry the mark. */
function markCutOff(chatId: string, saved: InterruptedTurn, env: WakeEnv): void {
  const cutOff = { modelId: saved.modelId, thinking: saved.thinking };
  env.setChats((prev) =>
    prev.map((c) => {
      if (c.id !== chatId) return c;
      const messages = c.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m));
      const last = messages[messages.length - 1];
      if (last?.role === "assistant" && !last.notice && !last.fromSession) {
        messages[messages.length - 1] = { ...last, cutOff };
      } else {
        messages.push({ id: uid(), role: "assistant", content: "", createdAt: Date.now(), cutOff });
      }
      return { ...c, messages };
    }),
  );
}

/** Deals with the API-model turns an earlier page left running (see interruptedTurns): one cut a
 *  short while ago, or by a reload, carries on by itself; any other leaves its reply marked as
 *  cut, with a button to continue it. */
export async function resumeInterruptedTurns(env: WakeEnv): Promise<void> {
  const turns = await takeInterruptedApiTurns();
  for (const [chatId, saved] of Object.entries(turns)) {
    await env.ensureHydrated(chatId);
    const chat = env.liveChats().find((c) => c.id === chatId);
    if (!chat || env.turnRunning(chatId)) continue;
    if (saved.auto && canRunApiTurn(saved.modelId, env.settings)) await resumeTurn(chat, saved, env);
    else markCutOff(chatId, saved, env);
  }
}

// Chats whose cut reply is being continued, so a second click doesn't start a second turn
// before the first one shows as running.
const continuing = new Set<string>();

/** The user asked to continue a reply the app cut: it carries on on the model it ran on (or the
 *  chat's, if that model is gone). */
export async function continueCutTurn(chatId: string, env: WakeEnv): Promise<void> {
  if (continuing.has(chatId) || env.turnRunning(chatId) || env.streaming(chatId)) return;
  const chat = env.liveChats().find((c) => c.id === chatId);
  const cutOff = chat?.messages.slice().reverse().find((m) => m.cutOff)?.cutOff;
  if (!chat || !cutOff) return;
  const modelId = getModel(cutOff.modelId, env.settings) ? cutOff.modelId : (chat.model && getModel(chat.model, env.settings) ? chat.model : env.effectiveModel);
  continuing.add(chatId);
  try {
    await resumeTurn(chat, { modelId, thinking: cutOff.thinking }, env);
  } finally {
    continuing.delete(chatId);
  }
}
