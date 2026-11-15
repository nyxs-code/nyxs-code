import { useSyncExternalStore } from "react";
import { appendActivity, settleActivity, type ActivityEntry } from "./agentActivity";
import type { OrchestratorEvent } from "./orchestrator";

export type AgentStatus = "running" | "ok" | "error" | "stopped";

export interface AgentNode {
  id: number;
  label: string;
  phase?: string;
  status: AgentStatus;
  ms?: number;
  retries: number;
  tokensIn?: number;
  tokensOut?: number;
  /** It can be stopped on its own while it runs. */
  stoppable: boolean;
  activity: ActivityEntry[];
}

export interface WorkflowState {
  agents: AgentNode[];
  phases: string[];
  logs: string[];
  running: number;
  completed: number;
  failed: number;
  stopped: number;
}

export function initialWorkflowState(): WorkflowState {
  return { agents: [], phases: [], logs: [], running: 0, completed: 0, failed: 0, stopped: 0 };
}

export function reduceEvent(state: WorkflowState, e: OrchestratorEvent): WorkflowState {
  switch (e.kind) {
    case "phase":
      if (state.phases.includes(e.title)) return state;
      return { ...state, phases: [...state.phases, e.title] };

    case "log":
      return { ...state, logs: [...state.logs, e.message] };

    case "agent:start": {
      const node: AgentNode = {
        id: e.id,
        label: e.label,
        phase: e.phase,
        status: "running",
        retries: 0,
        stoppable: !!e.stop,
        activity: [],
      };
      return { ...state, agents: [...state.agents, node], running: state.running + 1 };
    }

    case "agent:retry":
      return {
        ...state,
        agents: state.agents.map((a) => (a.id === e.id ? { ...a, retries: e.attempt } : a)),
      };

    case "agent:activity": {
      const i = state.agents.findIndex((a) => a.id === e.id);
      if (i < 0 || state.agents[i].status !== "running") return state;
      const agents = state.agents.slice();
      agents[i] = { ...agents[i], activity: appendActivity(agents[i].activity, e.activity) };
      return { ...state, agents };
    }

    case "agent:end": {
      const status: AgentStatus = e.stopped ? "stopped" : e.ok ? "ok" : "error";
      return {
        ...state,
        agents: state.agents.map((a) =>
          a.id === e.id
            ? {
                ...a,
                status,
                stoppable: false,
                activity: settleActivity(a.activity),
                ms: e.ms,
                tokensIn: e.usage?.inputTokens,
                tokensOut: e.usage?.outputTokens,
              }
            : a,
        ),
        running: Math.max(0, state.running - 1),
        completed: state.completed + (status === "ok" ? 1 : 0),
        failed: state.failed + (status === "error" ? 1 : 0),
        stopped: state.stopped + (status === "stopped" ? 1 : 0),
      };
    }

    default:
      return state;
  }
}

export function groupByPhase(state: WorkflowState): Array<{ phase: string; agents: AgentNode[] }> {
  const order = [...state.phases];
  const buckets = new Map<string, AgentNode[]>();
  for (const a of state.agents) {
    const key = a.phase ?? "";
    if (!buckets.has(key)) {
      buckets.set(key, []);
      if (key && !order.includes(key)) order.push(key);
    }
    buckets.get(key)!.push(a);
  }
  const out: Array<{ phase: string; agents: AgentNode[] }> = [];
  if (buckets.has("")) out.push({ phase: "", agents: buckets.get("")! });
  for (const p of order) if (buckets.has(p)) out.push({ phase: p, agents: buckets.get(p)! });
  return out;
}

export interface WorkflowStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => WorkflowState;
  dispatch: (e: OrchestratorEvent) => void;
  reset: () => void;
  /** Stops one running agent; the others carry on. */
  stopAgent: (id: number) => void;
}

/** Streamed text arrives a few characters at a time: views catch up at most this often. */
const ACTIVITY_FLUSH_MS = 100;

export function createWorkflowStore(): WorkflowStore {
  let state = initialWorkflowState();
  const listeners = new Set<() => void>();
  const stoppers = new Map<number, () => void>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const notify = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    listeners.forEach((l) => l());
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    dispatch(e) {
      if (e.kind === "agent:start" && e.stop) stoppers.set(e.id, e.stop);
      else if (e.kind === "agent:end") stoppers.delete(e.id);
      const next = reduceEvent(state, e);
      if (next === state) return;
      state = next;
      if (e.kind !== "agent:activity") notify();
      else flushTimer ??= setTimeout(notify, ACTIVITY_FLUSH_MS);
    },
    reset() {
      stoppers.clear();
      state = initialWorkflowState();
      notify();
    },
    stopAgent(id) {
      stoppers.get(id)?.();
    },
  };
}

/** Stops every agent in `store` that is running and can be stopped. */
export function stopAllAgents(store: WorkflowStore): void {
  for (const a of store.getSnapshot().agents) if (a.status === "running" && a.stoppable) store.stopAgent(a.id);
}

export function useWorkflowProgress(store: WorkflowStore): WorkflowState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
