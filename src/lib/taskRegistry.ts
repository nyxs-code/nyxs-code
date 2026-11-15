import { useSyncExternalStore } from "react";

export type TaskStatus = "pending" | "running" | "done" | "failed" | "stopped";

export interface BackgroundTask {
  id: string;
  label: string;
  status: TaskStatus;
  output: string;
  tokens: number;
  error?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
}

export interface TaskRegistryState {
  tasks: BackgroundTask[];
}

export function emptyTaskRegistry(): TaskRegistryState {
  return { tasks: [] };
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["done", "failed", "stopped"]);

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL.has(status);
}

export function createTask(
  state: TaskRegistryState,
  task: { id: string; label: string; now: number },
): TaskRegistryState {
  if (state.tasks.some((t) => t.id === task.id)) return state;
  const node: BackgroundTask = {
    id: task.id,
    label: task.label,
    status: "pending",
    output: "",
    tokens: 0,
    createdAt: task.now,
  };
  return { tasks: [...state.tasks, node] };
}

function patch(state: TaskRegistryState, id: string, fn: (t: BackgroundTask) => BackgroundTask): TaskRegistryState {
  let changed = false;
  const tasks = state.tasks.map((t) => {
    if (t.id !== id) return t;
    const next = fn(t);
    if (next !== t) changed = true;
    return next;
  });
  return changed ? { tasks } : state;
}

export function startTask(state: TaskRegistryState, id: string, now: number): TaskRegistryState {
  return patch(state, id, (t) => (t.status === "pending" ? { ...t, status: "running", startedAt: now } : t));
}

export function appendOutput(state: TaskRegistryState, id: string, chunk: string): TaskRegistryState {
  if (!chunk) return state;
  return patch(state, id, (t) => (isTerminal(t.status) ? t : { ...t, output: t.output + chunk }));
}

export function addTokens(state: TaskRegistryState, id: string, n: number): TaskRegistryState {
  if (!n) return state;
  return patch(state, id, (t) => ({ ...t, tokens: t.tokens + n }));
}

export function finishTask(
  state: TaskRegistryState,
  id: string,
  outcome: { status: "done" | "failed"; error?: string; now: number },
): TaskRegistryState {
  return patch(state, id, (t) =>
    isTerminal(t.status) ? t : { ...t, status: outcome.status, error: outcome.error, endedAt: outcome.now },
  );
}

export function stopTask(state: TaskRegistryState, id: string, now: number): TaskRegistryState {
  return patch(state, id, (t) => (isTerminal(t.status) ? t : { ...t, status: "stopped", endedAt: now }));
}

export function activeTasks(state: TaskRegistryState): BackgroundTask[] {
  return state.tasks.filter((t) => !isTerminal(t.status));
}

export function getTask(state: TaskRegistryState, id: string): BackgroundTask | undefined {
  return state.tasks.find((t) => t.id === id);
}

export function summarizeTasks(state: TaskRegistryState): string {
  if (state.tasks.length === 0) return "No background tasks.";
  return state.tasks
    .map((t) => `[${t.status}] ${t.id} — ${t.label}${t.tokens ? ` (${t.tokens} tok)` : ""}`)
    .join("\n");
}

export function serializeRegistry(state: TaskRegistryState): BackgroundTask[] {
  return state.tasks;
}

export function restoreRegistry(tasks: BackgroundTask[]): TaskRegistryState {
  return {
    tasks: (tasks ?? []).map((t) =>
      isTerminal(t.status)
        ? t
        : { ...t, status: "stopped" as const, endedAt: t.endedAt ?? t.startedAt ?? t.createdAt },
    ),
  };
}

export interface TaskRegistry {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => TaskRegistryState;
  hydrate: (tasks: BackgroundTask[]) => void;
  create: (id: string, label: string, controller?: AbortController) => void;
  start: (id: string) => void;
  appendOutput: (id: string, chunk: string) => void;
  addTokens: (id: string, n: number) => void;
  finish: (id: string, status: "done" | "failed", error?: string) => void;
  stop: (id: string) => boolean;
  list: () => BackgroundTask[];
  get: (id: string) => BackgroundTask | undefined;
  reset: () => void;
}

export function createTaskRegistry(now: () => number = Date.now): TaskRegistry {
  let state = emptyTaskRegistry();
  const controllers = new Map<string, AbortController>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  const set = (next: TaskRegistryState) => {
    if (next !== state) {
      state = next;
      notify();
    }
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    hydrate: (tasks) => set(restoreRegistry(tasks)),
    create(id, label, controller) {
      if (controller) controllers.set(id, controller);
      set(createTask(state, { id, label, now: now() }));
    },
    start: (id) => set(startTask(state, id, now())),
    appendOutput: (id, chunk) => set(appendOutput(state, id, chunk)),
    addTokens: (id, n) => set(addTokens(state, id, n)),
    finish(id, status, error) {
      controllers.delete(id);
      set(finishTask(state, id, { status, error, now: now() }));
    },
    stop(id) {
      const task = getTask(state, id);
      if (!task || isTerminal(task.status)) return false;
      controllers.get(id)?.abort();
      controllers.delete(id);
      set(stopTask(state, id, now()));
      return true;
    },
    list: () => state.tasks,
    get: (id) => getTask(state, id),
    reset() {
      controllers.forEach((c) => c.abort());
      controllers.clear();
      state = emptyTaskRegistry();
      notify();
    },
  };
}

export function useTaskRegistry(registry: TaskRegistry): TaskRegistryState {
  return useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
}
