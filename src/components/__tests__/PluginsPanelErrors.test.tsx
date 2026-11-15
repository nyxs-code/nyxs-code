// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { InstalledPlugin, PluginUpdate } from "@/lib/plugins";
import { LocalizedError } from "@/lib/localizedError";

const installed: InstalledPlugin = {
  id: "p@mp",
  plugin: "p",
  marketplace: "mp",
  version: "0.0.0",
  installLocation: "/home/me/.nyxs/plugins/cache/mp/p/0.0.0",
  installedAt: 1,
};
const update: PluginUpdate = {
  id: "p@mp",
  plugin: "p",
  marketplace: "mp",
  current: "0.0.0",
  latest: "0.0.0",
  kind: "commit",
  latestSha: "b".repeat(40),
};

vi.mock("@/lib/ipc", () => ({ invoke: async () => undefined }));
vi.mock("@/lib/plugins", () => ({
  listMarketplaces: async () => [],
  removeMarketplace: async () => {},
  setAutoUpdate: async () => {},
  describeSource: () => "",
  ensureDefaultMarketplaces: async () => {},
  isBuiltinMarketplace: () => false,
  getCatalog: async () => ({ plugins: [] }),
  refreshAllMarketplaces: async () => ({ refreshed: [], failed: [] }),
  listInstalled: async () => [installed],
  installPlugin: async () => {},
  uninstallPlugin: async () => {},
  isEnabled: async () => true,
  setEnabled: async () => {},
  checkPluginUpdates: async () => [update],
  updatePlugin: async () => {
    throw new LocalizedError(
      "wrongCommit",
      { url: "https://github.com/a/b.git", head: "aaaaaaaaaaaa", sha: "b".repeat(40) },
      "https://github.com/a/b.git is at commit aaaaaaaaaaaa, not the reviewed commit bbbb.",
    );
  },
}));

const { PluginsPanel } = await import("../PluginsPanel");
const { getTranslations, setLanguage } = await import("@/lib/i18n");
const es = getTranslations("es-ES");

beforeAll(() => setLanguage("es-ES"));
afterEach(cleanup);

describe("PluginsPanel errors", () => {
  it("are shown in the app's language", async () => {
    await act(async () => {
      render(<PluginsPanel />);
    });
    await act(async () => {
      const row = screen.getByText("p").closest("li")!;
      fireEvent.click(within(row).getByRole("button", { name: es.pluginsPanel.update }));
    });
    const expected = es.pluginErrors.wrongCommit
      .replace("{url}", "https://github.com/a/b.git")
      .replace("{head}", "aaaaaaaaaaaa")
      .replace("{sha}", "b".repeat(40));
    expect(screen.getByText(expected)).toBeTruthy();
    expect(screen.queryByText(/not the reviewed commit/)).toBeNull();
  });
});
