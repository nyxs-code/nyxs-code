import { useCallback, useState } from "react";

/** The two sessions side by side, by position. The focused one is always the app's open chat
 *  (`activeId`), so everything that follows the open chat (views panel, Git bar, shortcuts,
 *  queue, permission mode) follows the focused pane without knowing about the split. */
export interface SplitPanes {
  left: string;
  right: string;
}

export type PaneSide = "left" | "right";

/** What a sidebar session carries while it is dragged onto the chat area. */
export const SESSION_DRAG_TYPE = "application/x-nyxs-session";

/** The split after the open chat changed: unchanged while the open chat is one of the panes,
 *  another session takes the focused pane's place, and a new chat (no id) or a pane whose chat
 *  was deleted ends it. */
export function reconcileSplit(
  split: SplitPanes | null,
  activeId: string | null,
  focusedSide: PaneSide,
  chatIds: ReadonlySet<string>,
): SplitPanes | null {
  if (!split) return null;
  if (!activeId || !chatIds.has(split.left) || !chatIds.has(split.right)) return null;
  if (activeId === split.left || activeId === split.right) return split;
  const next = focusedSide === "left" ? { left: activeId, right: split.right } : { left: split.left, right: activeId };
  return next.left === next.right ? null : next;
}

interface Options {
  enabled: boolean;
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  /** Ids of the chats loaded in memory. */
  chatIds: ReadonlySet<string>;
}

export function useSplitView({ enabled, activeId, setActiveId, chatIds }: Options) {
  const [split, setSplit] = useState<SplitPanes | null>(null);
  const [focusedSide, setFocusedSide] = useState<PaneSide>("left");
  // A session being opened to the side while it loads from disk: the pane appears once its chat
  // is in memory, and until then the open chat moving to it doesn't count as replacing a pane.
  const [opening, setOpening] = useState<SplitPanes | null>(null);

  // Adjusted during render rather than in an effect, so a pane never shows a stale chat for a
  // frame. The caller opens the session (loading it if needed); once it is the open chat and in
  // memory, the split appears with it focused on the right.
  let current = split;
  if (opening && activeId === opening.right && chatIds.has(opening.left) && chatIds.has(opening.right)) {
    current = opening;
    setOpening(null);
  } else if (opening && activeId !== opening.left && activeId !== opening.right) {
    // The user went elsewhere before it loaded (or it failed to load).
    setOpening(null);
  }
  const reconciled = enabled ? reconcileSplit(current, activeId, focusedSide, chatIds) : null;
  if (reconciled !== split) setSplit(reconciled);
  const side: PaneSide | null = reconciled ? (activeId === reconciled.right ? "right" : activeId === reconciled.left ? "left" : null) : null;
  if (side && side !== focusedSide) setFocusedSide(side);

  /** Shows `id` next to the open chat, with focus. False when there is no open chat to sit
   *  beside; the caller then just opens it. The caller also loads the chat if needed. */
  const openToSide = useCallback(
    (id: string): boolean => {
      if (!enabled || !activeId || id === activeId) return false;
      if (split && (split.left === id || split.right === id)) {
        setActiveId(id);
        return true;
      }
      // Already split: the focused pane stays and the new session replaces the other one.
      setOpening({ left: activeId, right: id });
      return true;
    },
    [enabled, activeId, split, setActiveId],
  );

  /** Closes one pane; the other becomes the single, focused view. */
  const closePane = useCallback(
    (id: string) => {
      if (!split) return;
      setSplit(null);
      setActiveId(split.left === id ? split.right : split.left);
    },
    [split, setActiveId],
  );

  return { split: reconciled, openToSide, closePane };
}
