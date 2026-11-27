// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  user: {} as Record<string, unknown>,
  merged: {} as Record<string, unknown>,
  updates: [] as [Record<string, unknown>, string | undefined][],
}));

vi.mock("@/lib/useSettings", () => ({
  useSettings: () => ({
    settings: fake.merged,
    perSource: { user: fake.user },
    update: async (partial: Record<string, unknown>, source?: string) => {
      fake.updates.push([partial, source]);
      return {};
    },
  }),
}));
vi.mock("@/lib/paths", () => ({ userNyxsDir: async () => "C:/Users/me/.nyxs", userSettingsFile: async () => "" }));
vi.mock("@/lib/ipc", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: async () => null }));
vi.mock("@/lib/globalConfig", () => ({ loadGlobalConfig: async () => ({}) }));

import { PrivacySection } from "@/components/settings/PrivacySection";
import { setLanguage } from "@/lib/i18n";

beforeAll(() => setLanguage("es-ES"));
beforeEach(() => {
  fake.user = {};
  fake.merged = {};
  fake.updates = [];
});
afterEach(cleanup);

const toggle = (name: string) => screen.getByRole("switch", { name });

describe("Settings › Privacy", () => {
  it("lists what goes to the Nyxs service, with the approved defaults", async () => {
    render(<PrivacySection title="Privacidad" />);
    await act(async () => {});
    expect(screen.getByText("Nyxs se ejecuta en tu equipo. Tus chats, código y archivos se guardan en este dispositivo; abajo eliges lo poco que sale de él.")).toBeTruthy();
    expect(screen.queryByText("Lo que pasa por el servicio de Nyxs")).toBeNull();
    expect(screen.getByText("Servicio de Nyxs")).toBeTruthy();
    expect(toggle("Títulos de los chats").getAttribute("aria-checked")).toBe("true");
    expect(toggle("Sugerencias del siguiente mensaje").getAttribute("aria-checked")).toBe("true");
    expect(toggle("Imágenes para modelos que no las ven").getAttribute("aria-checked")).toBe("true");
    expect(toggle("Búsqueda semántica en el servicio de Nyxs").getAttribute("aria-checked")).toBe("false");
    expect(toggle("Datos del equipo").getAttribute("aria-checked")).toBe("true");
    // Dictation and cloud threads: sent only when used.
    expect(screen.getAllByText("Al usarlo")).toHaveLength(2);
    expect(screen.getByText("Hilos en la nube")).toBeTruthy();
    expect(screen.getByText("Siempre")).toBeTruthy();
  });

  it("saves each switch in the user's own settings", async () => {
    render(<PrivacySection title="Privacidad" />);
    await act(async () => {
      fireEvent.click(toggle("Títulos de los chats"));
      fireEvent.click(toggle("Búsqueda semántica en el servicio de Nyxs"));
      fireEvent.click(toggle("Sugerencias del siguiente mensaje"));
    });
    expect(fake.updates).toEqual([
      [{ privacy: { chatTitles: false } }, "user"],
      [{ privacy: { semanticSearch: true } }, "user"],
      [{ promptSuggestions: false }, "user"],
    ]);
  });

  it("shows what the user chose", async () => {
    fake.user = { privacy: { deviceDetails: false, semanticSearch: true } };
    fake.merged = { promptSuggestions: false };
    render(<PrivacySection title="Privacidad" />);
    expect(toggle("Datos del equipo").getAttribute("aria-checked")).toBe("false");
    expect(toggle("Búsqueda semántica en el servicio de Nyxs").getAttribute("aria-checked")).toBe("true");
    expect(toggle("Sugerencias del siguiente mensaje").getAttribute("aria-checked")).toBe("false");
  });
});
