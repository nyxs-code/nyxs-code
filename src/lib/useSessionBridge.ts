import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { ChatMessage } from "@/components/Message";
import type { Chat } from "@/lib/chatStore";
import { stripToolMarkers } from "@/lib/chatMessages";
import { getModel, PROVIDERS } from "@/lib/models";
import { hasKey, type Settings } from "@/lib/settings";
import { attributedMessage, reportMessage, setSessionBridge, type SendOutcome } from "@/lib/sessionBridge";
import { drivableModels, resolveEffort, resolveSessionModel } from "@/lib/sessionModels";
import { EFFORT_LEVELS, type EffortLevel } from "@/lib/effort";
import { newSessionId, saveSession, setSessionArchived, renameSession, type SessionSummary } from "@/lib/sessionStorage";
import { workspaceName } from "@/lib/workspace";
import { useTranslations } from "@/lib/i18n";
import type { AssistantTurn } from "@/lib/assistantTurn";
import type { ChatHistory } from "@/lib/chatHistory";
import { sessionTookMessages } from "@/lib/sessionMessageGuard";
import { markRead, markReplied, noteDelivery } from "@/lib/sessionDelivery";

interface Deps {
  streamAssistantTurn: (turn: AssistantTurn) => Promise<void>;
  chats: Chat[];
  sessions: SessionSummary[];
  setChats: Dispatch<SetStateAction<Chat[]>>;
  abortControllers: RefObject<Map<string, AbortController>>;
  /** Each running turn's end, by chat. */
  turnsDone: RefObject<Map<string, Promise<void>>>;
  hydratedRef: RefObject<Set<string>>;
  refreshSessions: () => void;
  workspace: string | null;
  settings: Settings;
  effectiveModel: string;
  /** The effort the app's turns run at now. */
  effort: () => EffortLevel;
  buildChatHistory: (chatId: string) => Promise<ChatHistory>;
  liveChatsRef: RefObject<Chat[]>;
}

const plainText = (content: string) => stripToolMarkers(content.replace(/⟦REASONING⟧[\s\S]*?⟦\/REASONING⟧/g, "")).trim();

/** Hands the session tools (src/tools/Sessions) what they act on: the app's sessions. */
export function useSessionBridge(deps: Deps): void {
  const t = useTranslations();
  const ref = useRef(deps);
  useEffect(() => { ref.current = deps; });

  useEffect(() => {
    const d = () => ref.current;
    const live = (id: string) => d().liveChatsRef.current?.find((c) => c.id === id);
    const summary = (id: string) => d().sessions.find((s) => s.id === id);
    const titleOf = (id: string) => live(id)?.title || summary(id)?.title || id;
    const busy = (id: string) => d().abortControllers.current.has(id);

    /** The model a session's turns run on, if it can be driven from here: with a key, and not an
     *  agent that runs its own terminal. */
    const usableModel = (wanted: string | undefined): string | null => {
      const modelId = wanted && getModel(wanted, d().settings) ? wanted : d().effectiveModel;
      const model = getModel(modelId, d().settings);
      if (!model || !hasKey(d().settings, model.provider) || PROVIDERS[model.provider]?.kind === "agent-cli") return null;
      return modelId;
    };

    /** Waits for the session's running turn (and any that follows it straight away) to end. */
    const whenIdle = async (id: string) => {
      for (let i = 0; i < 1000 && busy(id); i++) {
        await (d().turnsDone.current?.get(id) ?? new Promise((r) => setTimeout(r, 300)));
      }
    };

    /** Adds `messages` to the session and runs one turn on them; resolves when that turn ends.
     *  Only a session whose messages are loaded is saved afterwards, so a partial one never
     *  overwrites its transcript. */
    const runTurn = async (id: string, modelId: string, messages: ChatMessage[]) => {
      // Load its messages first: loading them later would replace the ones added here.
      await d().buildChatHistory(id);
      const add = (c: Chat) => (c.id === id ? { ...c, messages: [...c.messages, ...messages] } : c);
      d().setChats((prev) => prev.map(add));
      // The live list catches up with the state on the next render; the history is built now.
      d().liveChatsRef.current = (d().liveChatsRef.current ?? []).map(add);
      const { history, compaction } = await d().buildChatHistory(id);
      const fresh = live(id);
      await d().streamAssistantTurn({
        chatId: id,
        modelId,
        effort: fresh?.effort,
        history,
        thinking: false,
        workspace: fresh?.worktree?.path ?? fresh?.workspace ?? d().workspace,
        sessionWorkspace: fresh?.workspace ?? d().workspace,
        snapshotId: messages[0].id,
        compaction,
      });
      const done = live(id);
      const ws = done?.workspace ?? d().workspace;
      if (done && ws && d().hydratedRef.current?.has(id)) {
        await saveSession(ws, done, Date.now()).catch(() => undefined);
        d().refreshSessions();
      }
    };

    /** Per session, the end of the last turn the bridge has lined up. Turns the bridge starts
     *  chain on it, so two messages arriving together run one after the other: checking `busy`
     *  alone let both wake from `whenIdle` at once (and a turn isn't busy until its history is
     *  built), which ran two turns side by side in the same session. */
    const lines = new Map<string, Promise<void>>();
    const enqueue = (id: string, run: () => Promise<void>): Promise<void> => {
      const prev = lines.get(id) ?? Promise.resolve();
      const next = prev.then(() => whenIdle(id)).then(run).catch(() => undefined);
      lines.set(id, next);
      void next.then(() => { if (lines.get(id) === next) lines.delete(id); });
      return next;
    };

    /** Messages waiting for the session's next turn, and the model it runs on. */
    const waiting = new Map<string, { modelId: string; messages: ChatMessage[] }>();

    /** Delivers a message to the session now, or once its running turn ends. Every message that
     *  arrives while it waits joins the same next turn, so the session reads them together
     *  instead of answering each in a turn of its own. */
    const deliver = (id: string, modelId: string, message: ChatMessage): "sent" | "queued" => {
      const queued = busy(id) || lines.has(id);
      const batch = waiting.get(id);
      if (batch) {
        batch.modelId = modelId;
        batch.messages.push(message);
      } else {
        waiting.set(id, { modelId, messages: [message] });
        void enqueue(id, async () => {
          // Taken when the turn starts, so everything that came in during the wait goes in it.
          const ready = waiting.get(id);
          waiting.delete(id);
          sessionTookMessages(id);
          if (ready?.messages.length) markRead(ready.messages.map((m) => m.id));
          if (ready?.messages.length) await runTurn(id, ready.modelId, ready.messages);
        });
      }
      return queued ? "queued" : "sent";
    };

    const userMessage = (content: string, fromSession?: ChatMessage["fromSession"]): ChatMessage => ({
      id: crypto.randomUUID(),
      role: "user",
      content,
      createdAt: Date.now(),
      ...(fromSession ? { fromSession } : {}),
    });

    setSessionBridge({
      list: (currentId) =>
        d()
          // Never the session asking, as in Claude Code Desktop.
          .sessions.filter((s) => !s.archived && s.id !== currentId)
          .slice()
          .sort((a, b) => b.modifiedAt - a.modifiedAt)
          .slice(0, 20)
          .map((s) => ({
            id: s.id,
            title: s.title,
            project: s.workspace ? workspaceName(s.workspace) : "",
            modifiedAt: s.modifiedAt,
            current: s.id === currentId,
            working: busy(s.id),
          })),

      read: async (id, last) => {
        const chat = live(id);
        if (!chat) return null;
        const messages = chat.messages
          .filter((m) => m.content.trim())
          .slice(-last)
          .map((m) => ({ role: m.role, content: plainText(m.content) }));
        return { title: chat.title, messages };
      },

      send: async (fromId, id, text): Promise<SendOutcome> => {
        const chat = live(id);
        if (!chat) return "missing";
        const modelId = usableModel(chat.model);
        if (!modelId) return "unsupported";
        // As in Claude Code Desktop, an archived session doesn't take messages.
        if (summary(id)?.archived) return "missing";
        const from = fromId ? titleOf(fromId) : "";
        const card = fromId ? { id: fromId, title: from } : undefined;
        const message = userMessage(attributedMessage(`Message from the session "${from}" (${fromId ?? ""}):`, text), card);
        const outcome = deliver(id, modelId, message);
        noteDelivery(message.id, fromId, id, outcome === "queued");
        // Writing back answers what that session had sent this one.
        if (fromId) markReplied(fromId, id);
        return outcome;
      },

      create: async (fromId, { title, message, model, effort, reportBack }) => {
        const parent = fromId ? live(fromId) : undefined;
        const workspace = parent ? parent.workspace ?? d().workspace : d().workspace;
        if (!workspace) return "no-project";
        // The same model and effort as the session asking, unless the user asked for others.
        let modelId: string | null;
        if (model?.trim()) {
          const models = drivableModels(d().settings);
          const found = resolveSessionModel(model, models);
          if (!found) return { unknownModel: models.map((m) => `${m.name} (${m.id})`) };
          modelId = found.id;
        } else {
          modelId = usableModel(parent?.model);
        }
        if (!modelId) return "unsupported";
        const level = effort?.trim() ? resolveEffort(effort) : parent?.effort ?? d().effort();
        if (!level) return { unknownEffort: [...EFFORT_LEVELS] };
        const taken = [...(d().liveChatsRef.current ?? []).map((c) => c.id), ...d().sessions.map((s) => s.id)];
        const id = newSessionId(taken);
        const chat: Chat = {
          id,
          title,
          workspace,
          messages: [],
          model: modelId,
          effort: level,
          permissionMode: parent?.permissionMode,
          parentId: fromId,
        };
        d().hydratedRef.current?.add(id);
        d().setChats((prev) => [chat, ...prev]);
        d().liveChatsRef.current = [chat, ...(d().liveChatsRef.current ?? [])];
        await saveSession(workspace, chat, Date.now()).catch(() => undefined);
        d().refreshSessions();

        const from = fromId ? titleOf(fromId) : "";
        const first = fromId
          ? userMessage(attributedMessage(`Message from the session "${from}" (${fromId}), which created this one:`, message), { id: fromId, title: from })
          : userMessage(message);
        void (async () => {
          // Through the line, so a message sent to the new session during its first turn waits.
          await enqueue(id, () => runTurn(id, modelId, [first]));
          if (!reportBack || !fromId || !live(fromId)) return;
          const reply = [...(live(id)?.messages ?? [])].reverse().find((m) => m.role === "assistant");
          const parentModel = usableModel(live(fromId)?.model);
          if (!parentModel) return;
          deliver(fromId, parentModel, userMessage(reportMessage(titleOf(id), id, plainText(reply?.content ?? "")), { id, title: titleOf(id), reply: true }));
          markReplied(id, fromId);
        })().catch(() => undefined);
        return { id, model: getModel(modelId, d().settings)?.name ?? modelId, effort: level };
      },

      rename: async (id, title) => {
        const chat = live(id);
        if (!chat) return false;
        const ws = chat.workspace ?? d().workspace;
        if (!ws) return false;
        await renameSession(ws, id, title);
        d().setChats((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
        return true;
      },

      archive: async (id) => {
        const chat = live(id);
        const ws = chat?.workspace ?? d().workspace;
        if (!ws || !chat) return false;
        await setSessionArchived(ws, id, true, Date.now());
        d().setChats((prev) => prev.map((c) => (c.id === id ? { ...c, archived: true } : c)));
        return true;
      },
    });
    return () => setSessionBridge(null);
  }, [t]);
}
