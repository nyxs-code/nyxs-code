import { describe, it, expect, vi, beforeEach } from "vitest";

type Json = Record<string, unknown>;

/** A fake backend that does what `agent_edit_file` and `agent_write_file` do: refuse a stale
 *  mtime, then read, change and write the file back, with time passing in between, like the
 *  real disk. Without a queue, two edits started together interleave there. */
const disk = vi.hoisted(() => ({ files: new Map<string, { text: string; mtime: number }>(), clock: 1000 }));
const tick = () => new Promise((r) => setTimeout(r, 5));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Json) => {
    // The disk knows a file however its path is written, as the real one does.
    const path = String(args.path ?? "").replace(/\\/g, "/").toLowerCase();
    const file = disk.files.get(path);
    if (cmd === "agent_file_mtime") return file?.mtime ?? null;
    if (cmd === "agent_edit_file" || cmd === "agent_write_file" || cmd === "agent_multi_edit") {
      if (args.expectedMtime != null && file && file.mtime !== args.expectedMtime) throw new Error(`${path} changed on disk since your last read (edited outside).`);
      const read = file?.text ?? "";
      await tick();
      let text = read;
      if (cmd === "agent_write_file") text = String(args.content);
      else if (cmd === "agent_edit_file") text = read.replace(String(args.oldString), String(args.newString));
      else for (const e of args.edits as Json[]) text = text.replace(String(e.oldString), String(e.newString));
      disk.files.set(path, { text, mtime: ++disk.clock });
      return "OK";
    }
    return null;
  },
}));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@/lib/formatters", () => ({ formatAfterEdit: async () => null }));
vi.mock("@/lib/lsp", () => ({ lspConfig: () => ({ enabled: false }), isLspSupported: () => false, lspDiagnosticsForFile: async () => ({ handled: false }) }));

const { buildTools } = await import("@/lib/agentTools");
const { newToolSession } = await import("@/lib/fileStateCache");
const { fileLockKey } = await import("@/tools/fileLock");
const { resolvePath } = await import("@/tools/paths");

const WS = "C:/ws";
const FILE = "c:/ws/src/featuresettings.ts";

/** The tools of one session that has read the file, as the model would have. */
function session(read = [FILE]) {
  const s = newToolSession();
  for (const f of read) s.fileState.set(resolvePath(f, WS, []), { mtime: disk.files.get(f)!.mtime, size: 0 });
  const tools = buildTools({ workspace: WS, session: s });
  const run = (name: string, input: Json, id: string) =>
    (tools[name as keyof typeof tools].execute as unknown as (i: Json, o: Json) => Promise<string>)(input, { toolCallId: id, messages: [] });
  return run;
}

beforeEach(() => {
  disk.files.clear();
  disk.files.set(FILE, { text: "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n", mtime: disk.clock });
});

describe("parallel writes to one file", () => {
  it("applies two Edits of one step to the same file, one after the other", async () => {
    const run = session();
    const results = await Promise.all([
      run("Edit", { file_path: FILE, old_string: "export const a = 1;", new_string: "export const a = 10;" }, "e1"),
      // The same file, written another way.
      run("Edit", { file_path: "c:\\ws\\src\\..\\src\\featureSettings.ts", old_string: "export const c = 3;", new_string: "export const c = 30;" }, "e2"),
    ]);
    expect(results.every((r) => r.startsWith("OK"))).toBe(true);
    expect(disk.files.get(FILE)!.text).toBe("export const a = 10;\nexport const b = 2;\nexport const c = 30;\n");
  });

  it("queues Edit, MultiEdit and Write on one file, and leaves other files free", async () => {
    const other = "c:/ws/other.ts";
    disk.files.set(other, { text: "x\n", mtime: disk.clock });
    const run = session([FILE, other]);
    const done: string[] = [];
    const call = (name: string, input: Json, id: string) => run(name, input, id).then(() => done.push(id));
    await Promise.all([
      call("MultiEdit", { file_path: FILE, edits: [{ old_string: "b = 2", new_string: "b = 20" }] }, "m1"),
      call("Edit", { file_path: FILE, old_string: "a = 1", new_string: "a = 11" }, "e1"),
      call("Write", { file_path: other, content: "y\n" }, "w1"),
    ]);
    expect(disk.files.get(FILE)!.text).toBe("export const a = 11;\nexport const b = 20;\nexport const c = 3;\n");
    expect(disk.files.get(other)!.text).toBe("y\n");
    // The other file didn't wait behind the queue of the first.
    expect(done.indexOf("w1")).toBeLessThan(done.indexOf("e1"));
  });

  it("still refuses another session's edit made on a version it never read", async () => {
    const first = session();
    const second = session();
    const [a, b] = await Promise.all([
      first("Edit", { file_path: FILE, old_string: "a = 1", new_string: "a = 2" }, "s1"),
      second("Edit", { file_path: FILE, old_string: "c = 3", new_string: "c = 4" }, "s2"),
    ]);
    expect(a).toMatch(/^OK/);
    expect(b).toMatch(/changed on disk/);
    expect(disk.files.get(FILE)!.text).toBe("export const a = 2;\nexport const b = 2;\nexport const c = 3;\n");
  });
});

describe("fileLockKey", () => {
  it("is the same for one file however its path is written", () => {
    const key = fileLockKey("C:/Ws/src/a.ts");
    expect(fileLockKey("c:\\ws\\src\\a.ts")).toBe(key);
    expect(fileLockKey("C:/ws/./lib/../src/a.ts")).toBe(key);
    expect(fileLockKey("\\\\Server\\Share\\A.ts")).toBe(fileLockKey("//server/share/a.ts"));
    // POSIX and remote paths keep their case.
    expect(fileLockKey("/home/u/A.ts")).not.toBe(fileLockKey("/home/u/a.ts"));
    expect(fileLockKey("ssh://host/home/u/A.ts")).toBe("ssh://host/home/u/A.ts");
  });
});
