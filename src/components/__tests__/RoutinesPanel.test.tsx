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
const es = getTranslations("es-ES").routinesPanel;

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

beforeAll(() => setLanguage("es-ES"));
beforeEach(() => {
  fake.data = { teams: [], tasks: [task] };
  fake.saved = [];
});
afterEach(cleanup);

describe("RoutinesPanel", () => {
  it("speaks the app's language", async () => {
    expect(es.title).not.toBe(getTranslations("en-US").routinesPanel.title);
    await mount();
    expect(screen.getByText(es.title)).toBeTruthy();
    expect(screen.getByText(es.subtitle)).toBeTruthy();
    expect(screen.getByRole("button", { name: es.add })).toBeTruthy();
    expect(document.querySelector(`[data-tooltip="${es.runNow}"]`)).toBeTruthy();
    expect(document.querySelector(`[data-tooltip="${es.delete}"]`)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: es.add }));
    });
    expect(screen.getByText(es.name)).toBeTruthy();
    expect(screen.getByPlaceholderText(es.promptPlaceholder)).toBeTruthy();
    expect(screen.getByText(es.cronHelp)).toBeTruthy();
  });

  it("edits a routine in the same form and saves it in place", async () => {
    const other: ScheduledTask = { ...task, id: "task-2", name: "Otra" };
    fake.data = { teams: [], tasks: [task, other] };
    await mount();
    const edit = document.querySelector<HTMLButtonElement>(`[data-tooltip="${es.edit}"]`);
    expect(edit).toBeTruthy();
    await act(async () => {
      fireEvent.click(edit!);
    });
    const name = screen.getByDisplayValue(task.name);
    expect(screen.getByDisplayValue(task.prompt)).toBeTruthy();
    expect(screen.getByDisplayValue(task.cron)).toBeTruthy();
    await act(async () => {
      fireEvent.change(name, { target: { value: "Revisar dependencias cada lunes" } });
      fireEvent.change(screen.getByDisplayValue(task.cron), { target: { value: "0 9 * * 1" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: es.save }));
    });
    const saved = fake.saved.at(-1)!.tasks;
    expect(saved.map((t) => t.id)).toEqual(["task-1", "task-2"]);
    expect(saved[0]).toMatchObject({ id: "task-1", name: "Revisar dependencias cada lunes", cron: "0 9 * * 1", prompt: task.prompt, createdAt: 1 });
    expect(saved[0].nextRunAt).toBeGreaterThan(0);
    expect(saved[1]).toEqual(other);
    // The form closes and the list shows the new name.
    expect(screen.queryByDisplayValue("Revisar dependencias cada lunes")).toBeNull();
    expect(screen.getByText("Revisar dependencias cada lunes")).toBeTruthy();
  });
});
