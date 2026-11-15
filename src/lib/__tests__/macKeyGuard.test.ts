import { describe, it, expect } from "vitest";
import { caretFor, hasKeyChars, stripKeyChars } from "@/lib/macKeyGuard";

const LEFT = "";
const RIGHT = "";
const UP = "";
const DOWN = "";
const HOME = "";
const END = "";

describe("stripKeyChars", () => {
  it("removes the characters AppKit types for function keys and Delete", () => {
    const typed = `i want\u007F closing`;
    expect(hasKeyChars(typed)).toBe(true);
    expect(stripKeyChars(typed)).toBe("i want closing");
    expect(hasKeyChars("ñandú 🎉")).toBe(false);
  });
});

describe("caretFor", () => {
  it("moves left and right, collapsing a selection to its edge first", () => {
    expect(caretFor(LEFT, "hello", 3, 3, false)).toEqual({ start: 2, end: 2 });
    expect(caretFor(LEFT, "hello", 0, 0, false)).toEqual({ start: 0, end: 0 });
    expect(caretFor(LEFT, "hello", 1, 4, false)).toEqual({ start: 1, end: 1 });
    expect(caretFor(RIGHT, "hello", 5, 5, false)).toEqual({ start: 5, end: 5 });
    expect(caretFor(RIGHT, "hello", 1, 4, false)).toEqual({ start: 4, end: 4 });
  });

  it("extends the selection with Shift", () => {
    expect(caretFor(LEFT, "hello", 3, 3, true)).toEqual({ start: 2, end: 3 });
    expect(caretFor(RIGHT, "hello", 1, 3, true)).toEqual({ start: 1, end: 4 });
  });

  it("steps over an emoji as one character", () => {
    const v = "a🎉b";
    expect(caretFor(LEFT, v, 3, 3, false)).toEqual({ start: 1, end: 1 });
    expect(caretFor(RIGHT, v, 1, 1, false)).toEqual({ start: 3, end: 3 });
  });

  it("goes to the line's edges with Home and End, and to the field's with Up and Down on one line", () => {
    expect(caretFor(HOME, "one\ntwo", 6, 6, false)).toEqual({ start: 4, end: 4 });
    expect(caretFor(END, "one\ntwo", 1, 1, false)).toEqual({ start: 3, end: 3 });
    expect(caretFor(UP, "hello", 3, 3, false)).toEqual({ start: 0, end: 0 });
    expect(caretFor(DOWN, "hello", 3, 3, false)).toEqual({ start: 5, end: 5 });
  });

  it("keeps the column moving between lines, clamped to a shorter line", () => {
    const v = "abcdef\nxy\nlonger";
    expect(caretFor(UP, v, 9, 9, false)).toEqual({ start: 2, end: 2 });
    expect(caretFor(DOWN, v, 5, 5, false)).toEqual({ start: 9, end: 9 });
    expect(caretFor(DOWN, v, 8, 8, false)).toEqual({ start: 11, end: 11 });
  });

  it("ignores keys that aren't movements", () => {
    expect(caretFor("", "hello", 2, 2, false)).toBeNull();
  });
});
