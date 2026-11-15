import { resolveObjectURL } from "node:buffer";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { ModHost, type ModIo, type SessionInfo } from "../host";
import { ModWorker } from "../modWorker";
import type { ModRef } from "../compile";

/**
 * A Worker for Node: runs the blob's script in a context of its own with `postMessage` and
 * `onmessage`, as a dedicated Worker would, so tests run mods through the real runtime.
 */
class NodeWorker {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: { message: string }) => void) | null = null;
  private ctx: vm.Context;
  private dead = false;

  constructor(url: string) {
    const blob = resolveObjectURL(url);
    const sandbox: Record<string, unknown> = {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      AbortController,
      Promise,
      console,
      postMessage: (data: unknown) => queueMicrotask(() => !this.dead && this.onmessage?.({ data: structuredClone(data) })),
    };
    this.ctx = vm.createContext(sandbox);
    void blob!.text().then((script) => {
      try {
        vm.runInContext(script, this.ctx, { filename: "mod-worker.js" });
      } catch (e) {
        this.onerror?.({ message: e instanceof Error ? e.message : String(e) });
      }
    });
  }

  postMessage(data: unknown): void {
    const clone = structuredClone(data);
    queueMicrotask(() => {
      if (this.dead) return;
      const handler = (this.ctx as { onmessage?: (m: { data: unknown }) => void }).onmessage;
      handler?.({ data: clone });
    });
  }

  terminate(): void {
    this.dead = true;
  }
}

export function installNodeWorker(): void {
  (globalThis as { Worker?: unknown }).Worker = NodeWorker;
}

export interface Harness {
  host: ModHost;
  stores: Map<string, Record<string, unknown>>;
  info: SessionInfo;
}

/** A host over in-memory files (`files`: absolute path → text) or the disk, with these mods. */
export function makeHost(o: { mods: ModRef[]; devMods?: ModRef[]; files?: Record<string, string>; info?: Partial<SessionInfo>; exists?: (p: string) => boolean }): Harness {
  installNodeWorker();
  const stores = new Map<string, Record<string, unknown>>();
  const info: SessionInfo = { chatId: "chat-1", workspace: "/proj", cwd: "/proj", model: "m", turns: 1, ...o.info };
  const io: ModIo = {
    readText: async (path) => {
      if (o.files) return o.files[path.replace(/\\/g, "/")] ?? null;
      try {
        return await readFile(path, "utf8");
      } catch {
        return null;
      }
    },
    stat: async (path) => {
      if (o.exists?.(path)) return { kind: "dir", size: 0, mtimeMs: 0, isLink: false, realPath: path };
      throw new Error(`${path}: not found`);
    },
    exists: async (path) => !!o.exists?.(path),
    list: async () => [],
    installedMods: async () => o.mods,
    devMods: async () => o.devMods ?? [],
    makeWorker: (plugin, script, onCall) => new ModWorker(plugin, script, onCall),
    loadStore: (plugin) => ({ ...(stores.get(plugin) ?? {}) }),
    saveStore: (plugin, data) => void stores.set(plugin, { ...data }),
    isReservedCommand: (name) => name === "clear",
    loadConsent: () => ({}),
    saveConsent: () => {},
  };
  return { host: new ModHost(io, () => info), stores, info };
}
