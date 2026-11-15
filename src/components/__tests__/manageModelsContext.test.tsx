// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Settings } from "@/lib/settings";

vi.mock("@/lib/refreshModels", () => ({ refreshProviderModels: async () => undefined }));

const { ManageModelsModal } = await import("@/components/ManageModelsModal");
const { getLanguage, getTranslations } = await import("@/lib/i18n");

afterEach(cleanup);

const llama = { id: "ollama:llama3", apiModel: "llama3", name: "llama3", description: "", provider: "ollama" as const, contextWindow: 8_192 };
const claude = { id: "anthropic:claude-x", apiModel: "claude-x", name: "Claude X", description: "", provider: "anthropic" as const };

const seen: { settings?: Settings } = {};
function Harness({ initial }: { initial: Settings }) {
  const [settings, setSettings] = useState(initial);
  useEffect(() => {
    seen.settings = settings;
  }, [settings]);
  return <ManageModelsModal open settings={settings} onChange={setSettings} onClose={() => {}} />;
}

const { PROVIDERS } = await import("@/lib/models");
const base = (): Settings => ({
  ...(Object.fromEntries(Object.keys(PROVIDERS).map((id) => [id, { apiKey: "" }])) as unknown as Settings),
  ollama: { apiKey: "local", models: [llama], enabled: [llama.id] },
  anthropic: { apiKey: "sk", models: [claude], enabled: [] },
});

const label = () => getTranslations(getLanguage()).models.contextWindowField;

describe("the context window in Manage models", () => {
  it("lets a local or custom provider's model set its window, with the detected one as a hint", () => {
    render(<Harness initial={base()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Ollama" }));
    const field = screen.getByLabelText(label()) as HTMLInputElement;
    expect(field.placeholder).toBe("8192");

    fireEvent.change(field, { target: { value: "32768" } });
    expect(seen.settings?.ollama.contextWindows).toEqual({ [llama.id]: 32_768 });

    fireEvent.change(field, { target: { value: "" } });
    expect(seen.settings?.ollama.contextWindows).toEqual({});
  });

  it("doesn't offer it for a provider that reports its own models' windows", () => {
    render(<Harness initial={base()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Anthropic" }));
    expect(screen.queryByLabelText(label())).toBeNull();
  });
});
