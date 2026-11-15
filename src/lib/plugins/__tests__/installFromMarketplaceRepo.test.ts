import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FakeBackend } from "./fakeBackend";
import type { KnownMarketplace } from "../schema";

const state = vi.hoisted(() => {
  (globalThis as Record<string, unknown>).window = { __TAURI_INTERNALS__: {} };
  return { backend: null as FakeBackend | null, marketplaces: new Map<string, unknown>() };
});

vi.mock("@/lib/ipc", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => state.backend!.handle(cmd, args),
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => state.backend!.home }));
vi.mock("@/lib/plugins/pluginSettings", () => ({
  getEnabledPlugins: async () => [],
  setPluginEnabled: async () => {},
}));
vi.mock("@/lib/plugins/marketplace", () => ({
  getMarketplace: async (name: string) => state.marketplaces.get(name) ?? null,
}));

import { createFakeBackend, fileUrl, gitSetup, makeRepo, makeTempDir } from "./fakeBackend";
import { refreshCatalog } from "../catalog";
import { installPlugin } from "../install";

const CATALOG = JSON.stringify({
  name: "official",
  plugins: [
    { name: "agent-sdk-dev", version: "1.0.0", source: "./plugins/agent-sdk-dev" },
    { name: "asana", version: "2.0.0", source: "./external_plugins/asana" },
  ],
});

describe("plugins that live inside the marketplace's own repo", () => {
  let backend: FakeBackend;
  let remotes: string;
  let repo: string;
  const cacheOf = (name: string) => `${backend.home}/.nyxs/plugins/marketplaces/${name}`;
  const addMarketplace = (name: string, source: KnownMarketplace["source"]) =>
    state.marketplaces.set(name, { name, source, installLocation: cacheOf(name), autoUpdate: true });

  beforeAll(() => {
    backend = createFakeBackend();
    state.backend = backend;
    remotes = makeTempDir("remotes");
    repo = `${remotes}/claude-plugins-official`;
    makeRepo(repo, [
      {
        ".claude-plugin/marketplace.json": CATALOG,
        "plugins/agent-sdk-dev/.claude-plugin/plugin.json": '{"name":"agent-sdk-dev"}',
        "external_plugins/asana/.claude-plugin/plugin.json": '{"name":"asana"}',
      },
    ]);
    backend.serveGithub("anthropics/claude-plugins-official", repo);
    backend.fetch = (url) =>
      url === "https://raw.githubusercontent.com/anthropics/claude-plugins-official/HEAD/.claude-plugin/marketplace.json"
        ? CATALOG
        : undefined;
  });
  afterAll(() => {
    backend.cleanup();
    fs.rmSync(remotes, { recursive: true, force: true });
  });

  it("installs from a GitHub marketplace whose cache folder already holds the catalog copy", async () => {
    addMarketplace("claude-plugins-official", { source: "github", repo: "anthropics/claude-plugins-official" });
    await refreshCatalog("claude-plugins-official");
    const cache = cacheOf("claude-plugins-official");
    expect(fs.existsSync(`${cache}/catalog.cached.json`)).toBe(true);

    const { installed } = await installPlugin("claude-plugins-official", "agent-sdk-dev");
    expect(fs.readFileSync(`${installed.installLocation}/.claude-plugin/plugin.json`, "utf8")).toContain(
      "agent-sdk-dev",
    );
    expect(installed.sha).toBeTruthy();
    expect(fs.existsSync(`${cache}/repo/.git`)).toBe(true);

    // The second plugin reuses the same checkout.
    const second = await installPlugin("claude-plugins-official", "asana");
    expect(fs.existsSync(`${second.installed.installLocation}/.claude-plugin/plugin.json`)).toBe(true);
    expect(fs.existsSync(`${cache}/catalog.cached.json`)).toBe(true);
  });

  it("keeps using a git marketplace that older versions cloned straight into its cache folder", async () => {
    const cache = cacheOf("legacy");
    gitSetup(remotes, "clone", "-q", fileUrl(repo), cache);
    addMarketplace("legacy", { source: "git", url: fileUrl(repo) });
    await refreshCatalog("legacy");

    const { installed } = await installPlugin("legacy", "agent-sdk-dev");
    expect(fs.existsSync(`${installed.installLocation}/.claude-plugin/plugin.json`)).toBe(true);
    expect(fs.existsSync(`${cache}/repo`)).toBe(false);
  });

  it("clones a new git marketplace into its own folder next to the catalog copy", async () => {
    addMarketplace("fresh", { source: "git", url: fileUrl(repo) });
    await refreshCatalog("fresh");
    const cache = cacheOf("fresh");
    expect(fs.existsSync(`${cache}/repo/.git`)).toBe(true);
    expect(fs.existsSync(`${cache}/catalog.cached.json`)).toBe(true);
    const { installed } = await installPlugin("fresh", "asana");
    expect(fs.existsSync(`${installed.installLocation}/.claude-plugin/plugin.json`)).toBe(true);
  });
});
