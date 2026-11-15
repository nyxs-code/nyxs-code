import { useSyncExternalStore } from "react";
import { accountKey } from "./accountScope";

/** A page saved to the built-in browser's bookmarks bar. */
export interface Bookmark {
  url: string;
  title: string;
  /** The page's icon (a data URL or an address), or "" for none. */
  icon: string;
}

const STORAGE_KEY = "nyxs.browserBookmarks.v1";
const EMPTY: Bookmark[] = [];
const listeners = new Set<() => void>();
let cache: { key: string; list: Bookmark[] } | null = null;

/** The same page however its address was typed: no trailing slash, no fragment. */
export function sameBookmarkUrl(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

function read(): Bookmark[] {
  // Each Nyxs account has its own bookmarks, like its chats.
  const key = accountKey(STORAGE_KEY);
  if (cache?.key === key) return cache.list;
  let list: Bookmark[] = EMPTY;
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "[]") as unknown;
    if (Array.isArray(parsed)) {
      list = parsed.filter((b): b is Bookmark => !!b && typeof b.url === "string" && typeof b.title === "string").map((b) => ({ ...b, icon: typeof b.icon === "string" ? b.icon : "" }));
    }
  } catch {
    /* unreadable: no bookmarks */
  }
  cache = { key, list };
  return list;
}

function write(list: Bookmark[]) {
  const key = accountKey(STORAGE_KEY);
  cache = { key, list };
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* storage full: this run still has them */
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another window (or tab of the app) saved some.
  const onStorage = (e: StorageEvent) => {
    if (e.key === accountKey(STORAGE_KEY)) {
      cache = null;
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The bookmarks, in the order they were added; every tab sees the same list. */
export function useBookmarks(): Bookmark[] {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

export function isBookmarked(list: Bookmark[], url: string): boolean {
  return list.some((b) => sameBookmarkUrl(b.url, url));
}

export function addBookmark(bookmark: Bookmark) {
  const list = read();
  if (isBookmarked(list, bookmark.url)) return;
  write([...list, bookmark]);
}

export function removeBookmark(url: string) {
  write(read().filter((b) => !sameBookmarkUrl(b.url, url)));
}
