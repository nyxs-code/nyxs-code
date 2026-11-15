// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { isPageShortcut, replayPageKey, toPageKey, type PageKey } from "../pageShortcuts";

const key = (over: Partial<PageKey>): PageKey => ({ key: "s", code: "KeyS", keyCode: 83, shiftKey: false, ctrlKey: true, metaKey: false, ...over });

describe("isPageShortcut", () => {
  it("passes on the app's shortcuts", () => {
    expect(isPageShortcut(key({ key: "S", shiftKey: true }))).toBe(true);
    expect(isPageShortcut(key({ key: "Tab", code: "Tab", keyCode: 9 }))).toBe(true);
    expect(isPageShortcut(key({ key: "Tab", code: "Tab", keyCode: 9, shiftKey: true }))).toBe(true);
    expect(isPageShortcut(key({ key: "}", code: "BracketRight", keyCode: 221, shiftKey: true }))).toBe(true);
    for (const k of ["j", "o", "k", "n", "t", ",", "/", ";", "\\"]) expect(isPageShortcut(key({ key: k }))).toBe(true);
    // The terminal on a Spanish keyboard: Ctrl+Ñ.
    expect(isPageShortcut(key({ key: "ñ", code: "Semicolon", keyCode: 192 }))).toBe(true);
    expect(isPageShortcut(key({ key: "j", ctrlKey: false, metaKey: true }))).toBe(true);
  });

  it("leaves the page what it means for itself", () => {
    expect(isPageShortcut(key({ key: "Escape", code: "Escape", keyCode: 27, ctrlKey: false }))).toBe(false);
    expect(isPageShortcut(key({ key: "f" }))).toBe(false);
    expect(isPageShortcut(key({ key: "c" }))).toBe(false);
    expect(isPageShortcut(key({ key: "s" }))).toBe(false);
    expect(isPageShortcut(key({ key: "j", ctrlKey: false }))).toBe(false);
    expect(isPageShortcut(key({ key: "I", shiftKey: true }))).toBe(false);
  });
});

describe("the page's bridge", () => {
  it("passes on the same shortcuts the app takes", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src-tauri/src/agent/preview_agent.js", "utf8");
    const body = /function appShortcut\(e\) \{[\s\S]*?\n {2}\}/.exec(src)?.[0];
    expect(body).toBeTruthy();
    const appShortcut = new Function(`${body}; return appShortcut;`)() as (k: PageKey & { altKey: boolean }) => boolean;
    const keys = [..."abcdefghijklmnopqrstuvwxyz0123456789,./;\\`~[]", "Tab", "Escape", "Enter", "ñ"];
    for (const k of keys) {
      for (const shiftKey of [false, true]) {
        for (const [code, keyCode] of [["KeyX", 88], ["BracketLeft", 219], ["Backquote", 192], ["Semicolon", 186]] as const) {
          const pressed = key({ key: k, code, keyCode, shiftKey });
          expect(appShortcut({ ...pressed, altKey: false }), JSON.stringify(pressed)).toBe(isPageShortcut(pressed));
        }
      }
    }
  });
});

describe("toPageKey", () => {
  it("takes a well-formed shortcut from a page's message", () => {
    expect(toPageKey({ source: "nyxs-agent-key", key: "j", code: "KeyJ", keyCode: 74, ctrlKey: true })).toEqual(key({ key: "j", code: "KeyJ", keyCode: 74 }));
  });

  it("drops anything else a page could post", () => {
    expect(toPageKey(null)).toBeNull();
    expect(toPageKey("Escape")).toBeNull();
    expect(toPageKey({ key: "Escape", code: "Escape", keyCode: 27 })).toBeNull();
    expect(toPageKey({ key: "j", code: "KeyJ", keyCode: "74", ctrlKey: true })).toBeNull();
    expect(toPageKey({ key: "j", code: "KeyJ", keyCode: 74, ctrlKey: "yes" })).toBeNull();
  });
});

describe("replayPageKey", () => {
  it("reaches the app's listeners as the key typed there", () => {
    const seen = vi.fn();
    const onKey = (e: KeyboardEvent) => seen({ key: e.key, code: e.code, keyCode: e.keyCode, ctrl: e.ctrlKey, shift: e.shiftKey });
    window.addEventListener("keydown", onKey);
    document.addEventListener("keydown", onKey);
    replayPageKey(key({ key: "ñ", code: "Semicolon", keyCode: 192 }));
    window.removeEventListener("keydown", onKey);
    document.removeEventListener("keydown", onKey);
    expect(seen).toHaveBeenCalledTimes(2);
    expect(seen).toHaveBeenCalledWith({ key: "ñ", code: "Semicolon", keyCode: 192, ctrl: true, shift: false });
  });
});
