// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

describe("shellOwners", () => {
  it("remembers which chat started a shell, across a reload of the page", async () => {
    const first = await import("@/lib/shellOwners");
    first.noteShellOwner("shell-1", "chat-a");
    first.noteShellOwner("shell-2", undefined);
    expect(first.shellOwner("shell-1")).toBe("chat-a");
    expect(first.shellOwner("shell-2")).toBeUndefined();
    vi.resetModules();
    const reloaded = await import("@/lib/shellOwners");
    expect(reloaded.shellOwner("shell-1")).toBe("chat-a");
  });
});
