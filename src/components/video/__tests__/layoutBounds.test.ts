import { describe, expect, it } from "vitest";
import { fitSizes, keyedSize, sideColumns, splitRange, TIMELINE_MIN } from "../layoutBounds";

const box = { width: 1400, height: 900 };
const sizes = { bin: 220, inspector: 280, timeline: 240 };
const both = { showBin: true, showInspector: true };

describe("splitter ranges", () => {
  it("lets the timeline grow until the canvas keeps 120 px, and never below one track", () => {
    expect(splitRange("timeline", box, sizes, both)).toEqual([TIMELINE_MIN, 900 - 44 - 40 - 120]);
    // A tiny window can't go under the minimum.
    expect(splitRange("timeline", { width: 800, height: 200 }, sizes, both)).toEqual([TIMELINE_MIN, TIMELINE_MIN]);
  });

  it("keeps room for the player and the other column", () => {
    expect(splitRange("inspector", box, sizes, both)[1]).toBe(480);
    expect(splitRange("bin", { width: 800, height: 900 }, sizes, both)).toEqual([160, 800 - 280 - 240]);
  });
});

describe("fitting saved sizes", () => {
  it("squeezes on a small window without changing the saved value, and gives it back", () => {
    const tall = { ...sizes, timeline: 600 };
    expect(fitSizes(tall, { width: 1400, height: 500 }, both).timeline).toBe(500 - 44 - 40 - 120);
    expect(fitSizes(tall, box, both).timeline).toBe(600);
  });

  it("makes the bin give way before the inspector", () => {
    const fit = fitSizes({ bin: 420, inspector: 300, timeline: 240 }, { width: 800, height: 900 }, both);
    expect(fit.inspector).toBe(300);
    expect(fit.bin).toBe(260);
  });

  it("folds the side columns in a narrow panel", () => {
    expect(sideColumns(true, true, { width: 700, height: 900 })).toEqual({ showBin: false, showInspector: true });
    expect(sideColumns(true, true, { width: 500, height: 900 })).toEqual({ showBin: false, showInspector: false });
    expect(sideColumns(false, true, box).showBin).toBe(false);
  });
});

describe("keyboard on a splitter", () => {
  const r: [number, number] = [100, 500];
  it("grows with the arrow towards the player, by 10 or 50 with Shift, inside the range", () => {
    expect(keyedSize("timeline", "ArrowUp", false, 200, r)).toBe(210);
    expect(keyedSize("timeline", "ArrowDown", true, 200, r)).toBe(150);
    expect(keyedSize("bin", "ArrowRight", false, 200, r)).toBe(210);
    expect(keyedSize("inspector", "ArrowLeft", false, 200, r)).toBe(210);
    expect(keyedSize("timeline", "ArrowUp", true, 490, r)).toBe(500);
  });

  it("goes to the ends with Home and End, and ignores other keys", () => {
    expect(keyedSize("bin", "Home", false, 200, r)).toBe(100);
    expect(keyedSize("bin", "End", false, 200, r)).toBe(500);
    expect(keyedSize("bin", "a", false, 200, r)).toBeNull();
    expect(keyedSize("timeline", "ArrowLeft", false, 200, r)).toBeNull();
  });
});
