// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionMenu, type SessionMenuTarget } from "@/components/sidebar/SessionMenu";
import { getTranslations } from "@/lib/i18n";
import { SKILL_FROM_SESSION_PROMPT } from "@/lib/skillFromSession";

const tm = getTranslations("en-US").sidebarMenu;
afterEach(cleanup);

const target = (over: Partial<SessionMenuTarget> = {}): SessionMenuTarget => ({
  id: "s",
  saved: true,
  isActive: false,
  working: false,
  hasMessages: true,
  workspace: "D:/project",
  worktree: false,
  pinned: false,
  unread: false,
  sectionId: null,
  ...over,
});

function open(t: SessionMenuTarget) {
  const onAction = vi.fn();
  render(<SessionMenu target={t} x={0} y={0} above={0} canSplit={false} canRewind={false} projects={[]} sections={[]} onAction={onAction} onClose={() => {}} />);
  return onAction;
}

describe("Turn into a skill", () => {
  it("asks for a skill from a saved session with messages", () => {
    const onAction = open(target());
    fireEvent.click(screen.getByRole("menuitem", { name: tm.turnIntoSkill }));
    expect(onAction).toHaveBeenCalledWith("skill");
  });

  it("is off for a session with nothing done yet", () => {
    const onAction = open(target({ hasMessages: false }));
    const row = screen.getByRole("menuitem", { name: tm.turnIntoSkill });
    expect(row.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(row);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("tells the agent where the skill goes and how it's run", () => {
    expect(SKILL_FROM_SESSION_PROMPT).toContain(".nyxs/skills/<name>/SKILL.md");
    expect(SKILL_FROM_SESSION_PROMPT).toContain("/<name>");
  });
});
