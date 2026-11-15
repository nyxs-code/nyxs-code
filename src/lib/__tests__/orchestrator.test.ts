import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createOrchestrator, extractJson, STOPPED_NOTE, type OrchestratorEvent } from "@/lib/orchestrator";
import { createWorkflowStore } from "@/lib/orchestratorStore";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("extractJson", () => {
  it("pulls JSON from raw, fenced, and prose-wrapped replies", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson("blah\n```json\n{\"a\":2}\n```\nok")).toEqual({ a: 2 });
    expect(extractJson("here it is: [1,2,3] done")).toEqual([1, 2, 3]);
  });
});

describe("concurrency", () => {
  it("never exceeds the configured limit", async () => {
    let active = 0;
    let max = 0;
    const o = createOrchestrator(async () => "x", { concurrency: 2 });
    await o.parallel(
      Array.from({ length: 6 }, () => async () => {
        active++;
        max = Math.max(max, active);
        await sleep(15);
        active--;
        return 1;
      }),
    );
    expect(max).toBe(2);
  });
});

describe("agent ids", () => {
  it("never repeats an id across workflows, which may share a view", async () => {
    const ids: number[] = [];
    const onEvent = (e: OrchestratorEvent) => {
      if (e.kind === "agent:start") ids.push(e.id);
    };
    const first = createOrchestrator(async () => "x", { onEvent });
    const second = createOrchestrator(async () => "x", { onEvent });
    await Promise.all([first.agent("a"), second.agent("b"), first.agent("c")]);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });
});

describe("parallel", () => {
  it("preserves order and maps errors to null", async () => {
    const o = createOrchestrator(async () => "x");
    const r = await o.parallel([
      async () => "a",
      async () => {
        throw new Error("boom");
      },
      async () => "c",
    ]);
    expect(r).toEqual(["a", null, "c"]);
  });
});

describe("pipeline", () => {
  it("runs stages per item with (prev,item,index) and no barrier", async () => {
    const o = createOrchestrator(async () => "x", { concurrency: 4 });
    const seen: unknown[] = [];
    const r = await o.pipeline<number, string>(
      [10, 20, 30],
      (_prev, item, i) => {
        seen.push([_prev, item, i]);
        return Promise.resolve((item as number) + 1);
      },
      (prev, item) => Promise.resolve(`${item}->${prev}`),
    );
    expect(r).toEqual(["10->11", "20->21", "30->31"]);
    expect(seen[0]).toEqual([10, 10, 0]);
  });

  it("drops a throwing item to null and skips its remaining stages", async () => {
    const o = createOrchestrator(async () => "x", { concurrency: 4 });
    const r = await o.pipeline<number, number>(
      [1, 2, 3],
      (_prev, item) => (item === 2 ? Promise.reject(new Error("x")) : Promise.resolve(item as number)),
      (prev) => Promise.resolve((prev as number) * 100),
    );
    expect(r).toEqual([100, null, 300]);
  });
});

describe("agent", () => {
  it("returns text without a schema", async () => {
    const o = createOrchestrator(async (p) => `echo:${p}`);
    expect(await o.agent("hi")).toBe("echo:hi");
  });

  it("validates against a schema, retrying on failure", async () => {
    const schema = z.object({ n: z.number() });
    const okO = createOrchestrator(async () => '{"n": 5}');
    expect(await okO.agent("x", { schema })).toEqual({ n: 5 });

    let calls = 0;
    const retryO = createOrchestrator(async () => {
      calls++;
      return calls < 2 ? "not json" : '{"n": 9}';
    });
    expect(await retryO.agent("x", { schema, maxRetries: 2 })).toEqual({ n: 9 });

    const badO = createOrchestrator(async () => "never json");
    await expect(badO.agent("x", { schema, maxRetries: 1 })).rejects.toThrow();
  });

  it("emits start/end events and respects an aborted signal", async () => {
    const kinds: string[] = [];
    const o = createOrchestrator(async () => "x", { onEvent: (e) => kinds.push(e.kind) });
    await o.agent("one");
    expect(kinds).toContain("agent:start");
    expect(kinds).toContain("agent:end");

    const ac = new AbortController();
    ac.abort();
    const aborted = createOrchestrator(async () => "x", { signal: ac.signal });
    await expect(aborted.agent("x")).rejects.toThrow();
  });
});

describe("reviewAndVerify", () => {
  it("de-dupes findings and keeps majority-confirmed ones", async () => {
    const findingsSchema = z.object({ findings: z.array(z.object({ id: z.string() })) });
    const verdictSchema = z.object({ confirmed: z.boolean() });
    const runner = async (prompt: string) => {
      if (prompt.startsWith("REVIEW")) {
        const id = prompt.includes("uniq") ? "uniq" : "dup";
        return JSON.stringify({ findings: [{ id }] });
      }
      return JSON.stringify({ confirmed: prompt.includes("dup") });
    };
    const o = createOrchestrator(runner, { concurrency: 8 });
    const kept = await o.reviewAndVerify({
      dimensions: [
        { key: "A", prompt: "REVIEW dimA" },
        { key: "B", prompt: "REVIEW dimB" },
        { key: "C", prompt: "REVIEW dimC uniq" },
      ],
      findingsSchema,
      verifyPrompt: (f) => `verify ${f.id}`,
      verdictSchema,
      verifiers: 3,
      dedupeKey: (f) => f.id,
    });
    expect(kept.map((f) => f.id).sort()).toEqual(["dup"]);
  });
});

describe("migrate", () => {
  it("reports transform throws and verify failures per item", async () => {
    const o = createOrchestrator(async () => "x", { concurrency: 4 });
    const res = await o.migrate({
      items: ["a", "b", "c"],
      transform: async (it) => {
        if (it === "b") throw new Error("fail");
        return it.toUpperCase();
      },
      verify: async (r) => r !== "C",
    });
    expect(res.map((r) => ({ ok: r.ok, result: r.result }))).toEqual([
      { ok: true, result: "A" },
      { ok: false, result: null },
      { ok: false, result: "C" },
    ]);
  });
});

describe("nested fan-out", () => {
  it("does not deadlock when parallel runs more agents than the limit", async () => {
    let active = 0;
    let peak = 0;
    const o = createOrchestrator(
      async () => {
        active++;
        peak = Math.max(peak, active);
        await sleep(5);
        active--;
        return "ok";
      },
      { concurrency: 3 },
    );
    const r = await o.parallel(Array.from({ length: 9 }, (_, i) => () => o.agent(`item ${i}`)));
    expect(r).toEqual(Array(9).fill("ok"));
    expect(peak).toBe(3);
  });

  it("does not deadlock when a pipeline stage fans out into agents", async () => {
    const o = createOrchestrator(async (p) => p, { concurrency: 2 });
    const r = await o.pipeline<number, string[]>(
      [1, 2, 3, 4],
      (_prev, item) => o.parallel([1, 2, 3].map((k) => () => o.agent(`${item}.${k}`))),
    );
    expect(r[3]).toEqual(["4.1", "4.2", "4.3"]);
  });
});

describe("stopping one agent", () => {
  it("ends that agent with its partial report and lets the others finish", async () => {
    const events: OrchestratorEvent[] = [];
    const runner = async (prompt: string, opts: { signal?: AbortSignal; onActivity?: (a: never) => void }) => {
      if (prompt === "slow") {
        opts.onActivity?.({ kind: "text", delta: "half done" } as never);
        await new Promise<void>((resolve) => opts.signal?.addEventListener("abort", () => resolve()));
        return "half done";
      }
      await sleep(5);
      return "full report";
    };
    const o = createOrchestrator(runner, { onEvent: (e) => events.push(e) });
    const run = o.parallel([() => o.agent("slow"), () => o.agent("fast")]);
    await sleep(1);
    const start = events.find((e) => e.kind === "agent:start" && e.label === "slow");
    if (start?.kind !== "agent:start") throw new Error("no start event");
    start.stop?.();
    const [slow, fast] = await run;
    expect(slow).toBe(`half done\n\n${STOPPED_NOTE}`);
    expect(fast).toBe("full report");
    const ends = events.filter((e) => e.kind === "agent:end");
    expect(ends.map((e) => e.kind === "agent:end" && [e.label, e.stopped])).toEqual(
      expect.arrayContaining([["slow", true], ["fast", false]]),
    );
  });

  it("shows the stopped agent's activity and counts it apart from failures", () => {
    const store = createWorkflowStore();
    let stopped = false;
    store.dispatch({ kind: "agent:start", id: 1, label: "a", stop: () => (stopped = true) });
    store.dispatch({ kind: "agent:activity", id: 1, activity: { kind: "text", delta: "Hola " } });
    store.dispatch({ kind: "agent:activity", id: 1, activity: { kind: "text", delta: "mundo" } });
    store.dispatch({ kind: "agent:activity", id: 1, activity: { kind: "tool-call", callId: "c1", name: "Read", detail: "a.ts" } });
    store.stopAgent(1);
    expect(stopped).toBe(true);
    store.dispatch({ kind: "agent:end", id: 1, label: "a", ok: false, ms: 3, stopped: true });
    const s = store.getSnapshot();
    expect(s.agents[0].status).toBe("stopped");
    expect(s.agents[0].stoppable).toBe(false);
    expect(s.agents[0].activity).toEqual([
      { kind: "text", text: "Hola mundo" },
      // Cut off by the stop, not failed.
      { kind: "tool", callId: "c1", name: "Read", detail: "a.ts", status: "stopped" },
    ]);
    expect([s.completed, s.failed, s.stopped]).toEqual([0, 0, 1]);
  });
});
