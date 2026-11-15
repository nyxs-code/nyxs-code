import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const files = new Map<string, string>();
const mtimes = new Map<string, number>();
let clock = 1;

const norm = (p: unknown) => String(p ?? "").replace(/\\/g, "/");

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    const path = norm(args.path);
    if (cmd === "agent_read_text") return files.get(path) ?? null;
    if (cmd === "agent_file_mtime") return mtimes.get(path) ?? null;
    if (cmd === "agent_write_file") {
      files.set(path, String(args.content));
      mtimes.set(path, ++clock);
      return "OK";
    }
    if (cmd === "agent_allow_ui_path") return null;
    throw new Error(`unexpected command ${cmd}`);
  }),
}));

const HOME = "C:/Users/me";
const USER = `${HOME}/.nyxs/settings.json`;
const WS = "E:/repo";
const LOCAL = `${WS}/.nyxs/settings.local.json`;

/** Hand-edited, with a comment and a trailing comma: what JSON.parse rejects. */
const BROKEN_USER = `{
  // keep the agent away from rm
  "schemaVersion": 3,
  "permissions": { "deny": ["Bash(rm:*)"] },
}
`;

type Runtime = typeof import("@/lib/settingsRuntime");
type Migrations = typeof import("@/lib/migrations");
type Safe = typeof import("@/lib/safeJsonFile");
let rt: Runtime;
let migrations: Migrations;
let safe: Safe;

function put(path: string, content: string): void {
  files.set(path, content);
  mtimes.set(path, ++clock);
}

async function settle(): Promise<void> {
  await rt.getMergedSettings();
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeAll(async () => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, __NYXS_HOME__: HOME });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  safe = await import("@/lib/safeJsonFile");
  rt = await import("@/lib/settingsRuntime");
  migrations = await import("@/lib/migrations");
});

beforeEach(async () => {
  files.clear();
  mtimes.clear();
  safe.resetWriteBlocks();
  rt.setSettingsWorkspace(null);
  rt.resetSettingsCache();
  await settle();
});

describe("a settings.json that can't be parsed", () => {
  it("isn't overwritten by the migrations at startup", async () => {
    put(USER, BROKEN_USER);
    rt.resetSettingsCache();
    await settle();
    await migrations.runMigrations();
    expect(files.get(USER)).toBe(BROKEN_USER);
    expect(files.get(`${USER}.bak`)).toBe(BROKEN_USER);
  });

  it("isn't overwritten by a switch in Settings", async () => {
    put(USER, BROKEN_USER);
    rt.resetSettingsCache();
    await settle();
    await expect(rt.updateSettingsForSource("user", { promptSuggestions: false })).rejects.toBeInstanceOf(
      safe.UnreadableFileError,
    );
    expect(files.get(USER)).toBe(BROKEN_USER);
    expect((await rt.getSettingsForSource("user")).promptSuggestions).toBeUndefined();
  });

  it("keeps its last good layer when it breaks while the app runs, and saves again once fixed", async () => {
    put(USER, JSON.stringify({ permissions: { deny: ["Bash(rm:*)"] } }));
    rt.resetSettingsCache();
    await settle();
    put(USER, BROKEN_USER);
    await rt.pollForChanges();
    expect((await rt.getMergedSettings()).permissions?.deny).toEqual(["Bash(rm:*)"]);
    await expect(rt.updateSettingsForSource("user", { model: "x" })).rejects.toBeInstanceOf(safe.UnreadableFileError);

    put(USER, JSON.stringify({ permissions: { deny: ["Bash(rm:*)", "Bash(curl:*)"] } }));
    await rt.pollForChanges();
    await rt.updateSettingsForSource("user", { model: "x" });
    expect(JSON.parse(files.get(USER)!)).toEqual({ permissions: { deny: ["Bash(rm:*)", "Bash(curl:*)"] }, model: "x" });
  });

  it("never leaves a backup inside the project", async () => {
    rt.setSettingsWorkspace(WS);
    put(LOCAL, '{ "model": "x", }');
    rt.resetSettingsCache();
    await settle();
    await expect(rt.updateSettingsForSource("local", { model: "y" })).rejects.toBeInstanceOf(safe.UnreadableFileError);
    expect(files.get(LOCAL)).toBe('{ "model": "x", }');
    expect(files.has(`${LOCAL}.bak`)).toBe(false);
  });
});

describe("a settings.json that's fine or missing", () => {
  it("is created and updated as before", async () => {
    await rt.updateSettingsForSource("user", { model: "a" });
    await rt.updateSettingsForSource("user", { outputStyle: "b" });
    expect(JSON.parse(files.get(USER)!)).toEqual({ model: "a", outputStyle: "b" });
  });
});
