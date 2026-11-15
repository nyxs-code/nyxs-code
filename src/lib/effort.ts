import { accountKey } from "./accountScope";

export type EffortLevel = "low" | "medium" | "high" | "extra" | "max";

export const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "extra", "max"];

const STORAGE_KEY = "optimicer.effort.v1";

export function effortRank(level: EffortLevel): number {
  const i = EFFORT_LEVELS.indexOf(level);
  return i < 0 ? 1 : i;
}

export function loadEffort(): EffortLevel {
  try {
    const v = localStorage.getItem(accountKey(STORAGE_KEY));
    return v && (EFFORT_LEVELS as string[]).includes(v) ? (v as EffortLevel) : "medium";
  } catch {
    return "medium";
  }
}

export function saveEffort(level: EffortLevel): void {
  try {
    localStorage.setItem(accountKey(STORAGE_KEY), level);
  } catch {
    /* almacenamiento no disponible */
  }
}
