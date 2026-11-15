import { useSyncExternalStore } from "react";
import { accountKey } from "@/lib/accountScope";

/**
 * What the user marks on sessions from the sidebar: pinned ones (on top of Recents), unread ones
 * (a dot until opened) and their own sections, each a named list of sessions. Kept per account in
 * this PC's storage: they order the list, they aren't part of the session.
 */
export interface SessionSection {
  id: string;
  name: string;
  /** Its sessions, in the order they were put in. */
  ids: string[];
}

export interface SessionMarks {
  pinned: string[];
  unread: string[];
  sections: SessionSection[];
}

const KEY = "nyxs.sessionMarks.v1";
const EMPTY: SessionMarks = { pinned: [], unread: [], sections: [] };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

function load(): SessionMarks {
  try {
    const raw = JSON.parse(localStorage.getItem(accountKey(KEY)) || "{}") as Partial<Record<keyof SessionMarks, unknown>>;
    const sections = Array.isArray(raw.sections)
      ? raw.sections
          .filter((s): s is SessionSection => !!s && typeof s === "object" && typeof (s as SessionSection).id === "string" && typeof (s as SessionSection).name === "string")
          .map((s) => ({ id: s.id, name: s.name, ids: strings(s.ids) }))
      : [];
    return { pinned: strings(raw.pinned), unread: strings(raw.unread), sections };
  } catch {
    return EMPTY;
  }
}

let marks: SessionMarks | null = null;
const listeners = new Set<() => void>();

export function sessionMarks(): SessionMarks {
  marks ??= load();
  return marks;
}

function update(fn: (m: SessionMarks) => SessionMarks): void {
  marks = fn(sessionMarks());
  try {
    localStorage.setItem(accountKey(KEY), JSON.stringify(marks));
  } catch {
    // Storage full or unavailable: the marks hold until the app closes.
  }
  listeners.forEach((l) => l());
}

export function useSessionMarks(): SessionMarks {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    sessionMarks,
  );
}

const without = (list: string[], ids: string[]) => list.filter((x) => !ids.includes(x));

export function setPinned(id: string, on: boolean): void {
  update((m) => ({ ...m, pinned: on ? [id, ...without(m.pinned, [id])] : without(m.pinned, [id]) }));
}

export function setUnread(id: string, on: boolean): void {
  const has = sessionMarks().unread.includes(id);
  if (has === on) return;
  update((m) => ({ ...m, unread: on ? [...m.unread, id] : without(m.unread, [id]) }));
}

/** Puts the sessions in a section (out of any other), or with null takes them out of theirs. */
export function moveToSection(ids: string[], sectionId: string | null): void {
  update((m) => ({
    ...m,
    sections: m.sections.map((s) => (s.id === sectionId ? { ...s, ids: [...without(s.ids, ids), ...ids] } : { ...s, ids: without(s.ids, ids) })),
  }));
}

/** A new section holding these sessions; its id. */
export function createSection(name: string, ids: string[] = []): string {
  const id = `section-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  update((m) => ({
    ...m,
    sections: [...m.sections.map((s) => ({ ...s, ids: without(s.ids, ids) })), { id, name: name.trim(), ids }],
  }));
  return id;
}

export function renameSection(id: string, name: string): void {
  if (!name.trim()) return;
  update((m) => ({ ...m, sections: m.sections.map((s) => (s.id === id ? { ...s, name: name.trim() } : s)) }));
}

/** Removes a section; its sessions go back to their projects. */
export function deleteSection(id: string): void {
  update((m) => ({ ...m, sections: m.sections.filter((s) => s.id !== id) }));
}

/** Deleted sessions leave no marks behind. */
export function forgetSessions(ids: string[]): void {
  const m = sessionMarks();
  if (!ids.some((id) => m.pinned.includes(id) || m.unread.includes(id) || m.sections.some((s) => s.ids.includes(id)))) return;
  update((cur) => ({
    pinned: without(cur.pinned, ids),
    unread: without(cur.unread, ids),
    sections: cur.sections.map((s) => ({ ...s, ids: without(s.ids, ids) })),
  }));
}

/** A session that got a new id (moved to another project) keeps its marks. */
export function carryMarks(from: string, to: string): void {
  const swap = (list: string[]) => list.map((x) => (x === from ? to : x));
  update((m) => ({ pinned: swap(m.pinned), unread: swap(m.unread), sections: m.sections.map((s) => ({ ...s, ids: swap(s.ids) })) }));
}

/** Tests start from no marks. */
export function resetSessionMarksForTests(): void {
  marks = null;
}
