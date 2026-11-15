import { afterEach, describe, expect, it, vi } from "vitest";
import { leaveViewGuarded, setViewCloseGuard, toggleViewGuarded } from "@/lib/viewCloseGuard";

afterEach(() => setViewCloseGuard("files", null));

describe("leaving a view through its guard", () => {
  it("goes on at once without a guard, and says whether the user let it go", async () => {
    await expect(leaveViewGuarded("files")).resolves.toBe(true);
    setViewCloseGuard("files", (_close, cancel) => cancel?.());
    await expect(leaveViewGuarded("files")).resolves.toBe(false);
    setViewCloseGuard("files", (close) => close());
    await expect(leaveViewGuarded("files")).resolves.toBe(true);
  });

  it("asks only when the toggle closes the view", () => {
    const guard = vi.fn();
    setViewCloseGuard("files", guard);
    const toggle = vi.fn();
    toggleViewGuarded("files", false, toggle);
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(guard).not.toHaveBeenCalled();
    toggleViewGuarded("files", true, toggle);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveBeenCalledTimes(1);
  });
});
