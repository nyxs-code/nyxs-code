import { describe, it, expect } from "vitest";
import { createCompactAborts } from "@/lib/compactAborts";

describe("createCompactAborts", () => {
  it("aborts only the chat asked for", () => {
    const aborts = createCompactAborts();
    const a = aborts.start("a");
    const b = aborts.start("b");
    expect(aborts.abort("a")).toBe(true);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
  });

  it("has nothing to abort once a run is released", () => {
    const aborts = createCompactAborts();
    const run = aborts.start("a");
    run.release();
    expect(aborts.abort("a")).toBe(false);
    expect(run.signal.aborted).toBe(false);
  });

  it("replaces an older run of the same chat, whose release leaves the new one alone", () => {
    const aborts = createCompactAborts();
    const old = aborts.start("a");
    const next = aborts.start("a");
    expect(old.signal.aborted).toBe(true);
    old.release();
    expect(aborts.abort("a")).toBe(true);
    expect(next.signal.aborted).toBe(true);
  });
});
