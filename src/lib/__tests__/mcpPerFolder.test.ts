import { describe, it, expect, vi, beforeAll } from "vitest";

const files = new Map<string, string>();
const norm = (p: unknown) => String(p ?? "").replace(/\\/g, "/");

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    const path = norm(args.path);
    if (cmd === "agent_read_text") return files.get(path) ?? null;
    if (cmd === "agent_file_mtime") return files.has(path) ? 1 : null;
    if (cmd === "agent_allow_ui_path") return null;
    throw new Error(`unexpected command ${cmd}`);
  }),
}));

const HOME = "C:/Users/me";
const A = "E:/a";
const B = "E:/b";
const layerA = { mcpServers: { docsA: { url: "https://a.example/mcp" } } };
const layerB = { mcpServers: { docsB: { url: "https://b.example/mcp" } } };

let rt: typeof import("@/lib/settingsRuntime");
let mcp: typeof import("@/lib/mcp");

beforeAll(async () => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, __NYXS_HOME__: HOME });
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  rt = await import("@/lib/settingsRuntime");
  mcp = await import("@/lib/mcp");
  files.set(`${A}/.nyxs/settings.json`, JSON.stringify(layerA));
  files.set(`${B}/.nyxs/settings.json`, JSON.stringify(layerB));
  const projects: Record<string, unknown> = {};
  for (const [ws, layer] of [[A, layerA], [B, layerB]] as const) {
    projects[ws] = { trusted: true, trustedSettingsHash: await rt.digestGatedSettings({ project: layer as never }) };
  }
  files.set(`${HOME}/.nyxs/nyxs.json`, JSON.stringify({ version: 1, projects }));
});

describe("the MCP servers of a turn", () => {
  it("are those of the turn's own folder, not the one open in the app", async () => {
    rt.setSettingsWorkspace(B);
    await rt.getMergedSettings();
    await rt.settingsFor(A);
    const names = (ws?: string) => mcp.loadMergedMcpServers(ws).map((s) => s.name);
    expect(names(A)).toContain("docsA");
    expect(names(A)).not.toContain("docsB");
    // Without a folder: the open one, as Settings shows.
    expect(names()).toContain("docsB");
    expect(names(B)).toContain("docsB");
  });
});
