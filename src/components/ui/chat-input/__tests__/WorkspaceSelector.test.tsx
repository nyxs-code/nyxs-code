// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const env = { id: "e1", name: "API", folder: "C:/work/api", worktree: false };
let environments = [env];
const applyEnvironment = vi.fn();
vi.mock("@/lib/environments", () => ({
  applyEnvironment: (...args: unknown[]) => applyEnvironment(...args),
  savedEnvironments: () => environments,
  setPendingEnvironment: vi.fn(),
  usePendingEnvironment: () => null,
  useSavedEnvironments: () => environments,
}));
vi.mock("../EnvironmentDialog", () => ({ EnvironmentDialog: () => <div>new environment dialog</div> }));

const { WorkspaceSelector } = await import("../WorkspaceSelector");

function mount() {
  render(<WorkspaceSelector workspace="C:/work/api" recentWorkspaces={[]} />);
}

/** A key pressed in the composer, as Chromium on Windows reports it. */
function press(init: KeyboardEventInit) {
  const box = document.createElement("textarea");
  document.body.appendChild(box);
  box.focus();
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => { box.dispatchEvent(e); });
  box.remove();
  return e;
}

/** Ctrl+Alt+digit; AltGr arrives the same way on Windows, with the character it types. */
const ctrlAlt = (digit: number, key = String(digit), altGraph = false): KeyboardEventInit =>
  ({ key, code: `Digit${digit}`, ctrlKey: true, altKey: true, modifierAltGraph: altGraph }) as KeyboardEventInit;

afterEach(() => {
  cleanup();
  applyEnvironment.mockClear();
  environments = [env];
});

describe("WorkspaceSelector shortcuts", () => {
  it("lets AltGr type @, # and | in a new session", () => {
    mount();
    // Spanish layout: | is AltGr+1, @ AltGr+2, # AltGr+3; with or without the AltGraph flag.
    for (const [digit, char] of [[1, "|"], [2, "@"], [3, "#"]] as const) {
      expect(press(ctrlAlt(digit, char, true)).defaultPrevented, char).toBe(false);
      expect(press(ctrlAlt(digit, char)).defaultPrevented, char).toBe(false);
    }
    // AltGr on a key that types nothing on this layout still isn't the shortcut.
    expect(press(ctrlAlt(1, "1", true)).defaultPrevented).toBe(false);
    expect(press(ctrlAlt(0, "0", true)).defaultPrevented).toBe(false);
    expect(applyEnvironment).not.toHaveBeenCalled();
    expect(screen.queryByText("new environment dialog")).toBeNull();
  });

  it("only takes a digit that has an environment", () => {
    mount();
    expect(press(ctrlAlt(2)).defaultPrevented).toBe(false);
    expect(applyEnvironment).not.toHaveBeenCalled();
    const e = press(ctrlAlt(1));
    expect(e.defaultPrevented).toBe(true);
    expect(applyEnvironment).toHaveBeenCalledWith(env, expect.any(Function));
  });

  it("opens New environment with Ctrl+Alt+0", () => {
    mount();
    expect(press(ctrlAlt(0)).defaultPrevented).toBe(true);
    expect(screen.getByText("new environment dialog")).toBeTruthy();
  });

  it("keeps Cmd+Option on macOS", () => {
    mount();
    const e = press({ key: "¡", code: "Digit1", metaKey: true, altKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(applyEnvironment).toHaveBeenCalledTimes(1);
  });
});
