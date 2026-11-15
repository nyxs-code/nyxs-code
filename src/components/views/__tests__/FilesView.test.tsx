// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  autoSave: false,
  files: {} as Record<string, { text: string; encoding: string | null }>,
  /** What the next write answers: nothing (it lands) or an error. */
  writeError: null as string | null,
}));

const invoke = vi.hoisted(() =>
  vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    const path = String(args.path ?? "");
    switch (cmd) {
      case "agent_list_dir":
        return Object.keys(fake.files).map((p) => p.slice("/ws/".length));
      case "agent_read_text": {
        const f = fake.files[path];
        if (!f) return null;
        return args.withEncoding ? f : f.text;
      }
      case "agent_file_mtime":
        return 1;
      case "agent_write_file":
        if (fake.writeError) throw new Error(fake.writeError);
        fake.files[path] = { text: String(args.content), encoding: null };
        return "OK";
      default:
        return null;
    }
  }),
);

const texts: Record<string, Record<string, string>> = {
  fileEditor: {
    viewOnly: "solo lectura",
    unsaved: "Cambios sin guardar",
    save: "Guardar",
    cancel: "Cancelar",
    conflict: "Este archivo cambió en disco mientras lo editabas.",
    discard: "Descartar mis cambios",
    leaveTitle: "Tienes cambios sin guardar en {name}",
    leaveBody: "Si sigues sin guardarlos, se perderán.",
    leaveDiscard: "Descartar",
  },
  views: { close: "Cerrar" },
};

vi.mock("@/lib/ipc", () => ({ invoke }));
vi.mock("@/lib/i18n", () => ({
  // Any text a test doesn't name shows as its key.
  useTranslations: () =>
    new Proxy({}, { get: (_, section: string) => new Proxy({}, { get: (_, key: string) => texts[section]?.[key] ?? key }) }),
  localizedError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("@/lib/featureSettings", () => ({ autoSaveFiles: () => fake.autoSave }));
vi.mock("@/lib/fileActivity", () => ({ fileActivity: { wrote: () => {} } }));
vi.mock("@/lib/fsWatch", () => ({ subscribeFsChange: () => () => {} }));
vi.mock("@/lib/filePaths", () => ({ OPEN_FILE_EVENT: "nyxs:open-file", takePendingFile: () => null }));
vi.mock("../../video/EditInVideoMenu", () => ({ EditInVideoMenu: () => null }));
vi.mock("../../video/editVideoFile", () => ({ requestEditVideoFile: () => {}, VIDEO_FILE_RE: /\.mp4$/ }));

import { FilesView } from "../FilesView";
import { closeViewGuarded, leaveViewGuarded } from "@/lib/viewCloseGuard";

const settle = () => act(async () => {});
/** A button of the open dialog, not the editor bar's of the same name. */
const inDialog = (name: string) => within(screen.getByRole("alertdialog")).getByRole("button", { name });
const writes = () => invoke.mock.calls.filter(([cmd]) => cmd === "agent_write_file");
const editor = () => document.querySelector("textarea") as HTMLTextAreaElement;

async function openFile(name: string) {
  fireEvent.click(await screen.findByRole("button", { name }));
  await settle();
}

async function openWithEdit() {
  render(<FilesView workspace="/ws" />);
  await openFile("a.txt");
  fireEvent.change(editor(), { target: { value: "hola mundo" } });
}

beforeEach(() => {
  invoke.mockClear();
  fake.autoSave = false;
  fake.writeError = null;
  fake.files = { "/ws/a.txt": { text: "hola", encoding: null }, "/ws/b.txt": { text: "adiós", encoding: null } };
});

afterEach(cleanup);

describe("a file it can't save as it is", () => {
  it("opens read-only, naming its encoding beside the file", async () => {
    fake.files["/ws/wide.txt"] = { text: "hola", encoding: "UTF-16 LE" };
    render(<FilesView workspace="/ws" />);
    await openFile("wide.txt");
    expect(screen.getByText("· solo lectura · UTF-16 LE")).toBeTruthy();
    expect(editor().readOnly).toBe(true);
    // Tab doesn't sneak a change into it either.
    fireEvent.keyDown(editor(), { key: "Tab" });
    expect(screen.queryByText("Cambios sin guardar")).toBeNull();
    await openFile("a.txt");
    expect(screen.queryByText(/solo lectura/)).toBeNull();
    expect(editor().readOnly).toBe(false);
  });
});

describe("leaving a file with unsaved changes and auto save off", () => {
  it("asks first, and Cancel keeps the file and its changes", async () => {
    await openWithEdit();
    await openFile("b.txt");
    const dialog = screen.getByRole("alertdialog", { name: "Tienes cambios sin guardar en a.txt" });
    expect(dialog.textContent).toContain("Si sigues sin guardarlos, se perderán.");
    expect([...dialog.querySelectorAll("footer button")].map((b) => b.textContent)).toEqual(["Descartar", "Cancelar", "Guardar"]);
    fireEvent.click(inDialog("Cancelar"));
    await settle();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(editor().value).toBe("hola mundo");
    expect(writes()).toEqual([]);
  });

  it("Discard opens the other file without saving", async () => {
    await openWithEdit();
    await openFile("b.txt");
    fireEvent.click(inDialog("Descartar"));
    await settle();
    expect(editor().value).toBe("adiós");
    expect(writes()).toEqual([]);
  });

  it("Save saves, then closes the file", async () => {
    await openWithEdit();
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    await settle();
    fireEvent.click(inDialog("Guardar"));
    await settle();
    expect(fake.files["/ws/a.txt"].text).toBe("hola mundo");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("stays on the file when the save fails", async () => {
    await openWithEdit();
    fake.writeError = "/ws/a.txt changed on disk since your last read";
    await openFile("b.txt");
    fireEvent.click(inDialog("Guardar"));
    await settle();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(editor().value).toBe("hola mundo");
    expect(screen.getByText("Este archivo cambió en disco mientras lo editabas.")).toBeTruthy();
  });

  it("asks before the Files panel closes", async () => {
    await openWithEdit();
    const close = vi.fn();
    act(() => closeViewGuarded("files", close));
    await settle();
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(inDialog("Descartar"));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("tells a folder change that the user kept the file, or let it go", async () => {
    await openWithEdit();
    let left: Promise<boolean> = Promise.resolve(true);
    act(() => {
      left = leaveViewGuarded("files");
    });
    await settle();
    fireEvent.click(inDialog("Cancelar"));
    await expect(left).resolves.toBe(false);
    expect(editor().value).toBe("hola mundo");
    act(() => {
      left = leaveViewGuarded("files");
    });
    await settle();
    fireEvent.click(inDialog("Descartar"));
    await expect(left).resolves.toBe(true);
  });

  it("doesn't ask with auto save on, or with nothing changed", async () => {
    render(<FilesView workspace="/ws" />);
    await openFile("a.txt");
    await openFile("b.txt");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const close = vi.fn();
    closeViewGuarded("files", close);
    expect(close).toHaveBeenCalledTimes(1);
    fake.autoSave = true;
    fireEvent.change(editor(), { target: { value: "cambio" } });
    await openFile("a.txt");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    // The close saved it, as the auto save would have.
    await vi.waitFor(() => expect(fake.files["/ws/b.txt"].text).toBe("cambio"));
  });
});
