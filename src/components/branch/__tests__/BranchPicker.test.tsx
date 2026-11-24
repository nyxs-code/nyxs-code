// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const worktree = { on: false };
const listeners = new Set<() => void>();
vi.mock("@/lib/sessionWorktree", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useSessionWorktreeOn: () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => worktree.on),
    setSessionWorktreeOn: (v: boolean) => { worktree.on = v; for (const l of listeners) l(); },
  };
});
vi.mock("@/lib/fsWatch", () => ({ subscribeGitChange: () => () => {} }));
const switchFolderBranch = vi.fn();
vi.mock("@/lib/gitBranches", () => ({
  readFolderBranches: async () => ({ current: "main", branches: ["main", "feature"], elsewhere: new Map(), linkedWorktree: false }),
  switchFolderBranch: (...args: unknown[]) => switchFolderBranch(...args),
  workingTreeStatus: async () => ({ files: 3, additions: 10, deletions: 2 }),
  clearWorkingTree: async () => {},
}));

import { WorkspaceSelector } from "@/components/ui/chat-input/WorkspaceSelector";
import { worktreeBaseOf } from "@/lib/worktreeBase";

const WS = "C:/repo/project";

afterEach(cleanup);
beforeEach(() => {
  worktree.on = false;
  switchFolderBranch.mockReset();
});

/** Opens the folder menu, its Branch row, and picks `branch` there. */
async function pickBranch(branch: string) {
  render(<WorkspaceSelector workspace={WS} recentWorkspaces={[WS]} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: /project/ }));
  const row = screen.getByRole("menuitem", { name: /Branch/ });
  expect(row.textContent).toContain(worktree.on ? worktreeBaseOf(WS) ?? "main" : "main");
  fireEvent.click(row);
  fireEvent.click(await screen.findByRole("option", { name: new RegExp(`^${branch}`) }));
  await act(async () => {});
}

describe("the branch in the folder menu of a new session", () => {
  it("with Worktree on, picks where the worktree starts and leaves the folder alone", async () => {
    worktree.on = true;
    await pickBranch("feature");
    expect(switchFolderBranch).not.toHaveBeenCalled();
    expect(worktreeBaseOf(WS)).toBe("feature");
  });

  it("with Worktree off, says why it didn't switch and offers Worktree from that branch", async () => {
    switchFolderBranch.mockResolvedValue({ ok: false, reason: "operation_in_progress" });
    await pickBranch("feature");
    expect(switchFolderBranch).toHaveBeenCalledWith(WS, "feature", { sessionWorking: false });
    expect(screen.getByRole("alert").textContent).toContain("unfinished Git operation");
    fireEvent.click(screen.getByRole("button", { name: "Turn on Worktree" }));
    expect(worktree.on).toBe(true);
    expect(worktreeBaseOf(WS)).toBe("feature");
  });

  it("asks what to do with uncommitted changes, then switches", async () => {
    switchFolderBranch.mockResolvedValueOnce({ ok: false, reason: "uncommitted_changes" }).mockResolvedValueOnce({ ok: true });
    await pickBranch("feature");
    expect(await screen.findByText(/Uncommitted changes on/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stash changes" }));
    await act(async () => {});
    expect(switchFolderBranch).toHaveBeenCalledTimes(2);
  });
});
