import { invoke } from "@/lib/ipc";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface SessionSnippet {
  role: string;
  text: string;
  matchStart: number;
  matchLen: number;
}

export interface SessionSearchHit {
  workspace: string;
  sessionId: string;
  title: string;
  modifiedAt: number;
  matches: number;
  titleMatch: boolean;
  snippets: SessionSnippet[];
}

interface RawHit extends Omit<SessionSearchHit, "title"> {
  meta: string;
}

function titleFromMeta(meta: string): string {
  if (!meta.trim()) return "";
  try {
    const parsed = JSON.parse(meta) as { title?: unknown };
    return typeof parsed.title === "string" ? parsed.title : "";
  } catch {
    return "";
  }
}

export async function searchSessions(
  workspaces: Iterable<string | null>,
  query: string,
  limit = 50,
): Promise<SessionSearchHit[]> {
  const trimmed = query.trim();
  if (!isTauri || !trimmed) return [];
  const list = Array.from(new Set(Array.from(workspaces).filter((w): w is string => !!w)));
  if (list.length === 0) return [];
  const raw = await invoke<RawHit[]>("nyxs_search_sessions", { workspaces: list, query: trimmed, limit });
  return raw.map(({ meta, ...hit }) => ({ ...hit, title: titleFromMeta(meta) }));
}

export function splitSnippet(snippet: SessionSnippet): [string, string, string] {
  const chars = Array.from(snippet.text);
  const end = snippet.matchStart + snippet.matchLen;
  return [
    chars.slice(0, snippet.matchStart).join(""),
    chars.slice(snippet.matchStart, end).join(""),
    chars.slice(end).join(""),
  ];
}
