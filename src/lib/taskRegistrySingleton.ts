import { createTaskRegistry, type TaskRegistry } from "./taskRegistry";

let instance: TaskRegistry | null = null;

export function getTaskRegistry(): TaskRegistry {
  if (!instance) instance = createTaskRegistry();
  return instance;
}
