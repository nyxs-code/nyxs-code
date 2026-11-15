import { describe, expect, it } from "vitest";
import { planWarning, planWarningKey } from "../planLimits";
import type { PlanLimit, PlanUsage } from "../claudeCode";

const now = Date.parse("2026-10-29T12:00:00Z");
const inHours = (h: number) => new Date(now + h * 3_600_000).toISOString();
const usage = (...limits: PlanLimit[]): PlanUsage => ({ subscription: "max", limits });
const session = (utilization: number, resetsAt = inHours(2)): PlanLimit => ({ kind: "session", utilization, resetsAt });
const weekly = (utilization: number, resetsAt = inHours(50)): PlanLimit => ({ kind: "weekly", utilization, resetsAt });

describe("planWarning", () => {
  it("stays quiet under 75 %", () => {
    expect(planWarning(usage(session(74), weekly(40)), null, new Set(), now)).toBeNull();
  });

  it("warns about the fullest limit past a step", () => {
    const w = planWarning(usage(session(80), weekly(93)), null, new Set(), now);
    expect(w).toMatchObject({ level: "warn", limit: { kind: "weekly", utilization: 93 } });
  });

  it("a dismissed step comes back at the next one, and in the next window", () => {
    const at80 = session(80);
    const dismissed = new Set([planWarningKey(at80, 75)]);
    expect(planWarning(usage(at80), null, dismissed, now)).toBeNull();
    expect(planWarning(usage(session(91)), null, dismissed, now)).toMatchObject({ level: "warn" });
    expect(planWarning(usage(session(80, inHours(7))), null, dismissed, now)).toMatchObject({ level: "warn" });
  });

  it("the same reset a few seconds apart counts as the same window", () => {
    const a = session(80, new Date(now + 7_200_000).toISOString());
    const b = session(80, new Date(now + 7_203_000).toISOString());
    expect(planWarningKey(a, 75)).toBe(planWarningKey(b, 75));
  });

  it("skips a reading whose window has already reset", () => {
    expect(planWarning(usage(session(95, inHours(-1))), null, new Set(), now)).toBeNull();
  });

  it("a refusal wins, names its window, and ignores dismissals", () => {
    const at100 = session(100);
    const dismissed = new Set([planWarningKey(at100, 90)]);
    const w = planWarning(usage(at100, weekly(95)), { until: now + 3_600_000, kind: "session" }, dismissed, now);
    expect(w).toEqual({ level: "refused", limit: at100, until: now + 3_600_000 });
  });

  it("a refusal for a window it doesn't know still shows, without a limit", () => {
    const w = planWarning(usage(session(10)), { until: now + 60_000, kind: null }, new Set(), now);
    expect(w).toEqual({ level: "refused", limit: null, until: now + 60_000 });
  });

  it("an expired refusal falls back to the usage", () => {
    const w = planWarning(usage(session(80)), { until: now - 1, kind: "session" }, new Set(), now);
    expect(w).toMatchObject({ level: "warn" });
  });
});
