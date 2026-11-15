export interface FileRead {
  mtime: number;
  offset: number;
  limit: number | null;
  fingerprint: string;
}

export interface FileState {
  mtime: number;
  size: number;
  read?: FileRead;
}

export const READ_FILE_STATE_CACHE_SIZE = 256;
const SESSION_CACHE_COUNT = 32;

function normalizeKey(path: string): string {
  const key = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:\//.test(key) || key.startsWith("//") ? key.toLowerCase() : key;
}

export class FileStateCache {
  private map = new Map<string, FileState>();
  private maxEntries: number;

  constructor(maxEntries: number = READ_FILE_STATE_CACHE_SIZE) {
    this.maxEntries = maxEntries;
  }

  get(path: string): FileState | undefined {
    const key = normalizeKey(path);
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(path: string, state: FileState): void {
    const key = normalizeKey(path);
    this.map.delete(key);
    this.map.set(key, state);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  has(path: string): boolean {
    return this.map.has(normalizeKey(path));
  }

  delete(path: string): boolean {
    return this.map.delete(normalizeKey(path));
  }

  clear(): void {
    this.map.clear();
  }

  clone(): FileStateCache {
    const copy = new FileStateCache(this.maxEntries);
    for (const [k, v] of this.map) copy.map.set(k, { ...v });
    return copy;
  }

  get size(): number {
    return this.map.size;
  }
}

const sessions = new Map<string, FileStateCache>();

export function fileStateFor(sessionKey: string): FileStateCache {
  let cache = sessions.get(sessionKey);
  if (cache) {
    sessions.delete(sessionKey);
  } else {
    cache = new FileStateCache();
  }
  sessions.set(sessionKey, cache);
  while (sessions.size > SESSION_CACHE_COUNT) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
  return cache;
}

export function readFingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${text.length.toString(36)}:${h.toString(36)}`;
}

export interface ToolSession {
  fileState: FileStateCache;
  visibleReads: Set<string>;
  nestedInstructions?: Set<string>;
}

export function newToolSession(): ToolSession {
  return { fileState: new FileStateCache(), visibleReads: new Set() };
}
