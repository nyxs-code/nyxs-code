// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StandingTheme } from "@/lib/mods/types";

const theme = { args: { backdrop: { scene: "snow" } } } as unknown as StandingTheme;
const paint = vi.fn();

vi.mock("@/lib/mods/paint", () => ({ paintModTheme: (t: unknown) => paint(t) }));
vi.mock("@/lib/plugins/bundled", () => ({ installBundledPlugins: () => Promise.resolve() }));
vi.mock("@/lib/mods/io", () => ({
  modHost: {
    activate: () => {},
    reloadInstalled: () => {},
    subscribe: () => () => {},
    getVersion: () => 1,
    theme: () => theme,
    isSettled: () => true,
    commands: () => [],
  },
  setReservedCommands: () => {},
  setSessionInfoSource: () => {},
}));

const { useMods } = await import("@/lib/mods/useMods");

afterEach(() => {
  cleanup();
  paint.mockClear();
});

describe("a session's theme", () => {
  it("dresses the session and leaves the app's own pages in the app's look", () => {
    const { rerender } = renderHook((themed: boolean) => useMods({ activeId: "s1", workspace: null, chats: [], reservedCommands: [], themed }), {
      initialProps: true,
    });
    expect(paint).toHaveBeenLastCalledWith(theme);
    rerender(false);
    expect(paint).toHaveBeenLastCalledWith(null);
    rerender(true);
    expect(paint).toHaveBeenLastCalledWith(theme);
  });
});
