import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FakeBackend } from "./fakeBackend";

const state = vi.hoisted(() => {
  (globalThis as Record<string, unknown>).window = { __TAURI_INTERNALS__: {} };
  return { backend: null as FakeBackend | null };
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
    name === "npm-mp"
      ? {
          name: "npm-mp",
          source: { source: "npm", package: "@acme/nyxs-marketplace" },
          installLocation: `${state.backend!.home}/.nyxs/plugins/marketplaces/npm-mp`,
          autoUpdate: false,
        }
      : null,
}));

import { createFakeBackend, makeTempDir } from "./fakeBackend";
import { refreshCatalog } from "../catalog";
import { installPlugin } from "../install";

function publish(dir: string, version: string, plugins: Record<string, string>): void {
  fs.rmSync(dir, { recursive: true, force: true });
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "@acme/nyxs-marketplace", version }),
    ".claude-plugin/marketplace.json": JSON.stringify({
      plugins: Object.keys(plugins).map((name) => ({ name, version, source: `./plugins/${name}` })),
    }),
  };
  for (const [name, body] of Object.entries(plugins)) files[`plugins/${name}/README.md`] = body;
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
}

describe("a marketplace published on npm", () => {
  let backend: FakeBackend;
  let registry: string;
  const cache = () => `${backend.home}/.nyxs/plugins/marketplaces/npm-mp`;

  beforeAll(() => {
    backend = createFakeBackend();
    state.backend = backend;
    registry = makeTempDir("npm-registry");
    backend.npmRegistry.set("@acme/nyxs-marketplace", `${registry}/pkg`);
  });
  afterAll(() => {
    backend.cleanup();
    fs.rmSync(registry, { recursive: true, force: true });
  });

  it("follows new versions, drops files they removed and leaves no tarballs behind", async () => {
    publish(`${registry}/pkg`, "1.0.0", { alpha: "alpha v1" });
    const first = await refreshCatalog("npm-mp");
    expect(first.plugins.map((p) => p.name)).toEqual(["alpha"]);
    expect(fs.existsSync(`${cache()}/package/plugins/alpha/README.md`)).toBe(true);

    publish(`${registry}/pkg`, "2.0.0", { beta: "beta v2" });
    const second = await refreshCatalog("npm-mp");
    expect(second.plugins.map((p) => p.name)).toEqual(["beta"]);
    expect(fs.existsSync(`${cache()}/package/plugins/alpha`)).toBe(false);

    const { installed } = await installPlugin("npm-mp", "beta");
    expect(fs.readFileSync(`${installed.installLocation}/README.md`, "utf8")).toBe("beta v2");
    expect(fs.readdirSync(cache()).filter((f) => f.endsWith(".tgz"))).toEqual([]);
    expect(fs.readdirSync(cache()).sort()).toEqual(["catalog.cached.json", "package"]);
  });
});
