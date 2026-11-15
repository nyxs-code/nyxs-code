import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const files = new Map<string, string>();
/** Paths whose read fails like a locked or unreadable file on Windows. */
const failing = new Set<string>();
/** Paths that exist but don't read as text (binary, too large). */
const binary = new Set<string>();

const norm = (p: unknown) => String(p ?? "").replace(/\\/g, "/");

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    const path = norm(args.path);
    if (cmd === "agent_read_text") {
      if (failing.has(path)) throw new Error("The process cannot access the file (os error 32)");
      if (binary.has(path)) return null;
      return files.get(path) ?? null;
    }
    if (cmd === "agent_file_mtime") return files.has(path) || binary.has(path) ? 1 : null;
    if (cmd === "agent_write_file") {
      files.set(path, String(args.content));
      return "OK";
    }
    throw new Error(`unexpected command ${cmd}`);
  }),
}));

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: async () => HOME,
}));

const HOME = "C:/Users/me";
const NYXS_JSON = `${HOME}/.nyxs/nyxs.json`;
const ROUTINES = `${HOME}/.nyxs/routines.json`;

type Safe = typeof import("@/lib/safeJsonFile");
type GlobalConfig = typeof import("@/lib/globalConfig");
type Routines = typeof import("@/lib/scheduledTasks");
let safe: Safe;
let gc: GlobalConfig;
let routines: Routines;

beforeAll(async () => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, __NYXS_HOME__: HOME });
  safe = await import("@/lib/safeJsonFile");
  gc = await import("@/lib/globalConfig");
  routines = await import("@/lib/scheduledTasks");
});

beforeEach(() => {
  files.clear();
  failing.clear();
  binary.clear();
  safe.resetWriteBlocks();
  gc.resetGlobalConfigCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("readJsonFile / writeJsonFile", () => {
  it("tells a missing or empty file apart from an unreadable one", async () => {
    expect(await safe.readJsonFile("C:/x/none.json")).toEqual({ status: "missing" });
    files.set("C:/x/empty.json", "  \n");
    expect(await safe.readJsonFile("C:/x/empty.json")).toEqual({ status: "missing" });
    files.set("C:/x/ok.json", '{"a":1}');
    expect(await safe.readJsonFile("C:/x/ok.json")).toEqual({ status: "ok", value: { a: 1 } });
    files.set("C:/x/bad.json", '{"a":1,}');
    expect((await safe.readJsonFile("C:/x/bad.json")).status).toBe("unreadable");
    failing.add("C:/x/locked.json");
    expect((await safe.readJsonFile("C:/x/locked.json")).status).toBe("unreadable");
    binary.add("C:/x/bin.json");
    expect((await safe.readJsonFile("C:/x/bin.json")).status).toBe("unreadable");
  });

  it("refuses to write over a file it couldn't read, and backs up what it held", async () => {
    files.set("C:/x/bad.json", '{"keep":true,}');
    await safe.readJsonFile("C:/x/bad.json", { backup: true });
    expect(files.get("C:/x/bad.json.bak")).toBe('{"keep":true,}');
    await expect(safe.writeJsonFile("C:\\X\\bad.json", {})).rejects.toBeInstanceOf(safe.UnreadableFileError);
    expect(files.get("C:/x/bad.json")).toBe('{"keep":true,}');
    // Once fixed and read again, saving works.
    files.set("C:/x/bad.json", '{"keep":true}');
    await safe.readJsonFile("C:/x/bad.json");
    await safe.writeJsonFile("C:/x/bad.json", { keep: false });
    expect(JSON.parse(files.get("C:/x/bad.json")!)).toEqual({ keep: false });
  });

  it("tells the user when it refuses to save, naming the copy only when there is one", async () => {
    const notices = await import("@/lib/fileNotices");
    files.set("C:/x/bad.json", "{,}");
    await safe.readJsonFile("C:/x/bad.json", { backup: true });
    await safe.writeJsonFile("C:/x/bad.json", {}).catch(() => undefined);
    expect(notices.currentFileNotice()).toEqual({
      kind: "unreadableFile",
      file: "C:/x/bad.json",
      folder: "C:/x",
      backup: "C:/x/bad.json.bak",
    });
    failing.add("C:/x/locked.json");
    await safe.readJsonFile("C:/x/locked.json", { backup: true });
    await safe.writeJsonFile("C:/x/locked.json", {}).catch(() => undefined);
    expect(notices.currentFileNotice()).toMatchObject({ file: "C:/x/locked.json", backup: null });
    notices.dismissFileNotice();
  });

  it("makes no backup unless asked", async () => {
    files.set("E:/proj/.nyxs/settings.json", "{ // comment\n}");
    await safe.readJsonFile("E:/proj/.nyxs/settings.json");
    expect(files.has("E:/proj/.nyxs/settings.json.bak")).toBe(false);
  });
});

describe("nyxs.json", () => {
  it("keeps trusted projects when the file has a stray comma", async () => {
    const original = '{ "version": 1, "projects": { "E:/repo": { "trusted": true } }, }';
    files.set(NYXS_JSON, original);
    await gc.bumpStartupCount();
    await gc.trustWorkspace("E:/other");
    expect(files.get(NYXS_JSON)).toBe(original);
    expect(files.get(`${NYXS_JSON}.bak`)).toBe(original);
    // The run itself still works from memory.
    expect(await gc.isWorkspaceTrusted("E:/other")).toBe(true);
    const { currentFileNotice, dismissFileNotice } = await import("@/lib/fileNotices");
    expect(currentFileNotice()).toMatchObject({ kind: "unreadableFile", file: NYXS_JSON, backup: `${NYXS_JSON}.bak` });
    dismissFileNotice();
    // nyxs.json is saved on its own often: once dismissed, the notice doesn't come back this run.
    await gc.setLastSessionId("E:/repo", "s2");
    expect(currentFileNotice()).toBeNull();
    expect(files.get(NYXS_JSON)).toBe(original);
  });

  it("isn't overwritten when reading it fails for a moment", async () => {
    files.set(NYXS_JSON, '{"version":1,"projects":{"E:/repo":{"trusted":true}}}');
    failing.add(NYXS_JSON);
    await gc.markChangelogSeen("1.0.0");
    expect(JSON.parse(files.get(NYXS_JSON)!).projects["E:/repo"].trusted).toBe(true);
  });

  it("is created when missing", async () => {
    await gc.trustWorkspace("E:/repo");
    expect(JSON.parse(files.get(NYXS_JSON)!).projects["E:/repo"].trusted).toBe(true);
  });
});

describe("routines.json", () => {
  it("doesn't lose the routines when the file can't be parsed", async () => {
    const original = '{"teams":[],"tasks":[{"id":"t1","name":"Daily","prompt":"x","cron":"0 9 * * *","enabled":true,"createdAt":1}]';
    files.set(ROUTINES, original);
    const data = await routines.loadRoutines();
    expect(data.tasks).toEqual([]);
    await expect(routines.saveRoutines(data)).rejects.toBeInstanceOf(safe.UnreadableFileError);
    expect(files.get(ROUTINES)).toBe(original);
    expect(files.get(`${ROUTINES}.bak`)).toBe(original);
  });

  it("saves normally after a good read", async () => {
    files.set(ROUTINES, '{"teams":[],"tasks":[]}');
    const data = await routines.loadRoutines();
    await routines.saveRoutines({ ...data, teams: [{ id: "a", name: "A", members: [] }] });
    expect(JSON.parse(files.get(ROUTINES)!).teams).toHaveLength(1);
  });
});
