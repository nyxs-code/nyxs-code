import { invoke } from "@/lib/ipc";
import { acceptHunk, computeHunks, diffStats, hunkKey, rejectHunk, type ReviewHunk } from "./hunks";

export interface ReviewRead {
  exists: boolean;
  text: string | null;
}

export interface ReviewIO {
  read(path: string): Promise<ReviewRead>;
  write(path: string, content: string | null): Promise<void>;
  save(workspace: string, chatId: string, data: string): Promise<void>;
  load(workspace: string, chatId: string): Promise<string | null>;
}

export interface ReviewFile {
  path: string;
  created: boolean;
  deleted: boolean;
  hunks: ReviewHunk[];
  added: number;
  removed: number;
}

export interface ReviewSet {
  chatId: string;
  workspace: string;
  files: ReviewFile[];
}

interface ChatReview {
  workspace: string;
  bases: Map<string, string | null>;
  snapshot: ReviewSet;
  loaded: boolean;
}

interface PersistedReview {
  files: Array<{ path: string; base: string | null }>;
}

export const tauriReviewIO: ReviewIO = {
  read: (path) => invoke<ReviewRead>("agent_review_read", { path }),
  write: (path, content) => invoke<void>("agent_review_write", { path, content }),
  save: (workspace, chatId, data) => invoke<void>("agent_review_save", { workspace, sessionId: chatId, data }),
  load: (workspace, chatId) => invoke<string | null>("agent_review_load", { workspace, sessionId: chatId }),
};

/** Deletes the review state saved for a chat (saving nothing removes the file). */
export function discardSavedReview(workspace: string, chatId: string): Promise<void> {
  return tauriReviewIO.save(workspace, chatId, "").catch(() => undefined);
}

export class ReviewStore {
  private chats = new Map<string, ChatReview>();
  private listeners = new Set<() => void>();
  private inflight = new Map<string, Promise<void>>();
  private queues = new Map<string, Promise<unknown>>();
  private io: ReviewIO;

  constructor(io: ReviewIO) {
    this.io = io;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get(chatId: string | null | undefined): ReviewSet | undefined {
    return chatId ? this.chats.get(chatId)?.snapshot : undefined;
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private chat(chatId: string, workspace: string): ChatReview {
    let c = this.chats.get(chatId);
    if (!c) {
      c = { workspace, bases: new Map(), snapshot: { chatId, workspace, files: [] }, loaded: false };
      this.chats.set(chatId, c);
    }
    return c;
  }

  private serial<T>(chatId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(chatId) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.queues.set(
      chatId,
      next.catch(() => undefined),
    );
    return next;
  }

  private async persist(chatId: string, c: ChatReview): Promise<void> {
    const files = Array.from(c.bases, ([path, base]) => ({ path, base }));
    const data: PersistedReview = { files };
    try {
      await this.io.save(c.workspace, chatId, files.length ? JSON.stringify(data) : "");
    } catch {
      return;
    }
  }

  async track(chatId: string, workspace: string, path: string): Promise<void> {
    const c = this.chat(chatId, workspace);
    if (c.bases.has(path)) return;
    const key = `${chatId}\n${path}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const task = (async () => {
      let read: ReviewRead;
      try {
        read = await this.io.read(path);
      } catch {
        return;
      }
      if (read.exists && read.text === null) return;
      if (c.bases.has(path)) return;
      c.bases.set(path, read.exists ? read.text : null);
      await this.persist(chatId, c);
    })();
    this.inflight.set(key, task);
    try {
      await task;
    } finally {
      this.inflight.delete(key);
    }
  }

  async load(chatId: string, workspace: string): Promise<void> {
    const c = this.chat(chatId, workspace);
    if (c.loaded) return this.refresh(chatId);
    c.loaded = true;
    const raw = await this.io.load(workspace, chatId).catch(() => null);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as PersistedReview;
        for (const f of parsed.files ?? []) {
          if (typeof f.path === "string" && !c.bases.has(f.path)) c.bases.set(f.path, f.base ?? null);
        }
      } catch {
        c.bases.clear();
      }
    }
    return this.refresh(chatId);
  }

  refresh(chatId: string): Promise<void> {
    return this.serial(chatId, () => this.refreshNow(chatId));
  }

  private async refreshNow(chatId: string): Promise<void> {
    const c = this.chats.get(chatId);
    if (!c) return;
    const files: ReviewFile[] = [];
    let dropped = false;
    for (const [path, base] of Array.from(c.bases)) {
      let read: ReviewRead;
      try {
        read = await this.io.read(path);
      } catch {
        continue;
      }
      if (read.exists && read.text === null) {
        c.bases.delete(path);
        dropped = true;
        continue;
      }
      const current = read.exists ? read.text : null;
      const file = buildFile(path, base, current);
      if (!file) {
        c.bases.delete(path);
        dropped = true;
        continue;
      }
      files.push(file);
    }
    c.snapshot = { chatId, workspace: c.workspace, files };
    if (dropped) await this.persist(chatId, c);
    this.emit();
  }

  private async readCurrent(path: string): Promise<string | null | undefined> {
    try {
      const read = await this.io.read(path);
      if (read.exists && read.text === null) return undefined;
      return read.exists ? read.text : null;
    } catch {
      return undefined;
    }
  }

  private findHunk(base: string | null, current: string | null, key: string): ReviewHunk | undefined {
    return computeHunks(base ?? "", current ?? "").find((h) => hunkKey(h) === key);
  }

  acceptHunk(chatId: string, path: string, hunk: ReviewHunk): Promise<boolean> {
    return this.serial(chatId, async () => {
      const c = this.chats.get(chatId);
      if (!c || !c.bases.has(path)) return false;
      const base = c.bases.get(path) ?? null;
      const current = await this.readCurrent(path);
      if (current === undefined) return false;
      const match = this.findHunk(base, current, hunkKey(hunk));
      if (!match) {
        await this.refreshNow(chatId);
        return false;
      }
      c.bases.set(path, acceptHunk(base ?? "", current ?? "", match));
      await this.persist(chatId, c);
      await this.refreshNow(chatId);
      return true;
    });
  }

  rejectHunk(chatId: string, path: string, hunk: ReviewHunk): Promise<boolean> {
    return this.serial(chatId, async () => {
      const c = this.chats.get(chatId);
      if (!c || !c.bases.has(path)) return false;
      const base = c.bases.get(path) ?? null;
      const current = await this.readCurrent(path);
      if (current === undefined) return false;
      const match = this.findHunk(base, current, hunkKey(hunk));
      if (!match) {
        await this.refreshNow(chatId);
        return false;
      }
      const next = rejectHunk(base ?? "", current ?? "", match);
      await this.io.write(path, base === null && next === "" ? null : next);
      await this.refreshNow(chatId);
      return true;
    });
  }

  acceptFile(chatId: string, path: string): Promise<void> {
    return this.acceptPaths(chatId, [path]);
  }

  rejectFile(chatId: string, path: string): Promise<void> {
    return this.rejectPaths(chatId, [path]);
  }

  acceptAll(chatId: string): Promise<void> {
    return this.acceptPaths(chatId, null);
  }

  rejectAll(chatId: string): Promise<void> {
    return this.rejectPaths(chatId, null);
  }

  private acceptPaths(chatId: string, paths: string[] | null): Promise<void> {
    return this.serial(chatId, async () => {
      const c = this.chats.get(chatId);
      if (!c) return;
      for (const path of paths ?? Array.from(c.bases.keys())) c.bases.delete(path);
      await this.persist(chatId, c);
      await this.refreshNow(chatId);
    });
  }

  private rejectPaths(chatId: string, paths: string[] | null): Promise<void> {
    return this.serial(chatId, async () => {
      const c = this.chats.get(chatId);
      if (!c) return;
      for (const path of paths ?? Array.from(c.bases.keys())) {
        if (!c.bases.has(path)) continue;
        const base = c.bases.get(path) ?? null;
        try {
          await this.io.write(path, base);
          c.bases.delete(path);
        } catch {
          continue;
        }
      }
      await this.persist(chatId, c);
      await this.refreshNow(chatId);
    });
  }

  forget(chatId: string): void {
    if (this.chats.delete(chatId)) this.emit();
  }
}

function buildFile(path: string, base: string | null, current: string | null): ReviewFile | null {
  const hunks = computeHunks(base ?? "", current ?? "");
  const created = base === null && current !== null;
  const deleted = base !== null && current === null;
  if (!hunks.length && !created && !deleted) return null;
  return { path, created, deleted, hunks, ...diffStats(hunks) };
}

export const reviewStore = new ReviewStore(tauriReviewIO);
