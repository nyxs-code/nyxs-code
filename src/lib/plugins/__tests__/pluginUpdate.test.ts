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
import { installPlugin, listInstalled } from "../install";
import { checkPluginUpdates, updatePlugin } from "../update";

describe("updating a plugin", () => {
  let backend: FakeBackend;
  let remotes: string;
  let repo: string;
  const cache = () => `${backend.home}/.nyxs/plugins/cache/mp/p`;
  const setCatalog = async (entry: Record<string, unknown>) => {
    state.catalog = { plugins: [{ name: "p", source: { source: "url", url: fileUrl(repo) }, ...entry }] };
    await refreshCatalog("mp");
  };

  beforeAll(() => {
    backend = createFakeBackend();
    state.backend = backend;
    backend.fetch = () => JSON.stringify(state.catalog);
    remotes = makeTempDir("remotes");
    repo = `${remotes}/plugin-repo`;
    makeRepo(repo, [{ "README.md": "one" }]);
  });
  afterAll(() => {
    backend.cleanup();
    fs.rmSync(remotes, { recursive: true, force: true });
  });
  beforeEach(() => {
    fs.rmSync(`${backend.home}/.nyxs/plugins`, { recursive: true, force: true });
  });

  it("removes the previous version's folder once the new one is installed", async () => {
    await setCatalog({ version: "1.0.0" });
    await installPlugin("mp", "p");
    expect(fs.existsSync(`${cache()}/1.0.0/README.md`)).toBe(true);

    makeRepo(repo, [{ "README.md": "two" }]);
    await setCatalog({ version: "1.1.0" });
    const updated = await updatePlugin("p@mp");

    expect(updated.installLocation).toBe(`${cache()}/1.1.0`);
    expect(fs.readFileSync(`${cache()}/1.1.0/README.md`, "utf8")).toBe("two");
    expect(fs.readdirSync(cache())).toEqual(["1.1.0"]);
    expect((await listInstalled()).map((p) => p.installLocation)).toEqual([`${cache()}/1.1.0`]);
  });

  it("offers a commit update when only the reviewed sha changed, and none once updated", async () => {
    const head = () => gitSetup(repo, "rev-parse", "HEAD");
    await setCatalog({ source: { source: "url", url: fileUrl(repo), sha: head() } });
    await installPlugin("mp", "p");
    expect(await checkPluginUpdates()).toEqual([]);

    const [next] = makeRepo(repo, [{ "README.md": "three" }]);
    await setCatalog({ source: { source: "url", url: fileUrl(repo), sha: next } });
    expect(await checkPluginUpdates()).toEqual([
      expect.objectContaining({ id: "p@mp", kind: "commit", latestSha: next }),
    ]);

    const updated = await updatePlugin("p@mp");
    expect(updated.sha).toBe(next);
    expect(await checkPluginUpdates()).toEqual([]);
  });

  it("offers a version update when the catalog has a newer version number", async () => {
    await setCatalog({ version: "1.0.0" });
    await installPlugin("mp", "p");
    await setCatalog({ version: "1.2.0" });
    expect(await checkPluginUpdates()).toEqual([
      expect.objectContaining({ id: "p@mp", kind: "version", current: "1.0.0", latest: "1.2.0" }),
    ]);
  });

  it("stays quiet for a plugin whose catalog entry pins no commit", async () => {
    await setCatalog({});
    await installPlugin("mp", "p");
    makeRepo(repo, [{ "README.md": "four" }]);
    await setCatalog({});
    expect(await checkPluginUpdates()).toEqual([]);
  });
});
