// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";

vi.mock("@/lib/composerMenus", () => ({ cycleComposerEffort: vi.fn(), openComposerMenu: vi.fn() }));
vi.mock("@/lib/theme", () => ({ cycleThemePreference: vi.fn() }));
vi.mock("@/lib/transcriptView", () => ({ cycleTranscriptView: vi.fn() }));
vi.mock("@/lib/sideChat", () => ({ toggleSideChat: vi.fn() }));

const { useAppShortcuts } = await import("../useAppShortcuts");
type Actions = import("../useAppShortcuts").AppShortcutActions;

function mount() {
  const a = {
    streaming: false,
    stop: vi.fn(),
    newChat: vi.fn(),
    toggleSettings: vi.fn(),
    toggleShortcuts: vi.fn(),
    openFind: vi.fn(),
    toggleSessionSearch: vi.fn(),
    toggleSidebar: vi.fn(),
    closeViews: vi.fn(),
    toggleView: vi.fn(),
    openNewTerminal: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    cycleSession: vi.fn(),
  } satisfies Actions;
  renderHook(() => useAppShortcuts({ current: a }));
  return a;
}

/** A key pressed in a text field, as Chromium on Windows reports it. */
function press(init: KeyboardEventInit) {
  const input = document.createElement("input");
  document.body.appendChild(input);
  input.focus();
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  input.dispatchEvent(e);
  input.remove();
  return e;
}

/** AltGr on Windows arrives as Ctrl+Alt, with the AltGraph modifier where the browser knows it. */
const altGr = (key: string, code: string, flagged = true): KeyboardEventInit =>
  ({ key, code, ctrlKey: true, altKey: true, modifierAltGraph: flagged }) as KeyboardEventInit;

afterEach(cleanup);

describe("useAppShortcuts", () => {
  it("lets AltGr type its characters instead of running shortcuts", () => {
    const a = mount();
    // Spanish layout: \ is AltGr+º, @ AltGr+2, # AltGr+3, | AltGr+1.
    for (const [key, code] of [["\\", "Backquote"], ["@", "Digit2"], ["#", "Digit3"], ["|", "Digit1"], ["/", "Digit7"]]) {
      for (const flagged of [true, false]) {
        const e = press(altGr(key, code, flagged));
        expect(e.defaultPrevented, `${key} (${flagged})`).toBe(false);
      }
    }
    expect(a.closeViews).not.toHaveBeenCalled();
    expect(a.toggleShortcuts).not.toHaveBeenCalled();
  });

  it("finds punctuation shortcuts by the key's place", () => {
    const a = mount();
    // A Spanish keyboard: the key where a US keyboard has / gives "-", ; gives "ñ", \ gives "ç".
    press({ key: "-", code: "Slash", ctrlKey: true });
    press({ key: "ñ", code: "Semicolon", ctrlKey: true });
    press({ key: "ç", code: "Backslash", ctrlKey: true });
    press({ key: ",", code: "Comma", ctrlKey: true });
    expect(a.toggleShortcuts).toHaveBeenCalledTimes(1);
    expect(a.toggleSidebar).toHaveBeenCalledTimes(1);
    expect(a.closeViews).toHaveBeenCalledTimes(1);
    expect(a.toggleSettings).toHaveBeenCalledTimes(1);
  });

  it("also takes the character where the layout needs Shift for it", () => {
    const a = mount();
    // Spanish: / is Shift+7 and ; is Shift+, .
    expect(press({ key: "/", code: "Digit7", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    press({ key: ";", code: "Comma", ctrlKey: true, shiftKey: true });
    expect(a.toggleShortcuts).toHaveBeenCalledTimes(1);
    expect(a.toggleSidebar).toHaveBeenCalledTimes(1);
    expect(a.toggleSettings).not.toHaveBeenCalled();
  });

  it("keeps the US shortcuts and the Shift ones", () => {
    const a = mount();
    press({ key: "/", code: "Slash", ctrlKey: true });
    press({ key: ";", code: "Semicolon", ctrlKey: true });
    press({ key: "\\", code: "Backslash", ctrlKey: true });
    press({ key: "n", code: "KeyN", ctrlKey: true });
    press({ key: "D", code: "KeyD", ctrlKey: true, shiftKey: true });
    // Shift+/ on a US keyboard is "?": not a shortcut.
    press({ key: "?", code: "Slash", ctrlKey: true, shiftKey: true });
    expect(a.toggleShortcuts).toHaveBeenCalledTimes(1);
    expect(a.toggleSidebar).toHaveBeenCalledTimes(1);
    expect(a.closeViews).toHaveBeenCalledTimes(1);
    expect(a.newChat).toHaveBeenCalledTimes(1);
    expect(a.toggleView).toHaveBeenCalledWith("diff");
  });
});
