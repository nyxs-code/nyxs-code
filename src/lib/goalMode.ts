import { useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import type { ChatMessage } from "@/components/Message";
import type { AssistantTurn } from "@/lib/assistantTurn";
import type { ChatHistory } from "@/lib/chatHistory";
import type { Chat } from "@/lib/chatStore";
import { claudePlanRefused } from "@/lib/claudeCode";
import {
  GOAL_JUDGE_SYSTEM,
  MAX_GOAL_TURNS,
  goalContinue,
  goalJudgePrompt,
  goalKickoff,
  goalTranscript,
  newGoal,
  parseVerdict,
  type ChatGoal,
  type GoalNotice,
} from "@/lib/goal";
import { getLanguage, LANGUAGES } from "@/lib/i18n";
import { getModel } from "@/lib/models";
import { hasKey, type Settings } from "@/lib/settings";

const uid = () => Math.random().toString(36).slice(2, 11);

/** How a turn ended, for the goal: only a finished one is checked. */
export type TurnOutcome = "done" | "stopped" | "error";

export type Verdict = { met: boolean; reason: string };

/** What the goal loop reads and changes in the app; built when a turn ends. */
export interface GoalEnv {
  settings: Settings;
  effectiveModel: string;
  workspace: string | null;
  liveChat: (chatId: string) => Chat | undefined;
  setChats: Dispatch<SetStateAction<Chat[]>>;
  /** A turn already runs in the chat (the user sent another message, a background task woke it). */
  turnRunning: (chatId: string) => boolean;
  /** The user queued messages for the chat: they go next, not the goal. */
  queued: (chatId: string) => boolean;
  buildChatHistory: (chatId: string) => Promise<Pick<ChatHistory, "history" | "compaction">>;
  streamTurn: (turn: AssistantTurn) => Promise<void>;
  /** Asks whether the goal is met; null when it couldn't be checked. Tests pass their own. */
  judge?: (goal: string, messages: ChatMessage[], modelId: string) => Promise<Verdict | null>;
}

// The chats whose goal is being checked right now, for the card's "Checking…".
const checking = new Set<string>();
const listeners = new Set<() => void>();
let checkingVersion = 0;
function setChecking(chatId: string, on: boolean): void {
  if (on) checking.add(chatId);
  else checking.delete(chatId);
  checkingVersion++;
  listeners.forEach((l) => l());
}
export function useGoalChecking(chatId: string): boolean {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => checkingVersion,
  );
  return checking.has(chatId);
}

// `/goal` in a new session: the chat doesn't exist yet when the command runs, so the goal waits
// here for the chat its kickoff message creates (sendMessage takes it).
let pending: { goal: ChatGoal; message: string; at: number } | null = null;
export function setPendingGoal(text: string): string {
  const message = goalKickoff(text.trim());
  pending = { goal: newGoal(text), message, at: Date.now() };
  return message;
}
/** The goal for a new chat started by this message, if `/goal` just sent it. */
export function takePendingGoal(message: string): ChatGoal | undefined {
  const p = pending;
  pending = null;
  return p && p.message === message && Date.now() - p.at < 30_000 ? p.goal : undefined;
}

const languageName = () => LANGUAGES.find((l) => l.code === getLanguage())?.label.replace(/\s*\(.*\)$/, "") ?? "English";

/** The check: the chat's own model (an API's, Claude Code or another agent CLI), at low effort,
 *  reads the goal and the end of the chat. */
export async function judgeGoal(goal: string, messages: ChatMessage[], modelId: string, settings: Settings): Promise<Verdict | null> {
  const model = getModel(modelId, settings);
  if (!model) return null;
  // With the plan out of room Claude Code can't answer; the goal pauses instead.
  if (model.provider === "claude-code" && claudePlanRefused()) return null;
  const prompt = `${GOAL_JUDGE_SYSTEM}

${goalJudgePrompt(goal, goalTranscript(messages), languageName())}`;
  try {
    // Loaded when a check runs: the model clients are heavy, and the loop's other parts don't need them.
    const { askModelOnce } = await import("@/lib/ai");
    return parseVerdict(await askModelOnce(modelId, settings, prompt, { effort: "low" }));
  } catch {
    return null;
  }
}

function patchGoal(env: GoalEnv, chatId: string, patch: Partial<ChatGoal>): void {
  env.setChats((prev) => prev.map((c) => (c.id === chatId && c.goal ? { ...c, goal: { ...c.goal, ...patch } } : c)));
}

function goalNotice(goal: GoalNotice, content = ""): ChatMessage {
  return { id: uid(), role: "user", content, notice: { kind: "goal", items: [], goal }, createdAt: Date.now() };
}

/** After every turn of a chat with a goal: a stopped or failed turn pauses it; a finished one is
 *  checked, and while the goal isn't met (and the user isn't already sending something) the agent
 *  gets another turn, up to MAX_GOAL_TURNS. */
export async function goalTurnEnded(chatId: string, outcome: TurnOutcome, env: GoalEnv): Promise<void> {
  const chat = env.liveChat(chatId);
  const goal = chat?.goal;
  if (!chat || !goal || goal.status === "met" || checking.has(chatId)) return;
  if (outcome !== "done") {
    if (goal.status === "active") patchGoal(env, chatId, { status: "paused", pausedBy: outcome === "stopped" ? "user" : "error" });
    return;
  }
  const modelId = chat.model && getModel(chat.model, env.settings) ? chat.model : env.effectiveModel;
  setChecking(chatId, true);
  let verdict: Verdict | null;
  try {
    verdict = await (env.judge ?? ((g, m, id) => judgeGoal(g, m, id, env.settings)))(goal.text, chat.messages, modelId);
  } finally {
    setChecking(chatId, false);
  }
  // The goal changed or went away while it was checked.
  const now = env.liveChat(chatId);
  if (!now?.goal || now.goal.setAt !== goal.setAt) return;
  const turns = now.goal.turns + 1;
  if (!verdict) {
    patchGoal(env, chatId, { turns, status: "paused", pausedBy: "unchecked" });
    return;
  }
  if (verdict.met) {
    patchGoal(env, chatId, { turns, status: "met", lastReason: verdict.reason, metAt: Date.now(), pausedBy: undefined });
    env.setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, messages: [...c.messages, goalNotice({ state: "met", turns })] } : c)));
    return;
  }
  if (turns >= MAX_GOAL_TURNS) {
    patchGoal(env, chatId, { turns, status: "paused", pausedBy: "limit", lastReason: verdict.reason });
    env.setChats((prev) =>
      prev.map((c) => (c.id === chatId ? { ...c, messages: [...c.messages, goalNotice({ state: "limit", turns, reason: verdict.reason })] } : c)),
    );
    return;
  }
  patchGoal(env, chatId, { turns, status: "active", pausedBy: undefined, lastReason: verdict.reason });
  // What the user sends next goes first; its turn's end checks the goal again.
  if (env.turnRunning(chatId) || env.queued(chatId)) return;
  const model = getModel(modelId, env.settings);
  if (!model || !hasKey(env.settings, model.provider)) return;
  const { history, compaction } = await env.buildChatHistory(chatId);
  const content = goalContinue(goal.text, verdict.reason);
  const notice = goalNotice({ state: "notMet", turns, reason: verdict.reason }, content);
  env.setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, messages: [...c.messages, notice] } : c)));
  history.push({ role: "user", content });
  await env.streamTurn({
    chatId,
    modelId,
    history,
    thinking: false,
    workspace: chat.worktree?.path ?? chat.workspace ?? env.workspace,
    sessionWorkspace: chat.workspace ?? env.workspace,
    snapshotId: notice.id,
    compaction,
  });
}
