import { describe, expect, it } from "vitest";
import { describeTrigger, fromCron, toCron, type Trigger } from "../scheduleTriggers";
import { computeNextRun, dueTasks, type ScheduledTask } from "../scheduledTasks";

const words = {
  hourly: "Every hour at minute {minute}",
  daily: "Daily at {time}",
  weekdays: "Weekdays at {time}",
  weekly: "Every {day} at {time}",
  monthly: "Day {day} of every month at {time}",
  custom: "Cron {cron}",
};
const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

describe("a scheduled task's trigger", () => {
  it("reads back every choice of the form as the same choice", () => {
    for (const cron of ["5 * * * *", "47 7 * * *", "18 7 * * 1-5", "16 15 * * 1", "0 9 1 * *"]) {
      expect(toCron(fromCron(cron))).toBe(cron);
    }
  });

  it("keeps what the form can't show as a custom expression", () => {
    const t = fromCron("*/15 9-17 * * 1-5");
    expect(t.frequency).toBe("custom");
    expect(toCron(t)).toBe("*/15 9-17 * * 1-5");
  });

  it("reads Sunday written as 7 as Sunday", () => {
    expect(fromCron("0 10 * * 7")).toMatchObject({ frequency: "weekly", weekday: 0 });
  });

  it("describes each kind of schedule as Claude's lines do", () => {
    const line = (cron: string) => describeTrigger(fromCron(cron), words, days);
    expect(line("18 7 * * 1-5")).toBe("Weekdays at 7:18");
    expect(line("47 7 * * *")).toBe("Daily at 7:47");
    expect(line("16 15 * * 1")).toBe("Every Monday at 15:16");
    expect(line("5 * * * *")).toBe("Every hour at minute 05");
    expect(line("0 9 1 * *")).toBe("Day 1 of every month at 9:00");
  });

  it("turns a monthly trigger into its cron", () => {
    const t: Trigger = { frequency: "monthly", hour: 8, minute: 30, weekday: 1, monthDay: 15, cron: "" };
    expect(toCron(t)).toBe("30 8 15 * *");
  });
});

describe("a task with several schedules", () => {
  const task: ScheduledTask = {
    id: "task_1",
    name: "Both",
    prompt: "p",
    cron: "0 9 * * *",
    extraCrons: ["30 18 * * *"],
    enabled: true,
    createdAt: 0,
  };

  it("runs at any of them", () => {
    expect(dueTasks([task], new Date(2026, 10, 24, 9, 0))).toHaveLength(1);
    expect(dueTasks([task], new Date(2026, 10, 24, 18, 30))).toHaveLength(1);
    expect(dueTasks([task], new Date(2026, 10, 24, 12, 0))).toHaveLength(0);
  });

  it("comes next at the soonest one", () => {
    const next = computeNextRun(task, new Date(2026, 10, 24, 10, 0));
    expect(new Date(next!).getHours()).toBe(18);
  });
});
