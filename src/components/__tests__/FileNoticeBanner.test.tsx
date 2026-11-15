// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const opened = vi.hoisted(() => [] as string[]);

vi.mock("@/lib/ipc", () => ({
  invoke: vi.fn(async (cmd: string, args: { path?: string } = {}) => {
    if (cmd === "agent_open_path") {
      opened.push(String(args.path));
      return null;
    }
    throw new Error(`unexpected command ${cmd}`);
  }),
}));

import { FileNoticeBanner } from "@/components/FileNoticeBanner";
import { currentFileNotice, dismissFileNotice, showFileNotice } from "@/lib/fileNotices";
import { setLanguage } from "@/lib/i18n";

beforeAll(() => setLanguage("es-ES"));

afterEach(() => {
  cleanup();
  act(() => dismissFileNotice());
  opened.length = 0;
});

describe("FileNoticeBanner", () => {
  it("shows nothing without a notice", () => {
    const { container } = render(<FileNoticeBanner />);
    expect(container.textContent).toBe("");
  });

  it("says a settings file wasn't overwritten, names its copy, and opens its folder", async () => {
    render(<FileNoticeBanner />);
    act(() =>
      showFileNotice({
        kind: "unreadableFile",
        file: "C:/Users/me/.nyxs/settings.json",
        folder: "C:/Users/me/.nyxs",
        backup: "C:/Users/me/.nyxs/settings.json.bak",
      }),
    );
    expect(screen.getByText("No se pudo leer settings.json")).toBeTruthy();
    const body = screen.getByText(/Nyxs no lo sobrescribirá/);
    expect(body.textContent).toBe(
      "Nyxs no lo sobrescribirá. Corrígelo o bórralo y reinicia. Hay una copia en settings.json.bak.",
    );
    expect(body.querySelector("code")?.textContent).toBe("settings.json.bak");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Abrir carpeta" }));
    });
    expect(opened).toEqual(["C:/Users/me/.nyxs"]);
  });

  it("leaves out the copy when there is none", () => {
    render(<FileNoticeBanner />);
    act(() => showFileNotice({ kind: "unreadableFile", file: "E:/repo/.nyxs/settings.local.json", folder: "E:/repo/.nyxs", backup: null }));
    expect(screen.getByText("No se pudo leer settings.local.json")).toBeTruthy();
    expect(screen.getByText(/Nyxs no lo sobrescribirá/).textContent).toBe("Nyxs no lo sobrescribirá. Corrígelo o bórralo y reinicia.");
  });

  it("says a session couldn't be opened, with no folder button when there's no local folder", () => {
    render(<FileNoticeBanner />);
    act(() => showFileNotice({ kind: "unreadableSession", folder: null }));
    expect(screen.getByText("No se pudo abrir la sesión")).toBeTruthy();
    expect(screen.getByText("Su archivo no se pudo leer. Nyxs no lo sobrescribirá; sigue en disco tal como estaba.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Abrir carpeta" })).toBeNull();
  });

  it("says where the damaged chat list went, and the last notice replaces the one before", () => {
    render(<FileNoticeBanner />);
    act(() => showFileNotice({ kind: "unreadableSession", folder: "C:/p" }));
    act(() =>
      showFileNotice({ kind: "chatIndexSetAside", file: "C:/data/chats/index.json.corrupt", folder: "C:/data/chats" }),
    );
    expect(screen.queryByText("No se pudo abrir la sesión")).toBeNull();
    expect(screen.getByText("La lista de chats estaba dañada")).toBeTruthy();
    expect(screen.getByText(/Se apartó a/).textContent).toBe(
      "Se apartó a index.json.corrupt y no se ha borrado nada. Tus sesiones siguen en Recientes.",
    );
  });

  it("closes with the X", () => {
    render(<FileNoticeBanner />);
    act(() => showFileNotice({ kind: "unreadableSession", folder: null }));
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(currentFileNotice()).toBeNull();
    expect(screen.queryByText("No se pudo abrir la sesión")).toBeNull();
  });
});
