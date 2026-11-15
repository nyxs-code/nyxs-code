import {
  loadRoutines,
  saveRoutines,
  dueTasks,
  computeNextRun,
  type ScheduledTask,
} from "./scheduledTasks";

export type FireTask = (task: ScheduledTask) => void | Promise<void>;

export interface Scheduler {
  start(): void;
  stop(): void;
  tickNow(): Promise<void>;
}

const DEFAULT_TICK_MS = 30_000;

export function createScheduler(fire: FireTask, tickMs = DEFAULT_TICK_MS): Scheduler {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const data = await loadRoutines();
      const now = new Date();
      const due = dueTasks(data.tasks, now);
      if (due.length === 0) return;
      for (const task of due) {
        try {
          await fire(task);
        } catch {
          // A failing task must not stop the loop or block the others.
        }
        task.lastRunAt = now.getTime();
        task.nextRunAt = computeNextRun(task, now) ?? undefined;
      }
      await saveRoutines(data);
    } catch {
      // Best-effort: a load/save failure just means we retry next tick.
    } finally {
      running = false;
    }
  };

  return {
    start() {
      if (!timer) timer = setInterval(() => void tick(), tickMs);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    tickNow: tick,
  };
}
