// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type SetStateAction } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ProvidersSection } from "@/components/settings/ProvidersSection";
import { loadSettings, type Settings } from "@/lib/settings";
import { getTranslations } from "@/lib/i18n";
import { fetchProviderModelsWithRetry } from "@/lib/providerModels";
import { forgetModelsRead } from "@/lib/modelsFreshness";

// Showing a connected provider refreshes its models: answer with one, without the network.
vi.mock("@/lib/providerModels", () => ({
  fetchProviderModels: vi.fn(async () => []),
  fetchProviderModelsWithRetry: vi.fn(async (provider: { id: string }) => [
    { id: `${provider.id}:gpt-test`, name: "GPT Test", apiModel: "gpt-test-2026-01-01", provider: provider.id },
  ]),
}));

afterEach(cleanup);
// Each test opens Settings on a fresh run: no list read a moment ago by the test before.
beforeEach(() => forgetModelsRead());

const tr = getTranslations("en-US");
const t = tr.settings;

function withKeys(): Settings {
  const s = loadSettings();
  return { ...s, openai: { ...s.openai, apiKey: "sk-test" }, nvidia: { ...s.nvidia, apiKey: "nv-test" } };
}

function Harness({ onChange }: { onChange?: (s: Settings) => void }) {
  const [settings, setSettings] = useState(withKeys);
  return (
    <ProvidersSection
      settings={settings}
      onChange={(action: SetStateAction<Settings>) =>
        setSettings((prev) => {
          const next = typeof action === "function" ? action(prev) : action;
          onChange?.(next);
          return next;
        })
      }
    />
  );
}

/** Lets the models fetched on showing a provider come in. */
const settle = () => act(async () => {});
const detailTitle = () => screen.getByRole("heading", { level: 3 }).textContent;
const listButton = (name: string) => screen.getByRole("option", { name: new RegExp(`^${name}`) });
const listbox = () => screen.getByRole("listbox", { name: t.providers });
const selectedOption = () => within(listbox()).getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true");

describe("ProvidersSection", () => {
  it("opens on the first connected provider, connected ones listed first", async () => {
    render(<Harness />);
    await settle();
    expect(detailTitle()).toBe("OpenAI");
    const connected = screen.getByRole("group", { name: t.connectedProviders });
    expect(within(connected).getAllByRole("option").map((b) => b.textContent)).toEqual(["OpenAI", "NVIDIA"]);
    expect(screen.getByRole("button", { name: t.disconnect })).toBeTruthy();
  });

  it("lists the shown provider's models as switches with the name alone", async () => {
    render(<Harness />);
    await settle();
    const row = screen.getByRole("switch", { name: `${tr.models.enable} GPT Test` });
    expect(row.textContent).toBe("GPT Test");
    expect(screen.queryByText(t.capabilitiesPage.reloadModels)).toBeNull();
    fireEvent.click(row);
    expect(screen.getByRole("switch", { name: `${tr.models.disable} GPT Test` }).getAttribute("aria-checked")).toBe("true");
  });

  it("fetches a provider's models once, not again when going back to it", async () => {
    const fetchModels = vi.mocked(fetchProviderModelsWithRetry);
    fetchModels.mockClear();
    render(<Harness />);
    await settle();
    fireEvent.click(listButton("NVIDIA"));
    await settle();
    fireEvent.click(listButton("OpenAI"));
    await settle();
    expect(fetchModels.mock.calls.map(([provider]) => provider.id)).toEqual(["openai", "nvidia"]);
  });

  it("tries a failed read again the next time the provider is shown, without staying loading", async () => {
    const fetchModels = vi.mocked(fetchProviderModelsWithRetry);
    fetchModels.mockClear();
    fetchModels.mockRejectedValueOnce(new Error("network down"));
    render(<Harness />);
    await settle();
    // The failure shows over the empty list and the read doesn't stay marked as done.
    expect(screen.getByText("network down")).toBeTruthy();
    expect(screen.queryByText(tr.models.loading)).toBeNull();

    fireEvent.click(listButton("NVIDIA"));
    await settle();
    fireEvent.click(listButton("OpenAI"));
    await settle();

    expect(fetchModels.mock.calls.map(([provider]) => provider.id)).toEqual(["openai", "nvidia", "openai"]);
    expect(screen.queryByText(tr.models.loading)).toBeNull();
    expect(screen.getByRole("switch", { name: `${tr.models.enable} GPT Test` })).toBeTruthy();
  });

  it("shows a provider that isn't connected with a way to connect it", async () => {
    render(<Harness />);
    await settle();
    fireEvent.click(listButton("Anthropic"));
    expect(detailTitle()).toBe("Anthropic");
    expect(screen.getByRole("button", { name: t.connect })).toBeTruthy();
    expect(screen.queryByRole("button", { name: t.disconnect })).toBeNull();
  });

  it("filters the list by name", async () => {
    render(<Harness />);
    await settle();
    fireEvent.change(screen.getByRole("textbox", { name: t.searchSettings }), { target: { value: "nvid" } });
    expect(screen.queryByText(t.popularProviders)).toBeNull();
    expect(listButton("NVIDIA")).toBeTruthy();
    expect(screen.queryByRole("option", { name: /^OpenAI/ })).toBeNull();
  });

  it("keeps a disconnected provider open, now to connect it again", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: t.disconnect }));
    expect(onChange.mock.lastCall![0].openai.apiKey).toBe("");
    expect(detailTitle()).toBe("OpenAI");
    expect(screen.getByRole("button", { name: t.connect })).toBeTruthy();
  });

  it("is a listbox with one Tab stop: the provider shown", async () => {
    render(<Harness />);
    await settle();
    const options = within(listbox()).getAllByRole("option");
    expect(options.filter((o) => o.tabIndex === 0).map((o) => o.textContent)).toEqual(["OpenAI"]);
    expect(selectedOption()?.textContent).toBe("OpenAI");
    // The agents' switches in the list are for the mouse; their page has Connect / Disconnect.
    expect(within(listbox()).queryAllByRole("switch")).toEqual([]);
  });

  it("moves the selection with the arrows, Home and End, and shows each provider", async () => {
    render(<Harness />);
    await settle();
    const openai = listButton("OpenAI");
    openai.focus();
    fireEvent.keyDown(openai, { key: "ArrowDown" });
    await settle();
    expect(detailTitle()).toBe("NVIDIA");
    expect(document.activeElement).toBe(listButton("NVIDIA"));
    expect(listButton("NVIDIA").tabIndex).toBe(0);
    expect(listButton("OpenAI").tabIndex).toBe(-1);

    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(detailTitle()).toBe("OpenAI");

    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    const options = within(listbox()).getAllByRole("option");
    expect(document.activeElement).toBe(options[0]);
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(options.at(-1));
    expect(selectedOption()).toBe(options.at(-1));
  });

  it("jumps to the next provider starting with a typed letter", async () => {
    render(<Harness />);
    await settle();
    listButton("OpenAI").focus();
    fireEvent.keyDown(document.activeElement!, { key: "n" });
    expect(detailTitle()).toBe("NVIDIA");
    fireEvent.keyDown(document.activeElement!, { key: "A" });
    expect(detailTitle()?.startsWith("A")).toBe(true);
    // A shortcut with Ctrl isn't typing.
    const before = detailTitle();
    fireEvent.keyDown(document.activeElement!, { key: "o", ctrlKey: true });
    expect(detailTitle()).toBe(before);
  });

  it("hands focus from the search box to the list with ↓", async () => {
    render(<Harness />);
    await settle();
    const search = screen.getByRole("textbox", { name: t.searchSettings });
    fireEvent.change(search, { target: { value: "nvid" } });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    // OpenAI, shown before, is filtered out: the first match takes the focus and is shown.
    expect(document.activeElement).toBe(listButton("NVIDIA"));
    expect(detailTitle()).toBe("NVIDIA");
  });

  it("drops the listbox role when nothing matches the search", async () => {
    render(<Harness />);
    await settle();
    fireEvent.change(screen.getByRole("textbox", { name: t.searchSettings }), { target: { value: "zzzz" } });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByText(t.noResults)).toBeTruthy();
  });
});
