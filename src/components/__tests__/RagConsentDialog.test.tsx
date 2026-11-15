// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  semanticSearch: true,
  consent: undefined as "granted" | "declined" | undefined,
  saved: [] as [string, string][],
}));

vi.mock("@/lib/useSettings", () => ({
  useSettings: () => ({ perSource: { user: { privacy: { semanticSearch: fake.semanticSearch } } } }),
}));
vi.mock("@/lib/globalConfig", () => ({
  getRagConsent: async () => fake.consent,
  setRagConsent: async (ws: string, c: string) => {
    fake.saved.push([ws, c]);
  },
}));
vi.mock("@/lib/rag", () => ({ ragConfig: () => ({ provider: "backend" }) }));

import { RagConsentDialog } from "@/components/RagConsentDialog";
import { setLanguage } from "@/lib/i18n";

const WS = "E:/Proyectos/tienda";

beforeAll(() => setLanguage("es-ES"));
beforeEach(() => {
  fake.semanticSearch = true;
  fake.consent = undefined;
  fake.saved = [];
});
afterEach(cleanup);

async function open(onIndex = vi.fn()) {
  render(<RagConsentDialog workspace={WS} onIndex={onIndex} />);
  await act(async () => {});
  return onIndex;
}

describe("the semantic search consent", () => {
  it("asks once for a project with the setting on", async () => {
    await open();
    expect(screen.getByText("¿Indexar este proyecto en el servicio de Nyxs?")).toBeTruthy();
    expect(screen.getByText(WS)).toBeTruthy();
    expect(screen.getByText(/Se saltan los archivos que ignora git/)).toBeTruthy();
  });

  it("remembers «Indexar» and starts indexing", async () => {
    const onIndex = await open();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Indexar" }));
    });
    expect(fake.saved).toEqual([[WS, "granted"]]);
    expect(onIndex).toHaveBeenCalledWith(WS);
    expect(screen.queryByText("¿Indexar este proyecto en el servicio de Nyxs?")).toBeNull();
  });

  it("remembers «Ahora no» and indexes nothing", async () => {
    const onIndex = await open();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ahora no" }));
    });
    expect(fake.saved).toEqual([[WS, "declined"]]);
    expect(onIndex).not.toHaveBeenCalled();
  });

  it("never asks with the setting off", async () => {
    fake.semanticSearch = false;
    await open();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("doesn't ask again once answered", async () => {
    fake.consent = "declined";
    await open();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
