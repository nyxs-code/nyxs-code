import { beforeEach, describe, expect, it } from "vitest";
import { ReviewStore, type ReviewIO } from "@/lib/review/store";
import { displayPath } from "@/lib/review/paths";

class MemoryIO implements ReviewIO {
  files = new Map<string, string>();
  binary = new Set<string>();
  saved = new Map<string, string>();

  async read(path: string) {
    if (this.binary.has(path)) return { exists: true, text: null };
    const text = this.files.get(path);
    return text === undefined ? { exists: false, text: null } : { exists: true, text };
  }

  async write(path: string, content: string | null) {
    if (content === null) this.files.delete(path);
    else this.files.set(path, content);
  }

  async save(workspace: string, chatId: string, data: string) {
    if (data) this.saved.set(`${workspace}|${chatId}`, data);
    else this.saved.delete(`${workspace}|${chatId}`);
  }

  async load(workspace: string, chatId: string) {
    return this.saved.get(`${workspace}|${chatId}`) ?? null;
  }
}

const WS = "/ws";
const CHAT = "chat-1";
const twenty = Array.from({ length: 20 }, (_, i) => `l${i + 1}\n`).join("");

describe("ReviewStore", () => {
  let io: MemoryIO;
  let store: ReviewStore;

  beforeEach(() => {
    io = new MemoryIO();
    store = new ReviewStore(io);
  });

  async function agentWrite(path: string, content: string) {
    await store.track(CHAT, WS, path);
    io.files.set(path, content);
  }

  it("captures the original before the first edit and keeps it across later edits", async () => {
    io.files.set("/ws/a.ts", "one\ntwo\n");
    await agentWrite("/ws/a.ts", "one\nTWO\n");
    await agentWrite("/ws/a.ts", "ONE\nTWO\n");
    await store.refresh(CHAT);
    const file = store.get(CHAT)!.files[0];
    expect(file).toMatchObject({ path: "/ws/a.ts", created: false, added: 2, removed: 2 });
  });

  it("rejects a single hunk by rewriting the file", async () => {
    io.files.set("/ws/a.ts", twenty);
    await agentWrite("/ws/a.ts", twenty.replace("l2\n", "X\n").replace("l18\n", "Y\n"));
    await store.refresh(CHAT);
    const [first] = store.get(CHAT)!.files[0].hunks;
    expect(await store.rejectHunk(CHAT, "/ws/a.ts", first)).toBe(true);
    expect(io.files.get("/ws/a.ts")).toBe(twenty.replace("l18\n", "Y\n"));
    expect(store.get(CHAT)!.files[0].hunks).toHaveLength(1);
  });

  it("accepting the last hunk resolves the file", async () => {
    io.files.set("/ws/a.ts", "a\nb\n");
    await agentWrite("/ws/a.ts", "a\nB\n");
    await store.refresh(CHAT);
    const [only] = store.get(CHAT)!.files[0].hunks;
    expect(await store.acceptHunk(CHAT, "/ws/a.ts", only)).toBe(true);
    expect(store.get(CHAT)!.files).toEqual([]);
    expect(io.files.get("/ws/a.ts")).toBe("a\nB\n");
    expect(io.saved.size).toBe(0);
  });

  it("refuses a stale hunk when the file changed underneath", async () => {
    io.files.set("/ws/a.ts", "a\nb\n");
    await agentWrite("/ws/a.ts", "a\nB\n");
    await store.refresh(CHAT);
    const [hunk] = store.get(CHAT)!.files[0].hunks;
    io.files.set("/ws/a.ts", "a\nC\n");
    expect(await store.rejectHunk(CHAT, "/ws/a.ts", hunk)).toBe(false);
    expect(io.files.get("/ws/a.ts")).toBe("a\nC\n");
    expect(store.get(CHAT)!.files[0].hunks[0].lines.some((l) => l.text === "C")).toBe(true);
  });

  it("rejecting a created file deletes it", async () => {
    await agentWrite("/ws/new.ts", "fresh\n");
    await store.refresh(CHAT);
    expect(store.get(CHAT)!.files[0]).toMatchObject({ created: true, added: 1 });
    await store.rejectFile(CHAT, "/ws/new.ts");
    expect(io.files.has("/ws/new.ts")).toBe(false);
    expect(store.get(CHAT)!.files).toEqual([]);
  });

  it("rejecting every hunk of a created file deletes it too", async () => {
    await agentWrite("/ws/new.ts", "fresh\n");
    await store.refresh(CHAT);
    const [hunk] = store.get(CHAT)!.files[0].hunks;
    await store.rejectHunk(CHAT, "/ws/new.ts", hunk);
    expect(io.files.has("/ws/new.ts")).toBe(false);
  });

  it("accept all and reject all", async () => {
    io.files.set("/ws/a.ts", "a\n");
    io.files.set("/ws/b.ts", "b\n");
    await agentWrite("/ws/a.ts", "A\n");
    await agentWrite("/ws/b.ts", "B\n");
    await store.refresh(CHAT);
    expect(store.get(CHAT)!.files).toHaveLength(2);
    await store.rejectAll(CHAT);
    expect(io.files.get("/ws/a.ts")).toBe("a\n");
    expect(io.files.get("/ws/b.ts")).toBe("b\n");
    await agentWrite("/ws/a.ts", "A2\n");
    await store.acceptAll(CHAT);
    expect(io.files.get("/ws/a.ts")).toBe("A2\n");
    expect(store.get(CHAT)!.files).toEqual([]);
  });

  it("skips binary files", async () => {
    io.binary.add("/ws/img.png");
    await store.track(CHAT, WS, "/ws/img.png");
    await store.refresh(CHAT);
    expect(store.get(CHAT)!.files).toEqual([]);
  });

  it("persists pending bases and restores them in a new session", async () => {
    io.files.set("/ws/a.ts", "a\nb\n");
    await agentWrite("/ws/a.ts", "a\nB\n");
    const restored = new ReviewStore(io);
    await restored.load(CHAT, WS);
    expect(restored.get(CHAT)!.files[0]).toMatchObject({ path: "/ws/a.ts", added: 1, removed: 1 });
  });

  it("notifies subscribers on changes", async () => {
    let calls = 0;
    const unsub = store.subscribe(() => calls++);
    io.files.set("/ws/a.ts", "a\n");
    await agentWrite("/ws/a.ts", "A\n");
    await store.refresh(CHAT);
    unsub();
    expect(calls).toBeGreaterThan(0);
  });
});

describe("displayPath", () => {
  it("shows paths relative to the workspace", () => {
    expect(displayPath("C:\\proj\\src\\a.ts", "C:\\proj")).toBe("src/a.ts");
    expect(displayPath("c:/Proj/src/a.ts", "C:\\proj\\")).toBe("src/a.ts");
    expect(displayPath("/other/a.ts", "/proj")).toBe("/other/a.ts");
  });
});
