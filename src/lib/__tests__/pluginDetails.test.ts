import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({ invoke: vi.fn(async () => null) }));

const { networkHosts, partKinds, runsCode, shownVersion, sourceOf } = await import("@/lib/plugins/pluginDetails");
const { partsLine } = await import("@/components/customize/pluginText");
const { getTranslations } = await import("@/lib/i18n");

const none = { hooks: [], commands: [], agents: [], skills: [], mcpServers: [], outputStyles: [] };

describe("what a plugin adds", () => {
  it("lists its kinds in Claude's order, local and remote MCP servers apart", () => {
    const parts = {
      ...none,
      hooks: [{ name: "./register.tsx" }],
      commands: [{ name: "/a" }, { name: "/b" }],
      agents: [{ name: "reviewer" }],
      mcpServers: [{ name: "local" }, { name: "remote", host: "api.example.com" }],
    };
    expect(partKinds(parts)).toEqual([
      { kind: "hook", count: 1 },
      { kind: "agent", count: 1 },
      { kind: "command", count: 2 },
      { kind: "localMcp", count: 1 },
      { kind: "mcp", count: 1 },
    ]);
  });

  it("says it can run code with hooks or a server it starts, and where it sends data", () => {
    expect(runsCode(none)).toBe(false);
    expect(runsCode({ ...none, hooks: [{ name: "PreToolUse" }] })).toBe(true);
    expect(runsCode({ ...none, mcpServers: [{ name: "local" }] })).toBe(true);
    const remote = { ...none, mcpServers: [{ name: "a", host: "x.dev" }, { name: "b", host: "x.dev" }] };
    expect(runsCode(remote)).toBe(false);
    expect(networkHosts(remote)).toEqual(["x.dev"]);
  });

  it("writes the list line in the app's language", () => {
    const t = getTranslations("en-US").customizePage;
    expect(partsLine({ ...none, hooks: [{ name: "h" }] }, t)).toBe("Hook");
    expect(partsLine({ ...none, hooks: [{ name: "h" }, { name: "i" }], agents: [{ name: "a" }], commands: [{ name: "/c" }, { name: "/d" }] }, t))
      .toBe("Hooks, agent, and commands");
    expect(partsLine(none, t)).toBe("");
    expect(partsLine(undefined, t)).toBe("");
  });
});

describe("version", () => {
  it("shows the installed copy's own version, not the 0.0.0 a catalog without one leaves", () => {
    expect(shownVersion({ name: "p", version: "0.4.3" }, "0.0.0", "b5b01ac4f889")).toBe("v0.4.3");
    expect(shownVersion({ name: "p" }, "1.2.0")).toBe("v1.2.0");
    expect(shownVersion({ name: "p" }, "0.0.0", "b5b01ac4f889")).toBe("b5b01ac");
    expect(shownVersion(null, "0.0.0")).toBeNull();
  });
});

describe("source code", () => {
  const github = { name: "official", source: { source: "github" as const, repo: "anthropics/claude-plugins-official" }, installLocation: "x", autoUpdate: false };

  it("prefers the plugin's own repository, then its marketplace's GitHub repository", () => {
    expect(sourceOf({ name: "p", repository: "https://github.com/me/p/" }, undefined, github))
      .toEqual({ label: "github.com/me/p", url: "https://github.com/me/p/" });
    expect(sourceOf({ name: "p" }, undefined, github))
      .toEqual({ label: "anthropics/claude-plugins-official", url: "https://github.com/anthropics/claude-plugins-official" });
    expect(sourceOf(null, undefined, null)).toBeNull();
  });

  it("never links a local folder", () => {
    const local = { name: "mine", source: { source: "directory" as const, path: "C:/plugins" }, installLocation: "x", autoUpdate: false };
    expect(sourceOf({ name: "p", homepage: "file:///C:/x" }, undefined, local)).toBeNull();
  });
});
