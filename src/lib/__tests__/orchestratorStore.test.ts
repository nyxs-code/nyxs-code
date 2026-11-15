import { describe, it, expect } from "vitest";
import {
  initialWorkflowState,
  reduceEvent,
  groupByPhase,
  createWorkflowStore,
} from "@/lib/orchestratorStore";

describe("reduceEvent", () => {
  it("folds an agent lifecycle into counts and node status", () => {
    let s = initialWorkflowState();
    s = reduceEvent(s, { kind: "phase", title: "Review" });
    s = reduceEvent(s, { kind: "agent:start", id: 1, label: "review:bugs", phase: "Review" });
    expect(s.running).toBe(1);

    s = reduceEvent(s, { kind: "agent:retry", id: 1, label: "review:bugs", attempt: 1, reason: "bad json" });
    expect(s.agents[0].retries).toBe(1);

    s = reduceEvent(s, { kind: "agent:end", id: 1, label: "review:bugs", phase: "Review", ok: true, ms: 1200 });
    expect([s.running, s.completed, s.failed]).toEqual([0, 1, 0]);
    expect(s.agents[0].status).toBe("ok");
    expect(s.agents[0].ms).toBe(1200);
  });

  it("tracks failures and logs", () => {
    let s = initialWorkflowState();
    s = reduceEvent(s, { kind: "agent:start", id: 2, label: "verify" });
    s = reduceEvent(s, { kind: "agent:end", id: 2, label: "verify", ok: false, ms: 300 });
    expect([s.completed, s.failed]).toEqual([0, 1]);
    s = reduceEvent(s, { kind: "log", message: "hello" });
    expect(s.logs).toEqual(["hello"]);
  });

  it("is referentially stable on a duplicate phase", () => {
    const s = reduceEvent(initialWorkflowState(), { kind: "phase", title: "X" });
    expect(reduceEvent(s, { kind: "phase", title: "X" })).toBe(s);
  });
});

describe("groupByPhase", () => {
  it("groups agents under their phase in order", () => {
    let s = initialWorkflowState();
    s = reduceEvent(s, { kind: "agent:start", id: 1, label: "a", phase: "Review" });
    s = reduceEvent(s, { kind: "agent:start", id: 2, label: "b", phase: "Verify" });
    const groups = groupByPhase(s);
    expect(groups.map((g) => g.phase)).toEqual(["Review", "Verify"]);
    expect(groups[0].agents.length).toBe(1);
  });
});

describe("createWorkflowStore", () => {
  it("notifies subscribers and stops after unsubscribe", () => {
    const store = createWorkflowStore();
    let notified = 0;
    const unsub = store.subscribe(() => notified++);
    store.dispatch({ kind: "agent:start", id: 1, label: "x" });
    expect(notified).toBe(1);
    expect(store.getSnapshot().running).toBe(1);
    unsub();
    store.dispatch({ kind: "agent:end", id: 1, label: "x", ok: true, ms: 10 });
    expect(notified).toBe(1);
  });
});
