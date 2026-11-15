import { describe, it, expect } from "vitest";
import { reconcileSplit } from "@/lib/useSplitView";

const ids = (...list: string[]) => new Set(list);

describe("reconcileSplit", () => {
  const split = { left: "amber-fox", right: "quiet-owl" };

  it("keeps the panes while the open chat is one of them", () => {
    expect(reconcileSplit(split, "amber-fox", "left", ids("amber-fox", "quiet-owl"))).toBe(split);
    expect(reconcileSplit(split, "quiet-owl", "right", ids("amber-fox", "quiet-owl"))).toBe(split);
  });

  it("puts another opened session in the focused pane", () => {
    const all = ids("amber-fox", "quiet-owl", "bold-elk");
    expect(reconcileSplit(split, "bold-elk", "left", all)).toEqual({ left: "bold-elk", right: "quiet-owl" });
    expect(reconcileSplit(split, "bold-elk", "right", all)).toEqual({ left: "amber-fox", right: "bold-elk" });
  });

  it("ends the split for a new chat or a deleted pane", () => {
    expect(reconcileSplit(split, null, "left", ids("amber-fox", "quiet-owl"))).toBeNull();
    expect(reconcileSplit(split, "amber-fox", "left", ids("amber-fox"))).toBeNull();
  });

  it("does nothing without a split", () => {
    expect(reconcileSplit(null, "amber-fox", "left", ids("amber-fox"))).toBeNull();
  });
});
