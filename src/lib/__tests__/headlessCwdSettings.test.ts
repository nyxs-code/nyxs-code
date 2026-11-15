import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const files = new Map<string, string>();
const mtimes = new Map<string, number>();
let clock = 1;
/** Reads of these files wait until released, like a slow `ssh://` folder. */
const slow = new Map<string, Promise<void>>();

const norm = (p: unknown) => String(p ?? "").replace(/\\/g, "/");

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    const path = norm(args.path);
    if (cmd === "agent_read_text") {
      await slow.get(path);
      return files.get(path) ?? null;
    }
    if (cmd === "agent_file_mtime") return mtimes.get(path) ?? null;
    if (cmd === "agent_write_file") {
      files.set(path, String(args.content));
      mtimes.set(path, ++clock);
      return "OK";
    }
    if (cmd === "agent_allow_ui_path") return null;
    if (cmd === "nyxs_headless_write" || cmd === "nyxs_headless_exit") return null;
    // Event listeners some modules headless imports register.
    if (cmd.startsWith("plugin:")) return 0;
    throw new Error(`unexpected command ${cmd}`);
  }),
}));

const MODEL_ID = "anthropic:claude-sonnet-4-5";
const modelSettings = vi.hoisted(() => ({
  anthropic: { apiKey: "test-key", models: [{ id: "anthropic:claude-sonnet-4-5", provider: "anthropic", apiModel: "claude-sonnet-4-5", name: "Sonnet" }] },
}));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@/lib/settings", async (orig) => ({ ...(await orig<object>()), loadSettings: () => modelSettings, loadSelectedModel: () => null }));

const HOME = "C:/Users/me";
const USER = `${HOME}/.nyxs/settings.json`;
const NYXS_JSON = `${HOME}/.nyxs/nyxs.json`;
const A = "E:/a";
const B = "E:/b";

const userLayer = { permissions: { deny: ["Bash(rm:*)"] } };
const layerA = {
  permissions: { deny: ["Bash(echo:*)"] },
  hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo a" }] }] },
};
const layerB = {
  permissions: { deny: ["Bash(git:*)"] },
  hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo b" }] }] },
};

type Runtime = typeof import("@/lib/settingsRuntime");
type GlobalConfig = typeof import("@/lib/globalConfig");
let rt: Runtime;
let gc: GlobalConfig;

function put(path: string, data: unknown): void {
  files.set(path, typeof data === "string" ? data : JSON.stringify(data));
  mtimes.set(path, ++clock);
}

/** Trusts both projects as they are now. */
async function trustBoth(): Promise<void> {
  const projects: Record<string, unknown> = {};
  for (const [ws, layer] of [[A, layerA], [B, layerB]] as const) {
    projects[ws] = { trusted: true, trustedSettingsHash: await rt.digestGatedSettings({ project: layer as never }) };
  }
  put(NYXS_JSON, { version: 1, projects });
  gc.resetGlobalConfigCache();
}

beforeAll(async () => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { transformCallback: () => 0, invoke: async () => 0 }, __NYXS_HOME__: HOME });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  rt = await import("@/lib/settingsRuntime");
  gc = await import("@/lib/globalConfig");
});

beforeEach(async () => {
  files.clear();
  mtimes.clear();
  slow.clear();
  put(USER, userLayer);
  put(`${A}/.nyxs/settings.json`, layerA);
  put(`${B}/.nyxs/settings.json`, layerB);
  await trustBoth();
  rt.setSettingsWorkspace(null);
  rt.resetSettingsCache();
  await rt.getMergedSettings();
});

describe("headless --cwd", () => {
  it("applies the project's deny rules, as trusted", async () => {
    vi.resetModules();
    const { runHeadless } = await import("@/headless");
    const verdicts: boolean[] = [];
    await runHeadless(
      { prompt: "x", format: "text", cwd: A, model: MODEL_ID, permissionMode: "auto" } as never,
      {
        chat: async (o: { gate?: (tool: string, input: unknown) => Promise<boolean> }) => {
          verdicts.push(await o.gate!("Bash", { command: "echo hi" }));
          verdicts.push(await o.gate!("Bash", { command: "ls" }));
          return "done";
        },
        now: () => 1,
      } as never,
    );
    expect(verdicts).toEqual([false, true]);
  });
});
