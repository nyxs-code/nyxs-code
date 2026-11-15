// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { chatViewsWorkspace } from "@/lib/useChatViews";
import { sessionWorktreeOn, setSessionWorktreeOn } from "@/lib/sessionWorktree";

describe("session worktrees", () => {
  it("shows a session's own worktree in the panels, and the project otherwise", () => {
    const chats = [
      { id: "a", workspace: "D:\\proj", worktree: { path: "C:\\wt\\proj\\session-a", branch: "Nyxs/a" } },
      { id: "b", workspace: "D:\\proj" },
    ];
    expect(chatViewsWorkspace(chats, "a", "D:\\proj")).toBe("C:\\wt\\proj\\session-a");
    expect(chatViewsWorkspace(chats, "b", "D:\\other")).toBe("D:\\proj");
    expect(chatViewsWorkspace(chats, null, "D:\\other")).toBe("D:\\other");
  });

  it("keeps the composer's Worktree switch off until turned on, and remembers it", () => {
    expect(sessionWorktreeOn()).toBe(false);
    setSessionWorktreeOn(true);
    expect(sessionWorktreeOn()).toBe(true);
    expect(Object.values(localStorage)).toContain("1");
  });
});
