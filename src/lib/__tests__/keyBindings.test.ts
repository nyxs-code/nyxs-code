// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/settingsRuntime", () => ({ getMergedSnapshot: () => ({}), subscribeSettings: () => () => {} }));

const {
  DEFAULT_BINDINGS,
  chordOf,
  clashesWith,
  matchesChord,
  overridesFor,
  problemWith,
  resetAllOverrides,
  resolveBindings,
  shortcutFor,
  worksInPages,
} = await import("@/lib/keyBindings");

const key = (init: KeyboardEventInit & { keyCode?: number }) => {
  const e = new KeyboardEvent("keydown", init);
  if (init.keyCode !== undefined) Object.defineProperty(e, "keyCode", { get: () => init.keyCode });
  return e;
};

describe("a key event's chord", () => {
  it("names letters, digits, punctuation by place and F keys", () => {
    expect(chordOf(key({ key: "D", code: "KeyD", ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+D");
    expect(chordOf(key({ key: "k", code: "KeyK", metaKey: true }))).toBe("Ctrl+K");
    expect(chordOf(key({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+1");
    expect(chordOf(key({ key: "/", code: "Slash", ctrlKey: true }))).toBe("Ctrl+/");
    expect(chordOf(key({ key: "F6", code: "F6" }))).toBe("F6");
    // A Cyrillic layout: the letter of the key's place.
    expect(chordOf(key({ key: "л", code: "KeyK", ctrlKey: true }))).toBe("Ctrl+K");
    expect(chordOf(key({ key: "Enter", code: "Enter", ctrlKey: true }))).toBeNull();
  });

  it("takes the terminal's key on layouts where ` is a dead key", () => {
    expect(chordOf(key({ key: "Dead", code: "BracketLeft", ctrlKey: true }))).toBe("Ctrl+`");
    expect(chordOf(key({ key: "ñ", code: "Semicolon", ctrlKey: true, keyCode: 192 }))).toBe("Ctrl+`");
    expect(chordOf(key({ key: "~", code: "Backquote", ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+`");
  });

  it("matches punctuation by its character where the layout needs Shift for it", () => {
    // Spanish: "/" is Shift+7.
    expect(matchesChord("Ctrl+/", key({ key: "/", code: "Digit7", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(matchesChord("Ctrl+/", key({ key: "/", code: "Digit7", ctrlKey: true, altKey: true }))).toBe(false);
    expect(matchesChord("Ctrl+Shift+D", key({ key: "d", code: "KeyD", ctrlKey: true }))).toBe(false);
  });
});

describe("the user's shortcuts", () => {
  it("apply over the defaults, and a hand-edited unusable value is ignored", () => {
    const b = resolveBindings({ toggleDiff: "Ctrl+Shift+G", newSession: null, find: "Ctrl+C", sideChat: "Alt+J", bogus: "Ctrl+H" });
    expect(b.toggleDiff).toBe("Ctrl+Shift+G");
    expect(b.newSession).toBeNull();
    expect(b.find).toBe(DEFAULT_BINDINGS.find);
    expect(b.sideChat).toBe(DEFAULT_BINDINGS.sideChat);
    expect(shortcutFor(key({ key: "G", code: "KeyG", ctrlKey: true, shiftKey: true }), b)).toBe("toggleDiff");
    expect(shortcutFor(key({ key: "d", code: "KeyD", ctrlKey: true, shiftKey: true }), b)).toBeNull();
    expect(shortcutFor(key({ key: "n", code: "KeyN", ctrlKey: true }), b)).toBeNull();
  });

  it("refuse reserved keys, keys without Ctrl, Alt and the fixed shortcuts' keys", () => {
    expect(problemWith("Ctrl+C")).toEqual({ kind: "reserved" });
    expect(problemWith("F5")).toEqual({ kind: "reserved" });
    expect(problemWith("G")).toEqual({ kind: "needsModifier" });
    expect(problemWith("Shift+G")).toEqual({ kind: "needsModifier" });
    expect(problemWith("Ctrl+Alt+G")).toEqual({ kind: "needsModifier" });
    expect(problemWith("Ctrl+T")).toEqual({ kind: "fixed", by: "newBrowserTab" });
    expect(problemWith("Ctrl+Shift+G")).toBeNull();
    expect(problemWith("F6")).toBeNull();
  });

  it("find the shortcut a chord would take from, and write the change", () => {
    const b = resolveBindings({});
    expect(clashesWith("toggleDiff", "Ctrl+K", b)).toEqual(["searchSessions"]);
    expect(clashesWith("searchSessions", "Ctrl+K", b)).toEqual([]);
    expect(overridesFor("toggleDiff", "Ctrl+K", ["searchSessions"])).toEqual({ toggleDiff: "Ctrl+K", searchSessions: null });
    // Back to the default: the key leaves the settings.
    expect(overridesFor("toggleDiff", "Ctrl+Shift+D")).toEqual({ toggleDiff: undefined });
    expect(Object.values(resetAllOverrides()).every((v) => v === undefined)).toBe(true);
  });

  it("know which keys still reach the app from a page in the browser", () => {
    expect(worksInPages("Ctrl+Shift+D")).toBe(true);
    expect(worksInPages("Ctrl+`")).toBe(true);
    expect(worksInPages("Ctrl+Shift+G")).toBe(false);
    expect(worksInPages("F6")).toBe(false);
  });
});
