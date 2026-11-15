import { describe, it, expect } from "vitest";
import { ANSWER_HOLD_CAP, ANSWER_HOLD_MS, createReasoningRouter, firstTag, partialTagLen } from "@/lib/reasoningStream";

function harness(passthrough = false) {
  const answer: string[] = [];
  const reasoning: string[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const router = createReasoningRouter({
    passthrough,
    emit: (t) => answer.push(t),
    emitReasoning: (t) => reasoning.push(t),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
  });
  const fireTimers = () => {
    for (const t of timers.splice(0)) if (!t.cleared) t.fn();
  };
  return { router, answer, reasoning, timers, fireTimers, text: () => answer.join(""), thought: () => reasoning.join("") };
}

describe("tag helpers", () => {
  it("finds the first tag and partial tag tails", () => {
    expect(firstTag("a<think>b</think>")).toEqual({ kind: "open", i: 1, len: 7 });
    expect(firstTag("a</think>b<think>")).toEqual({ kind: "close", i: 1, len: 8 });
    expect(firstTag("ab<mm:think>c")).toEqual({ kind: "open", i: 2, len: 10 });
    expect(firstTag("x</mm:think><think>")).toEqual({ kind: "close", i: 1, len: 11 });
    expect(firstTag("plain")).toBeNull();
    expect(partialTagLen("hello <thi", "<think>")).toBe(4);
    expect(partialTagLen("hello", "<think>")).toBe(0);
  });
});

describe("reasoning router", () => {
  it("splits <think> blocks even when the tags are cut across chunks", () => {
    const h = harness();
    for (const c of ["<th", "ink>plan ", "the work</th", "ink>The answer."]) h.router.push(c);
    h.router.flush();
    expect(h.thought()).toBe("plan the work");
    expect(h.text()).toBe("The answer.");
  });

  it("never leaks half a tag into the answer", () => {
    const h = harness();
    h.router.push("\n<thi");
    expect(h.text()).toBe("");
    h.router.push("nk>x</thi");
    expect(h.text()).toBe("\n");
    h.router.push("nk>Done");
    h.router.flush();
    expect(h.text()).toBe("\nDone");
    expect(h.thought()).toBe("x");
  });

  it("keeps a <think> written after the step's answer started as part of the answer", () => {
    const h = harness();
    h.router.push("Wrap it in a ");
    h.router.push("<think> tag, then close it.");
    h.router.flush();
    expect(h.text()).toBe("Wrap it in a <think> tag, then close it.");
    expect(h.thought()).toBe("");
    const after = harness();
    after.router.push("<think>plan</think>Close it with ");
    after.router.push("</think> and <think> again.");
    after.router.flush();
    expect(after.thought()).toBe("plan");
    expect(after.text()).toBe("Close it with </think> and <think> again.");
  });

  it("holds early answer text until it knows whether reasoning comes first", () => {
    const h = harness();
    h.router.push("Short start");
    expect(h.answer).toEqual([]);
    expect(h.timers[0].ms).toBe(ANSWER_HOLD_MS);
    h.fireTimers();
    expect(h.text()).toBe("Short start");
  });

  it("releases held text once it passes the hold cap", () => {
    const h = harness();
    h.router.push("a".repeat(ANSWER_HOLD_CAP));
    expect(h.text()).toHaveLength(ANSWER_HOLD_CAP);
  });

  it("streams answer text immediately after reasoning was seen", () => {
    const h = harness();
    h.router.markReasoningSeen();
    h.router.push("now");
    expect(h.text()).toBe("now");
  });

  it("treats a bare closing tag as the end of leading reasoning", () => {
    const h = harness();
    h.router.push("thinking first</think>answer");
    h.router.flush();
    expect(h.thought()).toBe("thinking first");
    expect(h.text()).toBe("answer");
  });

  it("splits MiniMax's <mm:think> blocks, cut across chunks, step after step", () => {
    const h = harness();
    for (const c of ["<mm:th", "ink>The user asks what the project is about.", "</mm:thi", "nk>Voy a revisar el README."]) h.router.push(c);
    h.router.newStep();
    h.router.push("<mm:think>Let me summarize.</mm:think>Ya tengo el panorama.");
    h.router.flush();
    expect(h.thought()).toBe("The user asks what the project is about.Let me summarize.");
    expect(h.text()).toBe("Voy a revisar el README.Ya tengo el panorama.");
  });

  it("drops a bare </mm:think> that opens a step", () => {
    const h = harness();
    h.router.push("</mm:think>**Nyxs** es un agente");
    h.router.flush();
    expect(h.text()).toBe("**Nyxs** es un agente");
    expect(h.thought()).toBe("");
  });

  it("flush leaves nothing trapped, in either mode", () => {
    const a = harness();
    a.router.push("tail <");
    a.router.flush();
    expect(a.text()).toBe("tail <");
    const b = harness();
    b.router.push("<think>unfinished thought");
    b.router.flush();
    expect(b.thought()).toBe("unfinished thought");
    expect(b.text()).toBe("");
  });

  it("a new chunk cancels the pending hold timer", () => {
    const h = harness();
    h.router.push("one ");
    h.router.push("two");
    expect(h.timers[0].cleared).toBe(true);
    h.fireTimers();
    expect(h.text()).toBe("one two");
  });

  it("passes text straight through for providers with native reasoning", () => {
    const h = harness(true);
    h.router.push("<think>not parsed</think>");
    expect(h.text()).toBe("<think>not parsed</think>");
    expect(h.reasoning).toEqual([]);
  });
});
