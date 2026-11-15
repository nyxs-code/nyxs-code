import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FakeBackend } from "./fakeBackend";

const state = vi.hoisted(() => {
  (globalThis as Record<string, unknown>).window = { __TAURI_INTERNALS__: {} };
  return { backend: null as FakeBackend | null, enabled: [] as string[] };
});

vi.mock("@/lib/ipc", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => state.backend!.handle(cmd, args),
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => state.backend!.home }));
vi.mock("@/lib/plugins/pluginSettings", () => ({
  getEnabledPlugins: async () => state.enabled,
  setPluginEnabled: async (id: string, on: boolean) => {
    state.enabled = on ? [...new Set([...state.enabled, id])] : state.enabled.filter((x) => x !== id);
  },
}));
vi.mock("@/lib/configStore", () => ({
  loadMergedSettings: async () => ({}),
  getSettingsForSource: async () => ({}),
  saveSettingsForSource: async () => {},
}));
vi.mock("@/lib/secureStore", () => ({ getSecret: async () => null, setSecret: async () => {} }));

import { createFakeBackend } from "./fakeBackend";
import { bundledFiles, installBundledPlugins } from "../bundled";
import { readInstalled, uninstallPlugin } from "../install";
import { installedPluginsPath, writeJsonFile } from "../paths";
import { loadPluginComponents } from "../pluginLoader";

describe("plugins Nyxs ships installed", () => {
  beforeAll(() => {
    state.backend = createFakeBackend();
  });
  afterAll(() => state.backend!.cleanup());

  it("ships theme-examples whole: its manifest, its hooks module and its license", () => {
    const files = Object.keys(bundledFiles("theme-examples"));
    expect(files).toEqual(expect.arrayContaining([".claude-plugin/plugin.json", "hooks/hooks.json", "hooks/register.tsx", "hooks/scenes/honu-lagoon.ts", "LICENSE"]));
  });

  it("installs it on the first start, enabled, as the official marketplace's", async () => {
    await installBundledPlugins();
    const [entry] = (await readInstalled()).plugins;
    expect(entry).toMatchObject({ id: "theme-examples@claude-plugins-official", plugin: "theme-examples", marketplace: "claude-plugins-official" });
    expect(fs.existsSync(`${entry.installLocation}/hooks/register.tsx`)).toBe(true);
    expect(state.enabled).toContain("theme-examples@claude-plugins-official");
    const { mods } = await loadPluginComponents();
    expect(mods.map((m) => m.plugin)).toEqual(["theme-examples"]);
  });

  it("brings a copy an earlier release shipped up to this one's, and leaves one the user updated", async () => {
    const setVersion = async (version: string) => {
      const file = await readInstalled();
      file.plugins[0].version = version;
      await writeJsonFile(await installedPluginsPath(), file);
      vi.resetModules();
      await (await import("../bundled")).installBundledPlugins();
      return (await readInstalled()).plugins[0];
    };
    const shipped = await setVersion("0.4.3");
    expect(shipped.version).toMatch(/\+nyxs\.\d+$/);
    expect(fs.readFileSync(`${shipped.installLocation}/hooks/register.tsx`, "utf8")).toContain("ends with the card");
    expect((await setVersion("0.5.0")).version).toBe("0.5.0");
  });

  it("doesn't come back once the user uninstalled it", async () => {
    await uninstallPlugin("theme-examples@claude-plugins-official");
    vi.resetModules();
    const again = await import("../bundled");
    await again.installBundledPlugins();
    expect((await readInstalled()).plugins).toEqual([]);
  });
});
