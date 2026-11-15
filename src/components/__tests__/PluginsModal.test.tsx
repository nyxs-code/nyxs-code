// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  enabled: [] as string[],
  values: {} as Record<string, string>,
  setEnabled: vi.fn(async (id: string, on: boolean) => {
    fake.enabled = on ? [...fake.enabled, id] : fake.enabled.filter((x) => x !== id);
  }),
}));

const manifest = { name: "search", version: "1.0.0", userConfig: { apiKey: { type: "string", title: "API key", required: true } } };

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  invoke: async (cmd: string) => (cmd === "nyxs_read_text" ? JSON.stringify(manifest) : undefined),
}));
vi.mock("@/lib/plugins/install", () => ({
  listInstalled: async () => [{ id: "search@mp", plugin: "search", marketplace: "mp", version: "1.0.0", installLocation: "/p/search", installedAt: 1 }],
  uninstallPlugin: async () => {},
  setEnabled: (id: string, on: boolean) => fake.setEnabled(id, on),
}));
vi.mock("@/lib/plugins/pluginSettings", () => ({ getEnabledPlugins: async () => fake.enabled }));
vi.mock("@/lib/plugins/pluginLoader", () => ({ clearPluginLoaderCache: () => {} }));
vi.mock("@/lib/plugins/validate", () => ({ validatePlugin: async () => ({ errors: [], warnings: [] }) }));
vi.mock("@/lib/plugins/userConfig", () => ({
  hasUserConfig: (m: { userConfig?: object }) => !!m.userConfig && Object.keys(m.userConfig).length > 0,
  getPluginConfigForEdit: async () => ({ ...fake.values }),
  validateUserConfig: (_m: unknown, v: Record<string, string>) => (v.apiKey ? [] : ["apiKey"]),
  setPluginConfig: async (_id: string, _m: unknown, v: Record<string, string>) => {
    fake.values = { ...v };
  },
}));

const { PluginsModal } = await import("../PluginsModal");
const { getTranslations, setLanguage } = await import("@/lib/i18n");
const t = getTranslations("en-US").pluginsModal;

beforeAll(() => setLanguage("en-US"));
afterEach(cleanup);

describe("PluginsModal", () => {
  it("turns a plugin on once the settings it asked for when enabled are saved", async () => {
    await act(async () => {
      render(<PluginsModal open onClose={() => {}} />);
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: t.enable }));
    });
    await act(async () => {
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: t.enable }));
    });
    expect(fake.setEnabled).not.toHaveBeenCalled();

    const config = await screen.findByRole("dialog", { name: t.configureTitle.replace("{name}", "search") });
    fireEvent.change(within(config).getByRole("textbox"), { target: { value: "sk-1" } });
    await act(async () => {
      fireEvent.click(within(config).getByRole("button", { name: t.save }));
    });
    expect(fake.setEnabled).toHaveBeenCalledWith("search@mp", true);
    expect(await screen.findByRole("button", { name: t.disable })).toBeTruthy();
  });
});
