import { useEffect, useState } from "react";
import type { SideCorner } from "@/lib/sideChat";

// Floating cards in a corner of the chat (the minimized side chat, the minimized browser and
// terminal) share where they may sit and how they snap to a corner.

/** The gap between a floating card and the chat area's edges. */
export const MARGIN = 12;

export interface Area {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Where the card may sit: the chat's area (App marks it), between the sidebar and the side
 *  panel, so it never covers either. The whole window when the chat is hidden. */
export function useChatArea(): Area {
  const measure = (): Area => {
    const el = document.querySelector("[data-side-chat-area]");
    const r = el?.getBoundingClientRect();
    if (!r || r.width === 0) return { left: 0, top: 36, right: window.innerWidth, bottom: window.innerHeight };
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  };
  const [area, setArea] = useState<Area>(measure);
  useEffect(() => {
    const update = () => setArea((prev) => {
      const next = measure();
      return prev.left === next.left && prev.top === next.top && prev.right === next.right && prev.bottom === next.bottom ? prev : next;
    });
    update();
    const el = document.querySelector("[data-side-chat-area]");
    // The sidebar or the side panel opening, closing or being resized moves the chat's edges.
    const ro = el ? new ResizeObserver(update) : null;
    if (el && ro) ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);
  return area;
}

/** Where a card goes in that corner of the area. */
export const cornerStyle = (corner: SideCorner, a: Area) => ({
  ...(corner.startsWith("top") ? { top: a.top + MARGIN } : { bottom: window.innerHeight - a.bottom + MARGIN }),
  ...(corner.endsWith("left") ? { left: a.left + MARGIN } : { right: window.innerWidth - a.right + MARGIN }),
});
