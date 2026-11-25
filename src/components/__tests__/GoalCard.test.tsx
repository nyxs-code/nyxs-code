// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoalCard } from "@/components/goal/GoalCard";
import { newGoal, type ChatGoal } from "@/lib/goal";
import { getTranslations } from "@/lib/i18n";

const t = getTranslations("en-US").goal;
afterEach(cleanup);

const card = (goal: ChatGoal, working = true, handlers = { onEdit: vi.fn(), onClear: vi.fn() }) => (
  <GoalCard chatId="c" goal={goal} working={working} {...handlers} />
);

describe("the goal card", () => {
  it("runs its light and shimmer while the agent works toward the goal", () => {
    const { container } = render(card({ ...newGoal("tests pass"), turns: 3, lastReason: "2 tests fail" }));
    expect(container.querySelector(".goal-card-live")).not.toBeNull();
    const status = screen.getByRole("status");
    expect(status.textContent).toBe(`${t.turnsMany.replace("{count}", "3")} · ${t.lastCheck.replace("{reason}", "2 tests fail")}`);
    expect(status.className).toContain("goal-shimmer");
  });

  it("stays still when paused, and says how to go on", () => {
    const { container } = render(card({ ...newGoal("x"), status: "paused", pausedBy: "user", turns: 2 }));
    expect(container.querySelector(".goal-card-live")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(t.pausedByUser);
  });

  it("turns green and sends sparks when the goal is met on screen", () => {
    const goal = { ...newGoal("x"), turns: 3 };
    const { container, rerender } = render(card(goal));
    expect(container.querySelectorAll(".goal-spark")).toHaveLength(0);
    rerender(card({ ...goal, status: "met", turns: 4, metAt: 1 }));
    expect(container.querySelector(".goal-card")?.className).toContain("bg-success");
    expect(container.querySelectorAll(".goal-spark")).toHaveLength(8);
    expect(screen.getByRole("status").textContent).toBe(t.achievedMany.replace("{count}", "4"));
    expect(screen.queryByRole("button", { name: t.edit })).toBeNull();
  });

  it("doesn't throw sparks for a goal already met when it shows up", () => {
    const { container } = render(card({ ...newGoal("x"), status: "met", turns: 1, metAt: 1 }, false));
    expect(container.querySelectorAll(".goal-spark")).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe(t.achievedOne);
  });

  it("edits and clears", () => {
    const handlers = { onEdit: vi.fn(), onClear: vi.fn() };
    render(card(newGoal("x"), false, handlers));
    fireEvent.click(screen.getByRole("button", { name: t.edit }));
    fireEvent.click(screen.getByRole("button", { name: t.clear }));
    expect(handlers.onEdit).toHaveBeenCalled();
    expect(handlers.onClear).toHaveBeenCalled();
  });
});
