// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RoutinesData, ScheduledTask } from "@/lib/scheduledTasks";

const fake = vi.hoisted(() => ({
  data: { teams: [], tasks: [] } as RoutinesData,
  saved: [] as RoutinesData[],
}));

vi.mock("@/lib/scheduledTasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/scheduledTasks")>()),
  loadRoutines: async () => fake.data,
  saveRoutines: async (d: RoutinesData) => {
    fake.saved.push(d);
  },
}));

const { RoutinesPanel } = await import("../RoutinesPanel");
const { getTranslations, setLanguage } = await import("@/lib/i18n");
const es = getTranslations("es-ES").scheduled;

const task: ScheduledTask = {
  id: "task-1",
  name: "Revisar dependencias",
  prompt: "Mira si hay versiones nuevas",
  cron: "0 9 * * 1-5",
  enabled: true,
  createdAt: 1,
};

const mount = () => act(async () => {
  render(<RoutinesPanel />);
});

const click = (el: Element) => act(async () => {
  fireEvent.click(el);
});

beforeAll(() => setLanguage("es-ES"));
beforeEach(() => {
  fake.data = { teams: [], tasks: [task] };
  fake.saved = [];
});
afterEach(cleanup);

describe("RoutinesPanel", () => {
  it("speaks the app's language and says when each task runs", async () => {
    expect(es.title).not.toBe(getTranslations("en-US").scheduled.title);
    await mount();
    expect(screen.getByText(es.title)).toBeTruthy();
    expect(screen.getByRole("tab", { name: es.yours })).toBeTruthy();
    expect(screen.getByRole("tab", { name: es.templates })).toBeTruthy();
    expect(screen.getByRole("button", { name: es.newTask })).toBeTruthy();
    expect(screen.getByText(es.descWeekdays.replace("{time}", "9:00"))).toBeTruthy();
  });

  it("shows the templates under the empty state", async () => {
    fake.data = { teams: [], tasks: [] };
    await mount();
    expect(screen.getByText(es.empty)).toBeTruthy();
    expect(screen.getByText(es.tplBriefName)).toBeTruthy();
    expect(screen.getByText(es.tplFlakyName)).toBeTruthy();
  });

  it("creates a task from a template, filled in", async () => {
    fake.data = { teams: [], tasks: [] };
    await mount();
    await click(screen.getByText(es.tplPrsName));
    expect(screen.getByDisplayValue(es.tplPrsName)).toBeTruthy();
    expect(screen.getByDisplayValue(es.tplPrsPrompt)).toBeTruthy();
    await click(screen.getByRole("button", { name: es.create }));
    const saved = fake.saved.at(-1)!.tasks;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: es.tplPrsName, prompt: es.tplPrsPrompt, cron: "49 7 * * 1-5", template: "prs", enabled: true });
    expect(saved[0].nextRunAt).toBeGreaterThan(0);
  });

  it("edits a task in the same dialog and saves it in place", async () => {
    const other: ScheduledTask = { ...task, id: "task-2", name: "Otra" };
    fake.data = { teams: [], tasks: [task, other] };
    await mount();
    await click(screen.getByText(task.name));
    const name = screen.getByDisplayValue(task.name);
    expect(screen.getByDisplayValue(task.prompt)).toBeTruthy();
    await act(async () => {
      fireEvent.change(name, { target: { value: "Revisar dependencias cada lunes" } });
    });
    // Weekdays → Weekly keeps the time and picks Monday.
    await click(screen.getByRole("button", { name: es.trigger }));
    await click(screen.getByRole("menuitemradio", { name: es.freqWeekly }));
    await click(screen.getByRole("button", { name: es.save }));
    const saved = fake.saved.at(-1)!.tasks;
    expect(saved.map((t) => t.id)).toEqual(["task-1", "task-2"]);
    expect(saved[0]).toMatchObject({ id: "task-1", name: "Revisar dependencias cada lunes", cron: "0 9 * * 1", prompt: task.prompt, createdAt: 1 });
    expect(saved[0].nextRunAt).toBeGreaterThan(0);
    expect(saved[1]).toEqual(other);
    expect(screen.queryByDisplayValue("Revisar dependencias cada lunes")).toBeNull();
    expect(screen.getByText("Revisar dependencias cada lunes")).toBeTruthy();
  });
});
