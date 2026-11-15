import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "@/lib/chatStore";

const fake = vi.hoisted(() => ({
  transcript: "",
  meta: "",
  /** `nyxs_session_read` reports a file another process holds open. */
  readFails: false,
  /** Where the session's files are. */
  dir: "C:/Users/me/.nyxs/projects/E--repo" as string | null,
  writes: [] as string[],
  /** The read commands asked for, in order. */
  reads: [] as string[],
}));

vi.mock("@/lib/ipc", () => ({
  invoke: async (cmd: string, a: { json?: string; content?: string }) => {
    if (cmd === "nyxs_session_read" || cmd === "nyxs_session_read_meta") {
      fake.reads.push(cmd);
      const transcript = cmd === "nyxs_session_read" ? fake.transcript : "";
      if (fake.readFails) {
        return { transcript: "", meta: "", error: "Couldn't read the session: The process cannot access the file (os error 32)", dir: fake.dir };
      }
      return { transcript, meta: fake.meta, error: null, dir: fake.dir };
    }
    if (cmd === "nyxs_session_write_meta") {
      fake.writes.push("meta");
      fake.meta = String(a.json);
      return null;
    }
    if (cmd === "nyxs_session_write_transcript") {
      fake.writes.push("transcript");
      fake.transcript = String(a.content);
      return null;
    }
    throw new Error(`unexpected command ${cmd}`);
  },
}));

type Storage = typeof import("@/lib/sessionStorage");
let storage: Storage;

const META = JSON.stringify({ title: "PR", createdAt: 5, updatedAt: 6, archived: true, prs: [{ number: 7 }], prBranch: "feat/x" });
const chat: Chat = { id: "s1", title: "PR", messages: [{ id: "m1", role: "user", content: "hola" } as Chat["messages"][number]] };

beforeAll(async () => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  storage = await import("@/lib/sessionStorage");
});

beforeEach(() => {
  fake.transcript = "";
  fake.meta = "";
  fake.readFails = false;
  fake.dir = "C:/Users/me/.nyxs/projects/E--repo";
  fake.writes = [];
  fake.reads = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("sessions that can't be read", () => {
  it("open as an error, not as an empty session", async () => {
    fake.transcript = '{"id":"m1","role":"user","content":"hola"}\n';
    fake.readFails = true;
    await expect(storage.readSession("E:/repo", "s1")).rejects.toBeTruthy();
    const { currentFileNotice, dismissFileNotice } = await import("@/lib/fileNotices");
    expect(currentFileNotice()).toEqual({ kind: "unreadableSession", folder: fake.dir });
    dismissFileNotice();
  });

  it("on another machine, say so without a folder to open", async () => {
    fake.readFails = true;
    fake.dir = null;
    await expect(storage.readSession("ssh://box/home/me/repo", "s1")).rejects.toBeTruthy();
    const { currentFileNotice, dismissFileNotice } = await import("@/lib/fileNotices");
    expect(currentFileNotice()).toEqual({ kind: "unreadableSession", folder: null });
    dismissFileNotice();
  });

  it("keep their meta when it can't be read while saving", async () => {
    fake.meta = META;
    fake.readFails = true;
    await storage.saveSession("E:/repo", chat, 100);
    expect(fake.writes).not.toContain("meta");
    expect(fake.meta).toBe(META);
  });

  it("keep their meta when it isn't valid JSON", async () => {
    const broken = META.slice(0, -1);
    fake.meta = broken;
    await storage.saveSession("E:/repo", chat, 100);
    expect(fake.writes).not.toContain("meta");
    expect(fake.meta).toBe(broken);
  });

  it("still save normally, keeping archived, PRs and createdAt", async () => {
    fake.meta = META;
    await storage.saveSession("E:/repo", chat, 100);
    const saved = JSON.parse(fake.meta) as Record<string, unknown>;
    expect(saved).toMatchObject({ archived: true, prs: [{ number: 7 }], prBranch: "feat/x", createdAt: 5, updatedAt: 100 });
  });

  it("read only the meta to save it, not the whole transcript", async () => {
    fake.meta = META;
    fake.transcript = '{"id":"m1","role":"user","content":"hola"}\n';
    await storage.saveSession("E:/repo", chat, 100);
    await storage.renameSession("E:/repo", "s1", "Otro");
    expect(fake.reads).toEqual(["nyxs_session_read_meta", "nyxs_session_read_meta"]);
  });

  it("leave old screenshots out of the saved transcript", async () => {
    const jpeg = "J".repeat(1000);
    const turn = (n: number) =>
      ({
        id: `a${n}`,
        role: "assistant",
        content: "",
        responseMessages: [{ role: "tool", content: [{ type: "tool-result", toolCallId: `c${n}`, toolName: "Computer", output: { type: "content", value: [{ type: "image-data", data: jpeg, mediaType: "image/jpeg" }] } }] }],
      }) as Chat["messages"][number];
    await storage.saveSession("E:/repo", { ...chat, messages: [0, 1, 2, 3, 4].map(turn) }, 100);
    expect(fake.transcript.split(jpeg).length - 1).toBe(3);
  });

  it("start a meta for a session that has none", async () => {
    await storage.saveSession("E:/repo", chat, 100);
    expect(JSON.parse(fake.meta)).toMatchObject({ title: "PR", createdAt: 100 });
  });
});
