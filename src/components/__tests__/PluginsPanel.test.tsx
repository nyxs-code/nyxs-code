// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { InstalledPlugin, PluginUpdate } from "@/lib/plugins";

const fake = vi.hoisted(() => ({
  installed: [] as InstalledPlugin[],
  updates: [] as PluginUpdate[],
  enabled: true,
  setEnabled: vi.fn(async (_id: string, _on: boolean) => {}),
  uninstall: vi.fn(async (_id: string) => {}),
}));

vi.mock("@/lib/ipc", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ipc")>()), invoke: async () => undefined }));
vi.mock("@/lib/plugins", () => ({
  listMarketplaces: async () => [],
  removeMarketplace: async () => {},
  setAutoUpdate: async () => {},
  describeSource: () => "",
  ensureDefaultMarketplaces: async () => {},
  isBuiltinMarketplace: () => false,
  getCatalog: async () => ({ plugins: [] }),
  refreshAllMarketplaces: async () => ({ refreshed: [], failed: [] }),
  listInstalled: async () => fake.installed,
  installPlugin: async () => {},
  uninstallPlugin: (id: string) => fake.uninstall(id),
  isEnabled: async () => fake.enabled,
  setEnabled: (id: string, on: boolean) => fake.setEnabled(id, on),
  checkPluginUpdates: async () => fake.updates,
  updatePlugin: async (id: string) => {
    fake.updates = fake.updates.filter((u) => u.id !== id);
  },
}));

const { PluginsPanel } = await import("../PluginsPanel");
const { getTranslations } = await import("@/lib/i18n");
const t = getTranslations("en-US").pluginsPanel;

const plugin = (name: string, version: string): InstalledPlugin => ({
  id: `${name}@mp`,
  plugin: name,
  marketplace: "mp",
  version,
  installLocation: `/home/me/.nyxs/plugins/cache/mp/${name}/${version}`,
  installedAt: 1,
});

afterEach(cleanup);

describe("PluginsPanel updates", () => {
  it("names the version when there is one, says Update for a new commit, and clears after updating", async () => {
    fake.installed = [plugin("versioned", "1.2.0"), plugin("unversioned", "0.0.0")];
    fake.updates = [
      { id: "versioned@mp", plugin: "versioned", marketplace: "mp", current: "1.2.0", latest: "1.3.0", kind: "version" },
      {
        id: "unversioned@mp",
        plugin: "unversioned",
        marketplace: "mp",
        current: "0.0.0",
        latest: "0.0.0",
        kind: "commit",
        latestSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      },
    ];
    await act(async () => {
      render(<PluginsPanel />);
    });

    const byVersion = screen.getByRole("button", { name: "v1.3.0" });
    expect(byVersion.getAttribute("data-tooltip")).toBe(t.updateTo.replace("{version}", "1.3.0"));

    const byCommit = screen.getByRole("button", { name: t.update });
    expect(byCommit.hasAttribute("data-tooltip")).toBe(false);
    expect(document.body.textContent).not.toContain("a1b2c3d");

    await act(async () => {
      fireEvent.click(byCommit);
    });
    expect(screen.queryByRole("button", { name: t.update })).toBeNull();
    expect(screen.getByRole("button", { name: "v1.3.0" })).toBeTruthy();
  });
});

describe("PluginsPanel's installed plugins", () => {
  const tm = getTranslations("en-US").pluginsModal;

  it("asks for trust before turning a plugin on, as the plugins dialog does", async () => {
    fake.installed = [plugin("helper", "1.0.0")];
    fake.updates = [];
    fake.enabled = false;
    fake.setEnabled.mockClear();
    await act(async () => {
      render(<PluginsPanel />);
    });
    const ask = async () => {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: t.enable }));
      });
      return screen.getByRole("alertdialog");
    };
    let dialog = await ask();
    expect(dialog.textContent).toContain(tm.enableConfirmTitle.replace("{name}", "helper"));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: tm.cancel }));
    });
    expect(fake.setEnabled).not.toHaveBeenCalled();

    dialog = await ask();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: tm.enable }));
    });
    expect(fake.setEnabled).toHaveBeenCalledWith("helper@mp", true);
  });

  it("shows why removing a plugin failed where the panel shows its errors", async () => {
    fake.installed = [plugin("stuck", "1.0.0")];
    fake.updates = [];
    fake.enabled = true;
    fake.uninstall.mockRejectedValueOnce(new Error("the folder is in use"));
    await act(async () => {
      render(<PluginsPanel />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.uninstall }));
    });
    expect(await screen.findByText(/the folder is in use/)).toBeTruthy();
  });
});
