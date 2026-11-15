import { describe, it, expect, vi } from "vitest";
import {
  emptyTaskRegistry,
  createTask,
  startTask,
  appendOutput,
  addTokens,
  finishTask,
  stopTask,
  activeTasks,
  getTask,
  summarizeTasks,
  isTerminal,
  createTaskRegistry,
  serializeRegistry,
  restoreRegistry,
} from "@/lib/taskRegistry";

describe("pure mutations", () => {
  it("creates a task in pending state and ignores duplicate ids", () => {
    let s = emptyTaskRegistry();
    s = createTask(s, { id: "t1", label: "build", now: 100 });
    expect(s.tasks).toHaveLength(1);
    expect(getTask(s, "t1")!.status).toBe("pending");
    const same = createTask(s, { id: "t1", label: "dupe", now: 200 });
    expect(same).toBe(s);
  });

  it("walks the lifecycle pending → running → done with output and tokens", () => {
    let s = createTask(emptyTaskRegistry(), { id: "t1", label: "x", now: 1 });
    s = startTask(s, "t1", 2);
    expect(getTask(s, "t1")!.status).toBe("running");
    s = appendOutput(s, "t1", "hello ");
    s = appendOutput(s, "t1", "world");
    s = addTokens(s, "t1", 12);
    s = finishTask(s, "t1", { status: "done", now: 9 });
    const t = getTask(s, "t1")!;
    expect(t.output).toBe("hello world");
    expect(t.tokens).toBe(12);
    expect(t.status).toBe("done");
    expect(t.endedAt).toBe(9);
  });

  it("does not mutate a terminal task", () => {
    let s = createTask(emptyTaskRegistry(), { id: "t1", label: "x", now: 1 });
    s = finishTask(s, "t1", { status: "failed", error: "boom", now: 5 });
    const afterAppend = appendOutput(s, "t1", "late");
    const afterStop = stopTask(s, "t1", 6);
    expect(afterAppend).toBe(s);
    expect(afterStop).toBe(s);
    expect(getTask(s, "t1")!.status).toBe("failed");
    expect(getTask(s, "t1")!.error).toBe("boom");
  });

  it("tracks active vs terminal and summarizes", () => {
    let s = emptyTaskRegistry();
    s = createTask(s, { id: "a", label: "alpha", now: 1 });
    s = createTask(s, { id: "b", label: "beta", now: 1 });
    s = startTask(s, "a", 2);
    s = addTokens(s, "a", 5);
    s = finishTask(s, "b", { status: "done", now: 3 });
    expect(activeTasks(s).map((t) => t.id)).toEqual(["a"]);
    expect(isTerminal("done")).toBe(true);
    expect(isTerminal("running")).toBe(false);
    expect(summarizeTasks(s)).toContain("[running] a — alpha (5 tok)");
    expect(summarizeTasks(emptyTaskRegistry())).toBe("No background tasks.");
  });
});

describe("createTaskRegistry store", () => {
  it("notifies subscribers and exposes snapshots", () => {
    let tick = 0;
    const reg = createTaskRegistry(() => ++tick);
    let notified = 0;
    const unsub = reg.subscribe(() => notified++);
    reg.create("t1", "build");
    reg.start("t1");
    expect(notified).toBe(2);
    expect(reg.get("t1")!.status).toBe("running");
    unsub();
    reg.finish("t1", "done");
    expect(notified).toBe(2);
    expect(reg.get("t1")!.status).toBe("done");
  });

  it("stop() aborts the task's controller and marks it stopped", () => {
    const reg = createTaskRegistry(() => 0);
    const controller = new AbortController();
    const onAbort = vi.fn();
    controller.signal.addEventListener("abort", onAbort);
    reg.create("t1", "long job", controller);
    reg.start("t1");
    const stopped = reg.stop("t1");
    expect(stopped).toBe(true);
    expect(onAbort).toHaveBeenCalledOnce();
    expect(reg.get("t1")!.status).toBe("stopped");
    expect(reg.stop("t1")).toBe(false);
  });

  it("reset aborts in-flight controllers and clears state", () => {
    const reg = createTaskRegistry(() => 0);
    const c = new AbortController();
    reg.create("t1", "x", c);
    reg.reset();
    expect(c.signal.aborted).toBe(true);
    expect(reg.list()).toHaveLength(0);
  });

  it("hydrate restores persisted tasks, downgrading mid-flight ones to stopped", () => {
    const reg = createTaskRegistry(() => 0);
    reg.hydrate([
      { id: "a", label: "done job", status: "done", output: "ok", tokens: 3, createdAt: 1, endedAt: 2 },
      { id: "b", label: "was running", status: "running", output: "partial", tokens: 1, createdAt: 1, startedAt: 1 },
    ]);
    expect(reg.get("a")!.status).toBe("done");
    expect(reg.get("b")!.status).toBe("stopped");
    expect(reg.get("b")!.endedAt).toBe(1);
  });
});

describe("persistence", () => {
  it("round-trips a snapshot, downgrading in-flight tasks on restore", () => {
    let s = emptyTaskRegistry();
    s = createTask(s, { id: "a", label: "x", now: 1 });
    s = startTask(s, "a", 2);
    s = createTask(s, { id: "b", label: "y", now: 1 });
    s = finishTask(s, "b", { status: "done", now: 3 });

    const snapshot = JSON.parse(JSON.stringify(serializeRegistry(s)));
    const restored = restoreRegistry(snapshot);
    expect(getTask(restored, "a")!.status).toBe("stopped");
    expect(getTask(restored, "b")!.status).toBe("done");
    expect(restoreRegistry([]).tasks).toEqual([]);
  });
});
