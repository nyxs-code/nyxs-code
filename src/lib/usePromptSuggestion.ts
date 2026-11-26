import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Chat } from "@/lib/chatStore";
import { onClaudeCodeSuggestion } from "@/lib/claudeCodeProcesses";
import { suggestNextPrompt } from "@/lib/promptSuggestion";
import type { Settings } from "@/lib/settings";

interface PromptSuggestionInput {
  activeId: string | null;
  /** A reply is running in the open chat. */
  streaming: boolean;
  enabled: boolean;
  chats: Chat[];
  settings: Settings;
  model: string;
}

/** A guessed next message for the chat box, asked for when a reply in the open chat ends (Claude
 *  Code sends its own). It belongs to that reply: a new message or another chat hides it. */
export function usePromptSuggestion({ activeId, streaming, enabled, chats, settings, model }: PromptSuggestionInput) {
  // One per chat: Claude Code sessions in the background finish, and guess, while another is open.
  const [byChat, setByChat] = useState<Record<string, { replyId: string; text: string }>>({});
  const ctxRef = useRef({ chats, settings, model });
  useLayoutEffect(() => { ctxRef.current = { chats, settings, model }; });
  const wasStreamingRef = useRef<{ id: string | null; on: boolean }>({ id: null, on: false });
  useEffect(() => {
    const prev = wasStreamingRef.current;
    wasStreamingRef.current = { id: activeId, on: streaming };
    if (streaming || !enabled || !activeId || prev.id !== activeId || !prev.on) return;
    const chatId = activeId;
    const ctrl = new AbortController();
    // Lets the finished reply land in the chat before reading it.
    const timer = window.setTimeout(() => {
      const { chats, settings, model } = ctxRef.current;
      const messages = chats.find((c) => c.id === chatId)?.messages ?? [];
      const last = messages[messages.length - 1];
      if (!last || last.role !== "assistant" || last.streaming || !last.content.trim()) return;
      void suggestNextPrompt(model, settings, messages, ctrl.signal)
        .then((text) => { if (text && !ctrl.signal.aborted) setByChat((all) => ({ ...all, [chatId]: { replyId: last.id, text } })); })
        .catch(() => {});
    }, 300);
    return () => { window.clearTimeout(timer); ctrl.abort(); };
  }, [streaming, activeId, enabled]);

  useEffect(() => {
    if (!enabled) return;
    return onClaudeCodeSuggestion((chatId, text) => {
      const messages = ctxRef.current.chats.find((c) => c.id === chatId)?.messages ?? [];
      const last = messages[messages.length - 1];
      if (last?.role === "assistant") setByChat((all) => ({ ...all, [chatId]: { replyId: last.id, text } }));
    });
  }, [enabled]);

  const messages = chats.find((c) => c.id === activeId)?.messages;
  const last = messages?.[messages.length - 1];
  const suggestion = activeId ? byChat[activeId] : undefined;
  return enabled && !streaming && suggestion && suggestion.replyId === last?.id ? suggestion.text : undefined;
}
