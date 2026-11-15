import { useEffect, useRef, useSyncExternalStore } from "react";

/** The user's sessions as the chat's cards show them (a session an agent created, a message
 *  from another session): their titles, which one started which, and which are at work. The
 *  app publishes it; cards read it and open a session through openSession. */
export interface DirectoryEntry {
  id: string;
  title: string;
  parentId?: string;
  working: boolean;
}

let entries: DirectoryEntry[] = [];
const listeners = new Set<() => void>();

export function setSessionDirectory(next: DirectoryEntry[]): void {
  const same = next.length === entries.length && next.every((e, i) => {
    const p = entries[i];
    return p.id === e.id && p.title === e.title && p.parentId === e.parentId && p.working === e.working;
  });
  if (same) return;
  entries = next;
  for (const l of [...listeners]) l();
}

export function useSessionDirectory(): DirectoryEntry[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => entries,
  );
}

/** The session `parentId` created with this title (the newest, if there are several). */
export function findCreatedSession(list: DirectoryEntry[], parentId: string | undefined, title: string): DirectoryEntry | undefined {
  if (!parentId) return undefined;
  const wanted = title.trim().toLowerCase();
  return list.find((e) => e.parentId === parentId && e.title.trim().toLowerCase() === wanted);
}

export const OPEN_SESSION_EVENT = "nyxs:open-session";

/** Opens a session, as a click on it in Recents does. */
export function openSession(id: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, { detail: id }));
}

/** The app's side: publishes its sessions and opens the one a card asks for. */
export function useSessionDirectoryHost(list: DirectoryEntry[], open: (id: string) => void): void {
  useEffect(() => setSessionDirectory(list), [list]);
  const openRef = useRef(open);
  useEffect(() => { openRef.current = open; });
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (id) openRef.current(id);
    };
    window.addEventListener(OPEN_SESSION_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SESSION_EVENT, onOpen);
  }, []);
}
