import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  setPluginEnabled: async () => {},
}));
vi.mock("@/lib/configStore", () => ({
  loadMergedSettings: async () => ({}),
  getSettingsForSource: async () => ({}),
  saveSettingsForSource: async () => {},
}));
vi.mock("@/lib/secureStore", () => ({ getSecret: async () => null, setSecret: async () => {} }));

import { createFakeBackend } from "./fakeBackend";
import { clearPluginLoaderCache, loadPluginComponents } from "../pluginLoader";
import { parsePluginManifest } from "../schema";

function writeTree(root: string, files: Record<string, unknown>): void {
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  }
}

const hook = (command: string, extra: Record<string, unknown> = {}) => ({ type: "command", command, ...extra });

describe("Claude-format plugins keep their hooks, MCP servers and components", () => {
  let backend: FakeBackend;
  let root: string;

  const install = (files: Record<string, unknown>) => {
    fs.rmSync(root, { recursive: true, force: true });
    writeTree(root, files);
    writeTree(`${backend.home}/.nyxs/plugins`, {
      "installed_plugins.json": {
        version: 1,
        plugins: [{ id: "sec@mp", plugin: "sec", marketplace: "mp", version: "1.0.0", installLocation: root, installedAt: 1 }],
      },
    });
    state.enabled = ["sec@mp"];
    clearPluginLoaderCache();
  };

  beforeAll(() => {
    backend = createFakeBackend();
    state.backend = backend;
    root = `${backend.home}/.nyxs/plugins/cache/mp/sec/1.0.0`;
  });
  afterAll(() => backend.cleanup());
  beforeEach(() => clearPluginLoaderCache());

  it("reads hooks/hooks.json, .mcp.json and the paths the manifest points to", async () => {
    install({
      ".claude-plugin/plugin.json": {
        name: "sec",
        author: "Jane Doe",
        hooks: "./extra/hooks.json",
        mcpServers: "./config/servers.json",
        lspServers: { ts: { command: "tsserver" } },
        $schema: "https://example.invalid/schema.json",
      },
      "hooks/hooks.json": {
        description: "Checks Bash commands",
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [hook('sh "${CLAUDE_PLUGIN_ROOT}/hooks/check.sh"')] }] },
      },
      "extra/hooks.json": { hooks: { Stop: [{ hooks: [hook("${CLAUDE_PLUGIN_ROOT}/bin/stop")] }] } },
      ".mcp.json": {
        mcpServers: { chat: { command: "bun", args: ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "start"] } },
      },
      "config/servers.json": { docs: { type: "http", url: "https://mcp.example.invalid/mcp" } },
      "commands/hello.md": "---\ndescription: Say hi\n---\nRun ${CLAUDE_PLUGIN_ROOT}/bin/hi",
      "agents/reviewer.md": "---\nname: reviewer\ndescription: Reviews\n---\nReview the diff.",
      "output-styles/terse.md": "---\nname: Terse\n---\nBe brief.",
    });

    const out = await loadPluginComponents();

    expect(out.plugins[0].manifest.author).toEqual({ name: "Jane Doe" });
    expect(out.hooks.PreToolUse?.[0]).toEqual({ matcher: "Bash", hooks: [hook(`sh "${root}/hooks/check.sh"`)] });
    expect(out.hooks.Stop?.[0].hooks[0].command).toBe(`${root}/bin/stop`);
    expect(out.mcpServers["sec:chat"]).toMatchObject({
      command: "bun",
      args: ["run", "--cwd", root, "start"],
      env: { CLAUDE_PLUGIN_ROOT: root },
    });
    expect(out.mcpServers["sec:docs"]).toMatchObject({ url: "https://mcp.example.invalid/mcp" });
    expect(out.commands.map((c) => c.name)).toEqual(["sec:hello"]);
    expect(out.commands[0].content).toContain(`${root}/bin/hi`);
    expect(out.agents.map((a) => a.name)).toEqual(["sec:reviewer"]);
    expect(out.outputStyles.map((s) => s.name)).toEqual(["Terse"]);
    expect(out.errors).toEqual([]);
  });

  it("reads a flat .mcp.json and inline manifest hooks and servers", async () => {
    install({
      ".claude-plugin/plugin.json": {
        name: "sec",
        hooks: { SessionStart: [{ hooks: [hook("echo start")] }] },
        mcpServers: { inline: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.js"] } },
      },
      ".mcp.json": { flat: { command: "npx", args: ["-y", "pkg"] } },
    });

    const out = await loadPluginComponents();

    expect(out.hooks.SessionStart?.[0].hooks[0].command).toBe("echo start");
    expect(Object.keys(out.mcpServers).sort()).toEqual(["sec:flat", "sec:inline"]);
    expect(out.mcpServers["sec:inline"]).toMatchObject({ args: [`${root}/server.js`] });
  });

  it("drops only the hooks it can't honor, and says why", async () => {
    install({
      ".claude-plugin/plugin.json": { name: "sec" },
      "hooks/hooks.json": {
        hooks: {
          PostToolUse: [
            {
              matcher: "Bash",
              hooks: [
                hook("echo always"),
                hook("echo after push", { if: "Bash(git push *)" }),
                { type: "prompt", prompt: "Is this safe?" },
              ],
            },
          ],
        },
      },
    });

    const out = await loadPluginComponents();

    expect(out.hooks.PostToolUse).toEqual([{ matcher: "Bash", hooks: [hook("echo always")] }]);
    expect(out.errors.map((e) => e.path)).toEqual(["hooks.PostToolUse.0.hooks.1", "hooks.PostToolUse.0.hooks.2"]);
    expect(out.errors[0].message).toMatch(/"if"/);
  });

  it("takes a hooks file naming a hooks module as a mod, not as hook events", async () => {
    install({
      ".claude-plugin/plugin.json": { name: "theme-examples" },
      "hooks/hooks.json": { modules: ["./register.tsx"] },
      "hooks/register.tsx": "export const register = () => {}",
    });

    const out = await loadPluginComponents();

    expect(out.mods).toEqual([{ plugin: "theme-examples", root, entry: "hooks/register.tsx", options: {}, source: "installed" }]);
    expect(out.hooks).toEqual({});
    expect(out.errors).toEqual([]);
  });
});

describe("a manifest with one bad field keeps the rest", () => {
  it("reports the bad field and keeps the others", () => {
    const { manifest, errors } = parsePluginManifest(
      {
        name: "p",
        description: "Still here",
        keywords: "not-a-list",
        userConfig: {
          token: { type: "string", title: "Token", sensitive: true },
          broken: { type: "color", title: "Colour" },
        },
        mcpServers: { good: { command: "node" }, bad: { url: 5 } },
      },
      "p/plugin.json",
    );
    expect(manifest?.description).toBe("Still here");
    expect(manifest?.keywords).toBeUndefined();
    expect(Object.keys(manifest?.userConfig ?? {})).toEqual(["token"]);
    expect(Object.keys((manifest?.mcpServers ?? {}) as object)).toEqual(["good"]);
    expect(errors.map((e) => e.path.split(".").slice(0, 2).join(".")).sort()).toEqual([
      "keywords",
      "mcpServers.bad",
      "userConfig.broken",
    ]);
  });
});
