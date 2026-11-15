import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createStreamBuffer, setShownChats } from "@/lib/streamBuffer";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  setShownChats(null);
  vi.useRealTimers();
});

function setup() {
  const content: string[] = [];
  const reasoning: Array<{ deltas: Record<string, string>; times: Record<string, { start: number; end: number }> }> = [];
  const buf = createStreamBuffer({
    content: (d) => content.push(d),
    reasoning: (deltas, times) => reasoning.push({ deltas, times }),
  }, () => Date.now());
  return { buf, content, reasoning };
}

describe("createStreamBuffer", () => {
  it("joins the deltas that arrive close together into one update", () => {
    const { buf, content } = setup();
    buf.content("Hola");
    buf.content(", ");
    buf.content("mundo");
    expect(content).toEqual([]);
    vi.advanceTimersByTime(80);
    expect(content).toEqual(["Hola, mundo"]);
  });

  it("hands everything over at once on flush", () => {
    const { buf, content, reasoning } = setup();
    buf.content("a");
    buf.reasoning("r1", "pienso");
    buf.flush();
    expect(content).toEqual(["a"]);
    expect(reasoning[0].deltas).toEqual({ r1: "pienso" });
    vi.advanceTimersByTime(200);
    expect(content).toEqual(["a"]);
  });

  it("keeps when each reasoning block started and when it last grew", () => {
    const { buf, reasoning } = setup();
    const t0 = Date.now();
    buf.reasoning("r1", "uno");
    // The first delta of a reply isn't held back.
    vi.advanceTimersByTime(30);
    expect(reasoning[0]).toEqual({ deltas: { r1: "uno" }, times: { r1: { start: t0, end: t0 } } });
    buf.reasoning("r1", " dos");
    buf.flush();
    expect(reasoning[1]).toEqual({ deltas: { r1: " dos" }, times: { r1: { start: t0, end: t0 + 30 } } });
  });

  it("updates a chat that isn't on screen less often", () => {
    setShownChats(["shown"]);
    const got: Record<string, string[]> = { shown: [], hidden: [] };
    const make = (id: string) => createStreamBuffer({ content: (d) => got[id].push(d), reasoning: () => {} }, () => Date.now(), id);
    const shown = make("shown");
    const hidden = make("hidden");
    // The first delta of each goes straight away.
    shown.content("a");
    hidden.content("a");
    vi.advanceTimersByTime(0);
    shown.content("b");
    hidden.content("b");
    vi.advanceTimersByTime(160);
    expect(got.shown).toEqual(["a", "b"]);
    expect(got.hidden).toEqual(["a"]);
    vi.advanceTimersByTime(500);
    expect(got.hidden).toEqual(["a", "b"]);
  });

  it("delivers streams running side by side in the same tick", () => {
    const order: string[] = [];
    const make = (id: string) => createStreamBuffer({ content: (d) => order.push(`${id}:${d}`), reasoning: () => {} }, () => Date.now(), id);
    const one = make("one");
    const two = make("two");
    one.content("x");
    two.content("x");
    vi.advanceTimersByTime(0);
    one.content("y");
    vi.advanceTimersByTime(30);
    two.content("y");
    const before = order.length;
    // Both are due on the same grid step, so one timer hands over both.
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(160);
    expect(order.slice(before)).toEqual(["one:y", "two:y"]);
  });

  it("does nothing when there is nothing waiting", () => {
    const { buf, content, reasoning } = setup();
    buf.flush();
    expect(content).toEqual([]);
    expect(reasoning).toEqual([]);
  });
});
