import { useEffect, useMemo } from "react";
import type { Chat } from "@/lib/chatStore";
import { setLspFoldersInUse } from "@/lib/lsp";

/** The folder a chat's turns work in: its worktree, else its project. */
const dirOf = (c: Chat) => c.worktree?.path ?? c.workspace ?? null;

/** Keeps LSP servers up for the folders in use (the open one, the open chat's, and those of the
 *  chats with a turn running) and closes the others' (see setLspFoldersInUse). */
export function useLspFoldersInUse(
  workspace: string | null,
  chats: readonly Chat[],
  activeId: string | null,
  streamingIds: ReadonlySet<string>,
): void {
  // A string, so the effect runs when the folders change, not on every streamed token.
  const folders = useMemo(() => {
    const active = chats.find((c) => c.id === activeId);
    const running = chats.filter((c) => streamingIds.has(c.id)).map(dirOf);
    return JSON.stringify([workspace, active ? dirOf(active) : null, ...running]);
  }, [workspace, chats, activeId, streamingIds]);
  useEffect(() => setLspFoldersInUse(JSON.parse(folders) as (string | null)[]), [folders]);
}
