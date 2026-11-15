import { describe, it, expect } from "vitest";
import { getWorkflowStore, resetWorkflow } from "../workflowSession";

describe("workflowSession", () => {
  it("returns a stable singleton store", () => {
    const a = getWorkflowStore();
    const b = getWorkflowStore();
    expect(a).toBe(b);
  });

  it("the shared store reduces orchestrator events into the snapshot", () => {
    const store = getWorkflowStore();
    resetWorkflow();
    expect(store.getSnapshot().agents.length).toBe(0);

    store.dispatch({ kind: "agent:start", id: 1, label: "review:bugs", phase: "Review" });
    let snap = store.getSnapshot();
    expect(snap.agents.length).toBe(1);
    expect(snap.agents[0].status).toBe("running");

    store.dispatch({ kind: "agent:end", id: 1, label: "review:bugs", phase: "Review", ok: true, ms: 12 });
    snap = store.getSnapshot();
    expect(snap.agents[0].status).toBe("ok");
  });

  it("notifies subscribers on dispatch and stops after unsubscribe", () => {
    const store = getWorkflowStore();
    resetWorkflow();
    let hits = 0;
    const unsub = store.subscribe(() => { hits++; });
    store.dispatch({ kind: "log", message: "hello" });
    expect(hits).toBeGreaterThan(0);
    const after = hits;
    unsub();
    store.dispatch({ kind: "log", message: "again" });
    expect(hits).toBe(after);
  });

  it("reset clears the tree once its agents are done", () => {
    const store = getWorkflowStore();
    store.dispatch({ kind: "agent:start", id: 9, label: "x" });
    store.dispatch({ kind: "agent:end", id: 9, label: "x", ok: true, ms: 1 });
    expect(store.getSnapshot().agents.length).toBeGreaterThan(0);
    resetWorkflow();
    expect(store.getSnapshot().agents.length).toBe(0);
  });

  it("keeps each chat's agents in its own view", () => {
    const a = getWorkflowStore("chat-a");
    const b = getWorkflowStore("chat-b");
    expect(a).not.toBe(b);
    expect(getWorkflowStore("chat-a")).toBe(a);
    a.dispatch({ kind: "agent:start", id: 1, label: "only in a" });
    expect(b.getSnapshot().agents).toEqual([]);
    resetWorkflow("chat-b");
    expect(a.getSnapshot().agents).toHaveLength(1);
  });

  it("doesn't clear a view while one of its agents still runs", () => {
    const store = getWorkflowStore("chat-c");
    store.dispatch({ kind: "agent:start", id: 1, label: "running" });
    resetWorkflow("chat-c");
    expect(store.getSnapshot().agents).toHaveLength(1);
  });
});
