// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  save: vi.fn(async (..._args: unknown[]): Promise<unknown> => {
    throw new Error("disk full");
  }),
  remove: vi.fn(async (_id: string) => {}),
}));
vi.mock("@/lib/environments", () => ({
  saveEnvironment: (...args: unknown[]) => env.save(...args),
  deleteEnvironment: (id: string) => env.remove(id),
  environmentVariablesText: async () => "API_URL=http://localhost",
  parseEnvText: () => ({ bad: [] }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

const { EnvironmentDialog } = await import("../EnvironmentDialog");
const { setLanguage } = await import("@/lib/i18n");

beforeAll(() => setLanguage("es-ES"));
afterEach(() => {
  cleanup();
  env.save.mockClear();
  env.remove.mockClear();
});

const saved = { id: "e1", name: "Mi entorno", folder: "E:/repo", worktree: false };

async function open(onClose = vi.fn(), onSaved = vi.fn()) {
  render(<EnvironmentDialog env={saved as never} defaultFolder={null} onClose={onClose} onSaved={onSaved} />);
  await act(async () => {});
  return { onClose, onSaved };
}

describe("EnvironmentDialog", () => {
  it("says why the environment couldn't be saved, under the fields, and lets the user try again", async () => {
    const { onClose, onSaved } = await open();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    });
    expect(screen.getByText("No se pudo guardar: disk full")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Guardar" }) as HTMLButtonElement).disabled).toBe(false);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("asks before deleting an environment and its variables", async () => {
    const { onClose } = await open();
    const ask = async () => {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Borrar entorno" }));
      });
      const confirm = within(screen.getByRole("alertdialog"));
      expect(confirm.getByText("¿Eliminar «Mi entorno» y sus variables?")).toBeTruthy();
      return confirm;
    };
    let confirm = await ask();
    await act(async () => {
      fireEvent.click(confirm.getByRole("button", { name: "Cancelar" }));
    });
    expect(env.remove).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    confirm = await ask();
    await act(async () => {
      fireEvent.click(confirm.getByRole("button", { name: "Eliminar" }));
    });
    expect(env.remove).toHaveBeenCalledWith("e1");
    expect(onClose).toHaveBeenCalled();
  });
});
