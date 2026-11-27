import type { EffortLevel } from "@/lib/effort";

/** Where a project's threads run: a worktree of its folder on this computer, or the Nyxs cloud
 *  (Phase 3 of docs/proyectos-nube-spec.md; shown but not offered yet). */
export type ThreadWhere = "local" | "cloud";

/** A thread's state as stored in its session's meta. `working` while a turn runs on it, the rest
 *  set by its `report` tool, its turn ending (`review`) or the coordinator (`resolved`, `idle`). */
export type ThreadStatus = "working" | "needs_input" | "review" | "resolved" | "failed" | "idle";

export const THREAD_STATUSES: readonly ThreadStatus[] = ["working", "needs_input", "review", "resolved", "failed", "idle"];

/** A folder on this computer, a remote URL, or both. */
export interface ProjectRepo {
  path?: string;
  gitUrl?: string;
  branch?: string;
}

export interface ProjectDefaults {
  /** The model new threads run on; the coordinator's when unset. */
  model?: string;
  effort?: EffortLevel;
  where: ThreadWhere;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  repos: ProjectRepo[];
  /** Instructions for every session of the project (at most PROJECT_INSTRUCTIONS_MAX chars). */
  instructions: string;
  defaults: ProjectDefaults;
  /** The session the user talks to: it answers quick questions and opens threads. */
  coordinatorChatId: string;
  /** The memory file, relative to the app's data folder. */
  memoryPath: string;
}

export const PROJECT_INSTRUCTIONS_MAX = 16_000;
/** MEMORY.md is meant to stay short: every project session reads it in its system prompt. */
export const PROJECT_MEMORY_MAX = 8_000;

/** Where a thread's session works. */
export type ThreadLocation = { kind: "local"; workspace: string; worktree?: string } | { kind: "cloud"; cloudThreadId: string; branch?: string };

export type ProjectRole = "coordinator" | "thread";

/** The project fields a session carries (Chat and its saved meta). */
export interface ProjectSessionFields {
  projectId?: string;
  projectRole?: ProjectRole;
  threadStatus?: ThreadStatus;
  /** The title the coordinator gave it: cards find the thread by it, even once renamed. */
  threadTitle?: string;
  threadLocation?: ThreadLocation;
  /** The coordinator message that opened it. */
  parentMessageId?: string;
  /** The text of its last report (or its last reply), for its row and card. */
  threadPreview?: string;
  /** When its status last changed. */
  threadUpdatedAt?: number;
  /** A cloud thread: the last event of the events API already in its transcript. */
  threadCloudSeq?: number;
  /** The pull request a cloud thread opened. */
  threadPrUrl?: string;
}
