import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ViewId } from "@/components/ViewsPanel";
import { OPEN_IN_BROWSER_EVENT } from "@/lib/openExternal";
import { OPEN_PREVIEW_EVENT, setPreviewSlots } from "@/lib/previewControl";
import { OPEN_FILE_EVENT } from "@/lib/filePaths";
import { OPEN_VIDEO_EVENT, type VideoOpenRequest } from "@/lib/video/videoOpen";
import { EDIT_VIDEO_FILE_EVENT } from "@/components/video/editVideoFile";
import { setVideoChatContext } from "@/lib/video/videoControl";
import { loadReloadState, reloadStateEntries, saveReloadState } from "@/lib/reloadState";

export interface ChatViews {
  open: boolean;
  /** The views laid out side by side in the panel, in the order they were opened. */
  views: ViewId[];
  previewFile: string;
  slot: string;
  previewStarted: boolean;
  usedAt: number;
  workspace: string | null;
}

/** The views of a chat not created yet; they pass to the chat when its first message makes it. */
const DRAFT_VIEWS = "__draft__";

const MAX_LIVE_PREVIEWS = 4;

const MAX_PANES = 4;

/** Shows a view beside the ones already open; past MAX_PANES the oldest makes room. A hidden
 *  panel comes back with just that view. */
export function withView(cur: ChatViews, v: ViewId): Partial<ChatViews> {
  if (!cur.open) return { open: true, views: [v] };
  if (cur.views.includes(v)) return {};
  return { views: [...cur.views, v].slice(-MAX_PANES) };
}

export function withoutView(cur: ChatViews, v: ViewId): Partial<ChatViews> {
  const rest = cur.views.filter((x) => x !== v);
  return rest.length ? { views: rest } : { open: false };
}

export function toggledView(cur: ChatViews, v: ViewId): Partial<ChatViews> {
  return cur.open && cur.views.includes(v) ? withoutView(cur, v) : withView(cur, v);
}

/** The project a chat's panel belongs to: the chat's own folder, and the open project only for
 *  a chat not created yet. Switching projects changes the project and the chat in two steps;
 *  in between, the open project would hand the previous chat's browser to the new project, and
 *  it would close its page or open another project's server. */
export function chatViewsWorkspace(
  chats: { id: string; workspace?: string | null; worktree?: { path: string } }[],
  activeId: string | null,
  workspace: string | null,
): string | null {
  const chat = activeId ? chats.find((c) => c.id === activeId) : undefined;
  // A session with its own worktree shows that copy: its files, servers and terminal.
  if (chat?.worktree?.path) return chat.worktree.path;
  // Chats saved before they recorded their folder fall back to the open project, as before.
  return chat && chat.workspace !== undefined ? chat.workspace : workspace;
}

let viewSlotSeq = 0;
const slotNumber = (slot: string) => Number(/^views-(\d+)$/.exec(slot)?.[1]) || 0;
/** A slot no chat holds. Two chats on one slot share one browser (the same tabs and native
 *  pages), so each switch between them closed the page of the other; the counter alone isn't
 *  enough, as a hot reload of this module starts it over while the chats keep theirs. */
function nextSlot(taken: Record<string, ChatViews>): string {
  catchUpSlots(taken);
  return `views-${++viewSlotSeq}`;
}

function catchUpSlots(taken: Record<string, ChatViews>): void {
  for (const v of Object.values(taken)) viewSlotSeq = Math.max(viewSlotSeq, slotNumber(v.slot));
  // A deleted chat's browser leaves its tabs saved for a reload: a new chat on that slot would
  // come up with the other chat's pages.
  for (const [key] of reloadStateEntries("browser:")) viewSlotSeq = Math.max(viewSlotSeq, slotNumber(key.slice("browser:".length)));
}

const freshChatViews = (taken: Record<string, ChatViews>): ChatViews => ({
  open: false,
  views: ["preview"],
  previewFile: "",
  slot: nextSlot(taken),
  previewStarted: false,
  usedAt: 0,
  workspace: null,
});

/** The panels each chat had open before the app's page reloaded, so the browser, terminal and
 *  other views come back as they were (their native pages and shells kept running). */
export function restoreChatViews(): Record<string, ChatViews> {
  const saved = loadReloadState<Record<string, ChatViews>>("views") ?? {};
  const seen = new Set<string>();
  for (const v of Object.values(saved)) {
    // Saved before the panel could hold several views.
    if (!Array.isArray(v.views)) v.views = [(v as { view?: ViewId }).view ?? "preview"];
    // A view that no longer exists would come back as an empty pane, and the side chat's
    // conversation lives in memory: after a reload it would come back empty.
    v.views = v.views.filter((id) => (id as string) !== "music" && id !== "sidechat");
    if (!v.views.length) {
      v.views = ["preview"];
      v.open = false;
    }
    // Saved while two chats shared a slot: the second gets a browser of its own.
    if (seen.has(v.slot)) v.slot = nextSlot(saved);
    seen.add(v.slot);
  }
  catchUpSlots(saved);
  return saved;
}

/** The side panel of each chat: which views it shows, the file or address in its browser, and
 *  which chats keep a live preview in the background. */
export function useChatViews(activeId: string | null, workspace: string | null, workspaceOf: (chatId: string) => string | null) {
  const [viewsByChat, setViewsByChat] = useState<Record<string, ChatViews>>(restoreChatViews);
  useEffect(() => saveReloadState("views", viewsByChat), [viewsByChat]);
  // The agent's browser tools find each chat's own browser by its slot.
  useEffect(() => setPreviewSlots(Object.fromEntries(Object.entries(viewsByChat).map(([k, v]) => [k, v.slot]))), [viewsByChat]);
  const viewKey = activeId ?? DRAFT_VIEWS;
  const viewKeyRef = useRef(viewKey);
  useLayoutEffect(() => { viewKeyRef.current = viewKey; }, [viewKey]);
  const workspaceOfRef = useRef(workspaceOf);
  useLayoutEffect(() => { workspaceOfRef.current = workspaceOf; });
  // The agent's video tools route by the chat on screen and each chat's folder.
  useLayoutEffect(() => {
    setVideoChatContext({ active: () => (viewKeyRef.current === DRAFT_VIEWS ? undefined : viewKeyRef.current), workspaceOf: (chat) => workspaceOfRef.current(chat) });
  }, []);
  const currentViews = viewsByChat[viewKey];
  const viewsOpen = currentViews?.open ?? false;
  const openViews = useMemo(() => (viewsOpen ? currentViews?.views ?? [] : []), [viewsOpen, currentViews?.views]);
  const previewShown = openViews.includes("preview");
  const patchViews = useCallback((patch: (cur: ChatViews) => Partial<ChatViews>) => {
    setViewsByChat((prev) => {
      const key = viewKeyRef.current;
      const cur = prev[key] ?? freshChatViews(prev);
      return { ...prev, [key]: { ...cur, ...patch(cur) } };
    });
  }, []);
  const setViewsOpen = useCallback((open: boolean) => patchViews(() => ({ open })), [patchViews]);
  /** Opens a page in the browser of `chat`: the panel comes up for the chat on screen, and a chat
   *  in the background loads it out of sight, never in the browser the user is looking at. */
  const showPreviewOf = useCallback((chat: string, previewFile: string) => {
    if (chat === viewKeyRef.current) {
      patchViews((cur) => ({ previewFile, ...withView(cur, "preview") }));
      return;
    }
    setViewsByChat((prev) => {
      const cur = prev[chat] ?? freshChatViews(prev);
      return { ...prev, [chat]: { ...cur, previewFile, previewStarted: true, usedAt: Date.now(), workspace: workspaceOfRef.current(chat) } };
    });
  }, [patchViews]);
  const openView = useCallback((v: ViewId) => patchViews((cur) => withView(cur, v)), [patchViews]);
  const claimDraftViews = useCallback((id: string) => {
    setViewsByChat((prev) => {
      const draft = prev[DRAFT_VIEWS];
      if (!draft) return prev;
      const { [DRAFT_VIEWS]: _, ...rest } = prev;
      return { ...rest, [id]: draft };
    });
  }, []);
  const dropChatViews = useCallback((id: string) => {
    setViewsByChat((prev) => {
      if (!prev[id]) return prev;
      const { [id]: _, ...rest } = prev;
      return rest;
    });
  }, []);

  const prevActiveIdRef = useRef(activeId);
  useEffect(() => {
    const prev = prevActiveIdRef.current;
    prevActiveIdRef.current = activeId;
    if (activeId === null && prev !== null) dropChatViews(DRAFT_VIEWS);
  }, [activeId, dropChatViews]);
  useEffect(() => {
    if (previewShown) patchViews(() => ({ previewStarted: true, usedAt: Date.now(), workspace }));
  }, [viewKey, previewShown, workspace, patchViews]);
  const previewSlots = useMemo(() => {
    const started = Object.entries(viewsByChat)
      .filter(([, v]) => v.previewStarted)
      .sort(([, a], [, b]) => b.usedAt - a.usedAt);
    const kept = started.slice(0, MAX_LIVE_PREVIEWS);
    const cur = started.find(([k]) => k === viewKey);
    if (cur && !kept.includes(cur)) kept.push(cur);
    // The most recent decide which stay alive, but the list keeps one order (when each browser
    // was created): reordering it on every switch remounted the browser that moved, closing its
    // page and loading it again.
    kept.sort(([, a], [, b]) => slotNumber(a.slot) - slotNumber(b.slot));
    return kept.map(([k, v]) => ({
      slot: v.slot,
      workspace: k === viewKey ? workspace : v.workspace,
      previewFile: v.previewFile,
    }));
  }, [viewsByChat, viewKey, workspace]);
  // Chat links, when the browser is set to open them in the app.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const url = (e as CustomEvent<string>).detail;
      if (!url) return;
      patchViews((cur) => ({ previewFile: url, ...withView(cur, "preview") }));
    };
    // The agent's browser tools bring their chat's browser to the front before they use it.
    // A chat in the background gets its browser started out of sight instead: showing it in
    // the chat on screen put one project's pages (the user's mail) in another's panel.
    const onShow = (e: Event) => {
      const chat = (e as CustomEvent<{ chat?: string } | undefined>).detail?.chat;
      if (!chat || chat === viewKeyRef.current) {
        patchViews((cur) => withView(cur, "preview"));
        return;
      }
      setViewsByChat((prev) => {
        const cur = prev[chat] ?? freshChatViews(prev);
        const ws = workspaceOfRef.current(chat);
        // Already live: touching it on every call would only re-render the panel.
        if (cur.previewStarted && cur.workspace === ws && Date.now() - cur.usedAt < 60_000) return prev;
        return { ...prev, [chat]: { ...cur, previewStarted: true, usedAt: Date.now(), workspace: ws } };
      });
    };
    // A file path clicked in the chat opens in the Files panel.
    const onFile = () => patchViews((cur) => withView(cur, "files"));
    // The agent's VideoOpen shows the Video view in its own chat's panel; the view picks the
    // project up with takePendingVideoOpen when it mounts.
    const onVideo = (e: Event) => {
      const chat = (e as CustomEvent<VideoOpenRequest | undefined>).detail?.chat;
      if (!chat || chat === viewKeyRef.current) {
        patchViews((cur) => withView(cur, "video"));
        return;
      }
      setViewsByChat((prev) => {
        const cur = prev[chat] ?? freshChatViews(prev);
        return { ...prev, [chat]: { ...cur, ...withView(cur, "video") } };
      });
    };
    window.addEventListener(OPEN_IN_BROWSER_EVENT, onOpen);
    window.addEventListener(OPEN_VIDEO_EVENT, onVideo);
    // "Edit in Video" on a file: the Video view takes the file from editVideoFile.ts.
    const onEditVideo = () => patchViews((cur) => withView(cur, "video"));
    window.addEventListener(EDIT_VIDEO_FILE_EVENT, onEditVideo);
    window.addEventListener(OPEN_PREVIEW_EVENT, onShow);
    window.addEventListener(OPEN_FILE_EVENT, onFile);
    return () => {
      window.removeEventListener(OPEN_IN_BROWSER_EVENT, onOpen);
      window.removeEventListener(OPEN_VIDEO_EVENT, onVideo);
      window.removeEventListener(EDIT_VIDEO_FILE_EVENT, onEditVideo);
      window.removeEventListener(OPEN_PREVIEW_EVENT, onShow);
      window.removeEventListener(OPEN_FILE_EVENT, onFile);
    };
  }, [patchViews]);

  return {
    currentViews,
    viewsOpen,
    openViews,
    previewSlots,
    patchViews,
    setViewsOpen,
    showPreviewOf,
    openView,
    claimDraftViews,
    dropChatViews,
  };
}
