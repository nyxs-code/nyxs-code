// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CleanupItem } from "@/lib/worktreeCleanup";

const removed = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/worktreeCleanup", async (orig) => ({
  ...(await orig<typeof import("@/lib/worktreeCleanup")>()),
  removeWorktrees: async (items: CleanupItem[], onProgress?: (n: number) => void) => {
    items.forEach((i, n) => {
      removed.push(i.sessionId);
      onProgress?.(n + 1);
    });
    return { removed: items.map((i) => i.sessionId), failed: [] };
  },
}));

const { WorktreeCleanupDialog } = await import("../worktrees/WorktreeCleanupDialog");
const { getTranslations } = await import("@/lib/i18n");
const t = getTranslations("en-US").worktreeCleanup;

const DAY = 24 * 60 * 60 * 1000;
const item = (id: string, daysIdle: number, uncommitted: number | null): CleanupItem => ({
  sessionId: id,
  title: `Session ${id}`,
  workspace: "D:/shop",
  path: `W/${id}`,
  branch: `Nyxs/${id}`,
  lastUsed: Date.now() - daysIdle * DAY,
  bytes: 1024 * 1024,
  uncommitted,
});

afterEach(() => {
  cleanup();
  removed.length = 0;
});

async function show(items: CleanupItem[], onRemoved = vi.fn()) {
  render(<WorktreeCleanupDialog open onClose={() => {}} data={{ items, inUse: 1 }} failed={false} onRemoved={onRemoved} />);
  await act(async () => {});
  return onRemoved;
}

const box = (id: string) => screen.getByRole("checkbox", { name: t.selectFor.replace("{name}", `Session ${id}`) }) as HTMLInputElement;

describe("removing unused worktrees", () => {
  it("comes with the clean ones checked and removes them", async () => {
    const onRemoved = await show([item("a", 30, 0), item("b", 20, 3), item("c", 2, 0)]);
    // 7+ days by default: the one used two days ago isn't listed.
    expect(screen.queryByText("Session c")).toBeNull();
    expect(box("a").checked).toBe(true);
    expect(box("b").checked).toBe(false);
    expect(screen.getByText(t.inUseNote.replace("{count}", "1"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t.removeOne }));
    await act(async () => {});
    expect(removed).toEqual(["a"]);
    expect(onRemoved).toHaveBeenCalled();
    expect(screen.getByText(t.removedOne)).toBeTruthy();
  });

  it("asks the user to say they understand before losing uncommitted changes", async () => {
    await show([item("a", 30, 0), item("b", 20, 3)]);
    fireEvent.click(box("b"));
    const removeTwo = screen.getByRole("button", { name: t.removeMany.replace("{count}", "2") }) as HTMLButtonElement;
    expect(removeTwo.disabled).toBe(true);
    expect(screen.getByText(t.lossSome.replace("{lost}", "1"))).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: t.confirmLoss }));
    expect(removeTwo.disabled).toBe(false);
    fireEvent.click(removeTwo);
    await act(async () => {});
    expect(removed).toEqual(["a", "b"]);
  });
});
