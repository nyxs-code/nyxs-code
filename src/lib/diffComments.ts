import { useSyncExternalStore } from "react";
import { VISUAL_PROMPT_EVENT } from "@/lib/visualBridge";

/** A note on one line of the diff panel, waiting to go to the agent with the others (like
 *  Claude Code Desktop: comment on lines, then Ctrl+Enter sends them all). */
export interface DiffComment {
  id: string;
  path: string;
  /** Which version the line number is in: "old" for a removed line. */
  side: "old" | "new";
  line: number;
  /** The line as shown, so the agent sees what the comment is about. */
  code: string;
  text: string;
}

/** Asks the app to open the changes panel, at a file when one is given (detail: its path). */
export const OPEN_DIFF_EVENT = "nyxs:open-diff";
export const openDiff = (path?: string) => window.dispatchEvent(new CustomEvent<string | undefined>(OPEN_DIFF_EVENT, { detail: path }));

const byWorkspace = new Map<string, DiffComment[]>();
const listeners = new Set<() => void>();
const EMPTY: DiffComment[] = [];
const emit = () => listeners.forEach((l) => l());

const set = (workspace: string, list: DiffComment[]) => {
  if (list.length) byWorkspace.set(workspace, list);
  else byWorkspace.delete(workspace);
  emit();
};

export const diffComments = (workspace: string): DiffComment[] => byWorkspace.get(workspace) ?? EMPTY;

export function addDiffComment(workspace: string, c: Omit<DiffComment, "id">): void {
  set(workspace, [...diffComments(workspace), { ...c, id: Math.random().toString(36).slice(2, 10) }]);
}

export function updateDiffComment(workspace: string, id: string, text: string): void {
  set(workspace, diffComments(workspace).map((c) => (c.id === id ? { ...c, text } : c)));
}

export function removeDiffComment(workspace: string, id: string): void {
  set(workspace, diffComments(workspace).filter((c) => c.id !== id));
}

export function clearDiffComments(workspace: string): void {
  set(workspace, []);
}

export function useDiffComments(workspace: string | null): DiffComment[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (workspace ? diffComments(workspace) : EMPTY),
  );
}

/** Sends every comment on the workspace's diff to the agent as one message, then clears them.
 *  It goes like a message the user typed (queued while the agent works). */
export function sendDiffReview(workspace: string, labels: { intro: string; removedLine: string }): boolean {
  const list = diffComments(workspace);
  if (!list.length) return false;
  window.dispatchEvent(new CustomEvent<string>(VISUAL_PROMPT_EVENT, { detail: formatDiffReview(list, labels) }));
  clearDiffComments(workspace);
  return true;
}

/** The comments as one message for the agent: each with its file and line (clickable in the
 *  chat), the line it's about, and what the user wrote. In file order, then line order. */
export function formatDiffReview(comments: DiffComment[], labels: { intro: string; removedLine: string }): string {
  const sorted = [...comments].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  const parts = sorted.map((c) => {
    const where = `\`${c.path}:${c.line}\`${c.side === "old" ? ` ${labels.removedLine}` : ""}`;
    const code = c.code.trim() ? `\n> ${c.code.trim()}` : "";
    return `${where}${code}\n${c.text.trim()}`;
  });
  return `${labels.intro}\n\n${parts.join("\n\n")}`;
}
