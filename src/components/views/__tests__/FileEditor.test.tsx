// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  autoSave: true,
  mtime: 1,
  /** Holds each write until the test lets it finish. */
  hold: false,
  waiting: [] as (() => void)[],
}));

const invoke = vi.hoisted(() =>
  vi.fn(async (cmd: string, _args?: Record<string, unknown>) => {
    if (cmd === "agent_write_file") {
      if (fake.hold) await new Promise<void>((r) => fake.waiting.push(r));
      fake.mtime += 1;
      return "OK";
    }
    if (cmd === "agent_file_mtime") return fake.mtime;
    return null;
  }),
);

vi.mock("@/lib/ipc", () => ({ invoke }));
vi.mock("@/lib/i18n", () => ({
  useTranslations: () => ({ fileEditor: { conflict: "Changed on disk", unsaved: "Unsaved", discard: "Discard", overwrite: "Overwrite", cancel: "Cancel", save: "Save" } }),
  localizedError: (e: unknown) => String(e),
}));
vi.mock("@/lib/featureSettings", () => ({ autoSaveFiles: () => fake.autoSave }));
vi.mock("@/lib/fileActivity", () => ({ fileActivity: { wrote: () => {} } }));

import { FileEditor } from "../FileEditor";

const writes = () => invoke.mock.calls.filter(([cmd]) => cmd === "agent_write_file").map(([, args]) => args);

const open = () => render(<FileEditor path="/ws/a.txt" diskText="hola" diskMtime={1} readOnly={false} />);
const type = (text: string) => fireEvent.change(screen.getByLabelText("/ws/a.txt"), { target: { value: text } });

beforeEach(() => {
  invoke.mockClear();
  Object.assign(fake, { autoSave: true, mtime: 1, hold: false, waiting: [] });
});

afterEach(cleanup);

describe("FileEditor", () => {
  it("saves what was typed last when the file is closed before the auto save", async () => {
    const { unmount } = open();
    type("hola mundo");
    unmount();
    await vi.waitFor(() => expect(writes()).toEqual([{ path: "/ws/a.txt", content: "hola mundo", expectedMtime: 1 }]));
  });

  it("leaves the file alone on close with auto save off, with nothing typed, or over a conflict", async () => {
    fake.autoSave = false;
    const off = open();
    type("hola mundo");
    off.unmount();
    fake.autoSave = true;
    open().unmount();
    const conflict = render(<FileEditor path="/ws/a.txt" diskText="hola" diskMtime={1} readOnly={false} />);
    type("mío");
    // The agent changed the file meanwhile: the user has to choose, not the close.
    conflict.rerender(<FileEditor path="/ws/a.txt" diskText="del agente" diskMtime={5} readOnly={false} />);
    expect(screen.getByText("Changed on disk")).toBeTruthy();
    conflict.unmount();
    await act(async () => {});
    expect(writes()).toEqual([]);
  });

  it("runs a save made while another is on its way after it, against the file it left", async () => {
    fake.hold = true;
    const { unmount } = open();
    type("uno");
    fireEvent.keyDown(screen.getByLabelText("/ws/a.txt"), { key: "s", ctrlKey: true });
    await vi.waitFor(() => expect(fake.waiting).toHaveLength(1));
    type("uno dos");
    unmount();
    fake.hold = false;
    fake.waiting[0]();
    await vi.waitFor(() => expect(writes()).toHaveLength(2));
    // The first save moved the file to mtime 2: the second one must expect that, not a change on disk.
    expect(writes()[1]).toEqual({ path: "/ws/a.txt", content: "uno dos", expectedMtime: 2 });
  });
});
