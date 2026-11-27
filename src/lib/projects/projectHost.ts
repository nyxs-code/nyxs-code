import type { TurnOutcome } from "@/lib/goalMode";
import type { ThreadStatus } from "./types";

export interface StartThreadRequest {
  title: string;
  instructions: string;
  model?: string;
  effort?: string;
}

export type StartThreadOutcome = { id: string; model: string; effort: string; branch?: string } | { error: string };

/** What the project tools and cards need from the app, which holds the chats. Filled in by
 *  useProjects; the tools (projectTools.ts) and cards use it. */
export interface ProjectHost {
  /** Opens a thread for the coordinator `coordinatorId`, in a worktree of the project folder,
   *  and starts its first turn. */
  startThread(coordinatorId: string, request: StartThreadRequest): Promise<StartThreadOutcome>;
  setThreadStatus(threadId: string, status: ThreadStatus, preview?: string): Promise<boolean>;
  /** The thread's `report`: its status, and a card in the coordinator conversation (which runs a
   *  turn on it, except for a progress note). */
  report(threadId: string, text: string, status: ThreadStatus): Promise<"delivered" | "noted" | "no-coordinator">;
  readThread(threadId: string, last: number): Promise<{ title: string; messages: { role: string; content: string }[] } | null>;
  /** The user picked an option of a decision card: marked on the card and sent as their answer. */
  answerDecision(chatId: string, messageId: string, toolId: string, label: string, question: string): void;
  turnEnded(chatId: string, outcome: TurnOutcome): void;
}

let host: ProjectHost | null = null;
export const setProjectHost = (h: ProjectHost | null) => {
  host = h;
};
export const projectHost = () => host;

/** A turn ended somewhere: a thread that didn't report counts as done (see ProjectHost.turnEnded). */
export function projectTurnEnded(chatId: string, outcome: TurnOutcome): void {
  host?.turnEnded(chatId, outcome);
}
