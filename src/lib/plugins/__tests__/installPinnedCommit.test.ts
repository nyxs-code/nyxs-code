import fs from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeBackend } from "./fakeBackend";

const state = vi.hoisted(() => {
  (globalThis as Record<string, unknown>).window = { __TAURI_INTERNALS__: {} };
  return { backend: null as FakeBackend | null, catalog: { plugins: [] as unknown[] } };
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
  getMarketplace: async (name: string) =>
    name === "mp"
      ? {
          name: "mp",
          source: { source: "url", url: "https://example.invalid/marketplace.json" },
          installLocation: `${state.backend!.home}/.nyxs/plugins/marketplaces/mp`,
          autoUpdate: false,
        }
      : null,
}));

import { createFakeBackend, fileUrl, gitSetup, makeRepo, makeTempDir } from "./fakeBackend";
import { refreshCatalog } from "../catalog";
import { installPlugin } from "../install";
import { updatePlugin } from "../update";

describe("plugins are installed at the commit and ref their catalog names", () => {
  let backend: FakeBackend;
  let remotes: string;
  let repo: string;
  let shas: string[];

  const setCatalog = async (source: Record<string, unknown>) => {
    state.catalog = { plugins: [{ name: "p", version: "1.0.0", source: { url: fileUrl(repo), ...source } }] };
    await refreshCatalog("mp");
  };
  const installed = (rel: string) =>
    fs.readFileSync(`${backend.home}/.nyxs/plugins/cache/mp/p/1.0.0/${rel}`, "utf8");

  beforeAll(() => {
    backend = createFakeBackend();
    state.backend = backend;
    backend.fetch = () => JSON.stringify(state.catalog);
    remotes = makeTempDir("remotes");
    repo = `${remotes}/plugin-repo`;
    shas = makeRepo(repo, [
      { "plugins/p/version.txt": "reviewed" },
      { "plugins/p/version.txt": "unreviewed" },
    ]);
    gitSetup(repo, "tag", "v1", shas[0]);
  });
  afterAll(() => {
    backend.cleanup();
    fs.rmSync(remotes, { recursive: true, force: true });
  });
  beforeEach(() => {
    fs.rmSync(`${backend.home}/.nyxs/plugins`, { recursive: true, force: true });
  });

  it("checks out the reviewed sha, not the branch's latest commit", async () => {
    await setCatalog({ source: "git-subdir", path: "plugins/p", ref: "main", sha: shas[0] });
    const { installed: entry } = await installPlugin("mp", "p");
    expect(installed("version.txt")).toBe("reviewed");
    expect(shas[0].startsWith(entry.sha ?? "-")).toBe(true);
  });

  it("checks out a tag and follows it when the catalog moves to a newer one", async () => {
    await setCatalog({ source: "git-subdir", path: "plugins/p", ref: "v1" });
    await installPlugin("mp", "p");
    expect(installed("version.txt")).toBe("reviewed");

    const [v2] = makeRepo(repo, [{ "plugins/p/version.txt": "v2" }]);
    gitSetup(repo, "tag", "v2", v2);
    await setCatalog({ source: "git-subdir", path: "plugins/p", ref: "v2", sha: v2 });
    const updated = await updatePlugin("p@mp");
    expect(installed("version.txt")).toBe("v2");
    expect(v2.startsWith(updated.sha ?? "-")).toBe(true);
  });

  it("follows the default branch when the catalog pins nothing", async () => {
    await setCatalog({ source: "url" });
    await installPlugin("mp", "p");
    const before = installed("plugins/p/version.txt");
    makeRepo(repo, [{ "plugins/p/version.txt": "newest" }]);
    await updatePlugin("p@mp");
    expect(before).not.toBe("newest");
    expect(installed("plugins/p/version.txt")).toBe("newest");
  });

  it("fails, keeping the previous install, when the reviewed sha can't be reached", async () => {
    await setCatalog({ source: "git-subdir", path: "plugins/p", sha: shas[0] });
    await installPlugin("mp", "p");

    await setCatalog({ source: "git-subdir", path: "plugins/p", sha: "deadbeef".repeat(5) });
    await expect(installPlugin("mp", "p")).rejects.toThrow(/deadbeef/);
    await setCatalog({ source: "git-subdir", path: "plugins/p", ref: "v1", sha: shas[1].slice(0, 10) });
    await expect(installPlugin("mp", "p")).rejects.toThrow(/not the reviewed commit/);
    expect(installed("version.txt")).toBe("reviewed");
  });
});
