import type { Translations } from "./i18n";
import type { PlanLimit, PlanRefusal, PlanUsage } from "./claudeCode";

/** A plan limit's name: "5-hour limit", "Weekly", "Weekly · Gemini Models", "Billing period". */
export function planLimitLabel(limit: PlanLimit, t: Translations["chatInput"]): string {
  if (limit.kind === "session") return t.planFiveHour;
  if (limit.kind === "weekly") return t.planWeekly;
  if (limit.kind === "period") return t.planPeriod;
  return t.planWeeklyModel.replace("{model}", limit.model ?? "");
}

/** "3 h 20 min" until a rolling window frees up. */
export function untilLabel(at: string | number, t: Translations["chatInput"], now = Date.now()): string {
  const mins = Math.max(1, Math.ceil((new Date(at).getTime() - now) / 60000));
  if (!Number.isFinite(mins)) return "";
  if (mins < 60) return t.durationM.replace("{m}", String(mins));
  return t.durationHM.replace("{h}", String(Math.floor(mins / 60))).replace("{m}", String(mins % 60));
}

/** "sáb, 10:00" — the weekly limit turns over on the calendar, so name the moment. */
export function resetClock(at: string | number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/** When a limit frees up, said the way its window turns over: a countdown for the 5-hour one,
 *  the day and time for the others. */
export function resetLabel(kind: PlanLimit["kind"] | null, at: string | number, t: Translations["chatInput"], now = Date.now()): string {
  return kind === "session" ? t.resetsIn.replace("{t}", untilLabel(at, t, now)) : t.resetsOn.replace("{t}", resetClock(at));
}

/** How full a limit has to be for the composer to warn, once per step. */
export const PLAN_WARN_STEPS = [75, 90] as const;

export type PlanWarning =
  | { level: "warn"; limit: PlanLimit; key: string }
  | { level: "refused"; limit: PlanLimit | null; until: number };

/** The id a dismissal is remembered under: the same limit, step and window. Rounded to the hour
 *  because the turn's report and `get_usage` can give the same reset a few seconds apart. */
export function planWarningKey(limit: PlanLimit, step: number): string {
  const reset = limit.resetsAt ? Math.round(new Date(limit.resetsAt).getTime() / 3_600_000) : "";
  return `${limit.kind}|${limit.model ?? ""}|${step}|${reset}`;
}

/**
 * What the composer should warn about, if anything. A refusal wins and can't be dismissed. Otherwise
 * the fullest limit past a step, unless that step was dismissed for its window. A limit whose reset
 * has already passed is an old reading and is skipped.
 */
export function planWarning(
  usage: PlanUsage | null,
  refusal: PlanRefusal | null,
  dismissed: ReadonlySet<string>,
  now = Date.now(),
): PlanWarning | null {
  const limits = usage?.limits ?? [];
  if (refusal && refusal.until > now) {
    return { level: "refused", limit: limits.find((l) => l.kind === refusal.kind) ?? null, until: refusal.until };
  }
  let best: { limit: PlanLimit; key: string } | null = null;
  for (const limit of limits) {
    if (limit.resetsAt && new Date(limit.resetsAt).getTime() <= now) continue;
    const step = [...PLAN_WARN_STEPS].reverse().find((s) => limit.utilization >= s);
    if (step === undefined) continue;
    const key = planWarningKey(limit, step);
    if (dismissed.has(key)) continue;
    if (!best || limit.utilization > best.limit.utilization) best = { limit, key };
  }
  return best && { level: "warn", ...best };
}
