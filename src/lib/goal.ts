import type { ChatMessage } from "@/components/Message";
import { stripToolMarkers } from "@/lib/chatMessages";

/** A goal set with `/goal`: after every turn a check reads how it went, and the agent gets another
 *  turn until the goal is met (like Claude's goal). */
export interface ChatGoal {
  text: string;
  setAt: number;
  /** Turns checked against the goal so far. */
  turns: number;
  /** active: keeps going after each turn; paused: stopped by the user, an error or the turn
   *  limit (a message from the user picks it up again); met: done. */
  status: "active" | "paused" | "met";
  /** Why it paused, when it did. */
  pausedBy?: "user" | "error" | "limit" | "unchecked";
  /** What the latest check said. */
  lastReason?: string;
  metAt?: number;
}

/** What a goal notice in the chat shows. */
export interface GoalNotice {
  state: "notMet" | "met" | "limit";
  turns: number;
  reason?: string;
}

/** Turns the agent takes on its own before it stops and waits for the user. */
export const MAX_GOAL_TURNS = 20;

/** `/goal clear` (and "off", "none", any language's obvious words) takes the goal away. */
export function isClearGoal(args: string): boolean {
  return /^(clear|off|none|stop|borrar|quitar|eliminar|effacer|löschen|cancella|limpar|hapus)$/i.test(args.trim());
}

export function newGoal(text: string, now = Date.now()): ChatGoal {
  return { text: text.trim(), setAt: now, turns: 0, status: "active" };
}

/** The first message of a goal: what the agent works on. */
export function goalKickoff(goal: string): string {
  return `<goal>${goal}</goal>
Work toward this goal now. After each of your turns a check reads how far you got, and you get another turn until the goal is met, so keep going step by step and verify it (run the tests, the build, whatever proves it). If it can't be met, say why plainly.`;
}

/** What the agent reads when a check says the goal isn't met yet. */
export function goalContinue(goal: string, reason: string): string {
  return `<goal-check>The goal isn't met yet: ${reason}</goal-check>
Keep working toward the goal: ${goal}
Pick up where you left off. If it can't be met, say why plainly instead of trying the same thing again.`;
}

export const GOAL_JUDGE_SYSTEM = `You check whether an AI coding agent has met the user's goal.
You get the goal and the end of the conversation: the agent's latest replies and what its commands printed.
Answer with JSON only, nothing else: {"met": true or false, "reason": "..."}
- met is true only when the conversation shows the goal is done (the tests ran and passed, the build succeeded, the page shows the change). An agent saying it will do it, or that it should work, isn't proof.
- If the agent says the goal can't be met, met is false and the reason says why.
- reason: one short sentence, at most 15 words, in the language named below, saying what is still missing or what shows it's done.`;

const MAX_CHARS = 9000;

/** The end of the conversation the check reads: the replies since the user last wrote (the goal's
 *  own turns), with what the tools printed, cut from the start to stay small. */
export function goalTranscript(messages: ChatMessage[]): string {
  let start = messages.length;
  while (start > 0 && !(messages[start - 1].role === "user" && !messages[start - 1].notice)) start--;
  const parts = messages.slice(Math.max(0, start - 1)).map((m) => {
    if (m.role !== "assistant") return `[User]: ${m.content.trim()}`;
    // What the commands printed is the proof (tests passing, a build's errors): its end, per tool.
    const tools = Object.values(m.toolData ?? {}).map((d) => {
      const out = d.output?.trim();
      const tail = out && out.length > 800 ? `…${out.slice(-800)}` : out;
      return tail ? `[${d.name}: ${d.detail}]\n${tail}` : `[${d.name}: ${d.detail}]`;
    });
    return [`[Agent]: ${stripToolMarkers(m.content)}`, ...tools].join("\n");
  });
  const all = parts.join("\n\n");
  return all.length > MAX_CHARS ? `…${all.slice(-MAX_CHARS)}` : all;
}

export function goalJudgePrompt(goal: string, transcript: string, language: string): string {
  return `<goal>${goal}</goal>\n\n<conversation>\n${transcript}\n</conversation>\n\nLanguage for the reason: ${language}.\nYour JSON:`;
}

/** The check's answer, or null when it isn't one. */
export function parseVerdict(raw: string): { met: boolean; reason: string } | null {
  const body = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
  const m = /\{[\s\S]*\}/.exec(body);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]) as { met?: unknown; reason?: unknown };
    if (typeof v.met !== "boolean") return null;
    const reason = typeof v.reason === "string" ? v.reason.replace(/\s+/g, " ").trim().slice(0, 240) : "";
    return { met: v.met, reason };
  } catch {
    return null;
  }
}
