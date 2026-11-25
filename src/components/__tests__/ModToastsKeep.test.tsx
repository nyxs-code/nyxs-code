// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const dismissToast = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mods/io", () => ({
  modHost: {
    dismissToast,
    subscribe: () => () => {},
    getVersion: () => 1,
    toasts: [{ id: "t1", text: "Saved the theme", timeoutMs: 2000 }],
  },
}));

const { ModToasts } = await import("@/components/mods/ModToasts");
const { APPEARANCE_KEY, setAppearance } = await import("@/lib/appearance");

afterEach(() => {
  cleanup();
  localStorage.removeItem(APPEARANCE_KEY);
  dismissToast.mockClear();
  vi.useRealTimers();
});

describe("mod popups", () => {
  it("go after their time by default", () => {
    vi.useFakeTimers();
    render(<ModToasts />);
    act(() => void vi.advanceTimersByTime(2500));
    expect(dismissToast).toHaveBeenCalledWith("t1");
  });

  it("stay until closed with Keep popups on screen", () => {
    setAppearance({ keepPopups: true });
    vi.useFakeTimers();
    render(<ModToasts />);
    act(() => void vi.advanceTimersByTime(120_000));
    expect(dismissToast).not.toHaveBeenCalled();
  });
});
