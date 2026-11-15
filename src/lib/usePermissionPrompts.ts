import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { PermissionDecision } from "@/components/PermissionCard";
import type { PermissionMode } from "@/components/ui/claude-style-chat-input";
import { accountKey } from "@/lib/accountScope";
import type { AskAnswer, AskQuestion } from "@/lib/agentTools";
import { notifyPermissionRequest, notifyQuestion } from "@/lib/notify";
import {
  checkPermission,
  describePermission,
  EDIT_TOOLS,
  isProtectedConfigTarget,
  loadFileRules,
  type PermissionRule,
} from "@/lib/permissions";
import { settingsFor, settingsSnapshotFor, type NyxsSettings } from "@/lib/settingsRuntime";

const RULES_KEY = "optimicer.permissionRules.v1";

function loadRules(): PermissionRule[] {
  try {
    return JSON.parse(localStorage.getItem(accountKey(RULES_KEY)) || "[]");
  } catch {
    return [];
  }
}

function saveRules(r: PermissionRule[]): void {
  localStorage.setItem(accountKey(RULES_KEY), JSON.stringify(r));
}

const uid = () => Math.random().toString(36).slice(2, 11);

export interface PendingApproval {
  id: string;
  chatId: string;
  toolName: string;
  input: unknown;
  label: string;
  resolve: (decision: PermissionDecision) => void;
}

export interface PendingQuestion {
  id: string;
  chatId: string;
  questions: AskQuestion[];
  resolve: (answers: AskAnswer[] | null) => void;
}

/** "Skip permissions" only applies once the setting allows it; until then it acts as acceptEdits. */
function effectiveMode(mode: PermissionMode, settings: NyxsSettings): PermissionMode {
  const bypassAllowed = (settings as { allowPermissionBypass?: boolean }).allowPermissionBypass ?? false;
  return mode === "skip" && !bypassAllowed ? "acceptEdits" : mode;
}

/** What the agent has to ask the user before going on: tool permissions (checked against the
 *  saved rules and the chat's permission mode) and its multiple-choice questions. Each request
 *  waits as a promise until the user answers in the chat. A chat's calls are checked with the
 *  settings of its own project (`chatsRef`), not the open one's: a turn keeps running there
 *  when another project is opened. */
export function usePermissionPrompts(
  activeId: string | null,
  chatModeOf: (chatId: string | undefined) => PermissionMode,
  chatsRef?: RefObject<readonly { id: string; workspace?: string | null }[]>,
) {
  /** The chat's project; undefined (the open folder) for one not in memory. */
  const folderOf = useCallback(
    (chatId: string | undefined) => {
      const chat = chatId ? chatsRef?.current?.find((c) => c.id === chatId) : undefined;
      return chat ? (chat.workspace ?? null) : undefined;
    },
    [chatsRef],
  );
  const [rules, setRules] = useState<PermissionRule[]>(() => loadRules());
  const rulesRef = useRef(rules);
  useEffect(() => { rulesRef.current = rules; }, [rules]);
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);

  // Chats where the agent's RequestPermission was granted: their edits go through without
  // asking until the turn ends.
  const preapprovedRef = useRef<Set<string>>(new Set());
  const clearPreapproval = useCallback((chatId: string) => { preapprovedRef.current.delete(chatId); }, []);

  /** Whether the saved rules and the chat's mode let a tool run without asking. */
  const isAllowed = useCallback(
    (chatId: string | undefined, toolName: string, input: unknown) => {
      const settings = settingsSnapshotFor(folderOf(chatId)).merged;
      return (
        checkPermission(toolName, input, effectiveMode(chatModeOf(chatId), settings), [...loadFileRules(settings), ...rulesRef.current]) ===
        "allow"
      );
    },
    [chatModeOf, folderOf],
  );

  const gate = useCallback(async (chatId: string, toolName: string, input: unknown): Promise<boolean> => {
    const settings = (await settingsFor(folderOf(chatId))).merged;
    const decision = checkPermission(toolName, input, effectiveMode(chatModeOf(chatId), settings), [
      ...loadFileRules(settings),
      ...rulesRef.current,
    ]);
    if (decision === "deny") return false;
    if (decision === "allow") {
      if (toolName === "RequestPermission") preapprovedRef.current.add(chatId);
      return true;
    }

    if (preapprovedRef.current.has(chatId) && EDIT_TOOLS.has(toolName) && !isProtectedConfigTarget(toolName, input)) return true;
    const result = await new Promise<PermissionDecision>((resolve) => {
      setPending((prev) => [...prev, { id: uid(), chatId, toolName, input, label: describePermission(toolName, input), resolve }]);
    });

    if (toolName === "RequestPermission" && result.allow) preapprovedRef.current.add(chatId);
    if (result.allow && result.rule) {
      const rule = result.rule;
      rulesRef.current = [...rulesRef.current, rule];
      setRules((prev) => {
        const next = [...prev, rule];
        saveRules(next);
        return next;
      });
    }
    return result.allow;
  }, [chatModeOf, folderOf]);

  const notifiedChatsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const waiting = new Set(pending.map((p) => p.chatId));
    const fresh = pending.find((p) => !notifiedChatsRef.current.has(p.chatId));
    if (fresh) void notifyPermissionRequest(fresh.label, fresh.chatId);
    notifiedChatsRef.current = waiting;
  }, [pending]);

  const pendingQuestionId = pendingQuestion?.id;
  const pendingQuestionText = pendingQuestion?.questions[0]?.question;
  const pendingQuestionChat = pendingQuestion?.chatId;
  useEffect(() => {
    if (pendingQuestionId) void notifyQuestion(pendingQuestionText ?? "", pendingQuestionChat);
  }, [pendingQuestionId, pendingQuestionText, pendingQuestionChat]);

  /** Answers the open chat's oldest permission request. */
  const respondPermission = (decision: PermissionDecision) => {
    setPending((prev) => {
      const idx = prev.findIndex((p) => p.chatId === activeId);
      if (idx === -1) return prev;
      prev[idx].resolve(decision);
      return prev.filter((_, i) => i !== idx);
    });
  };

  const askUser = useCallback(
    (chatId: string, questions: AskQuestion[]): Promise<AskAnswer[] | null> =>
      new Promise((resolve) => setPendingQuestion({ id: uid(), chatId, questions, resolve })),
    [],
  );
  const respondQuestion = (answers: AskAnswer[] | null) => {
    setPendingQuestion((prev) => {
      prev?.resolve(answers);
      return null;
    });
  };

  /** Denies a chat's open permission requests and dismisses its question, when its turn ends
   *  or is stopped. */
  const cancelPrompts = useCallback((chatId: string) => {
    setPending((prev) => {
      prev.filter((p) => p.chatId === chatId).forEach((p) => p.resolve({ allow: false, rule: null }));
      return prev.filter((p) => p.chatId !== chatId);
    });
    setPendingQuestion((prev) => {
      if (prev?.chatId !== chatId) return prev;
      prev.resolve(null);
      return null;
    });
  }, []);

  const deleteRule = (index: number) =>
    setRules((prev) => {
      const next = prev.filter((_, i) => i !== index);
      saveRules(next);
      return next;
    });
  const clearRules = () => {
    setRules([]);
    saveRules([]);
  };

  return {
    rules,
    deleteRule,
    clearRules,
    pending,
    pendingQuestion,
    gate,
    isAllowed,
    askUser,
    respondPermission,
    respondQuestion,
    cancelPrompts,
    clearPreapproval,
  };
}
