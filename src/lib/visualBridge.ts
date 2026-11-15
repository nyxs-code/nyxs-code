import { useEffect, useRef, type RefObject } from "react";
import { openChatLink } from "@/lib/openExternal";

/** A visual called `sendPrompt(text)`: the app sends it as the user's next message. */
export const VISUAL_PROMPT_EVENT = "nyxs:visual-prompt";

const MAX_PROMPT = 4000;
/** How long after the pointer leaves the visual a message from it still counts as the user's. */
const POINTER_GRACE_MS = 1000;
/** A Tab pressed this shortly before the visual took the focus brought the user into it. */
const TAB_GRACE_MS = 500;
/** At most one message per this long, and one link per `LINK_GAP_MS`. */
const PROMPT_GAP_MS = 2000;
const LINK_GAP_MS = 500;

/** Listens to one visual's iframe (see BRIDGE in src-tauri/src/agent/mockup.rs): its height,
 *  its `sendPrompt` calls and the links it opens. The bridge inside the visual only sends those
 *  after a click or key press, but the visual's own code can post anything, so the app checks
 *  too: the user must be in the visual (its frame has the focus, from a click or Tab) and, unless
 *  they came in with the keyboard, have the pointer on it. A visual can't fake either. */
export function useVisualBridge(frameRef: RefObject<HTMLIFrameElement | null>, onHeight?: (height: number) => void): void {
  const onHeightRef = useRef(onHeight);
  useEffect(() => { onHeightRef.current = onHeight; });
  useEffect(() => {
    let over = false;
    let leftAt = -Infinity;
    let tabAt = -Infinity;
    let byKeyboard = false;
    let lastPrompt = -Infinity;
    let lastLink = -Infinity;
    const isFrame = (t: EventTarget | null) => !!frameRef.current && t === frameRef.current;
    const userIsIn = () => {
      const frame = frameRef.current;
      if (!frame || document.activeElement !== frame) return false;
      return over || byKeyboard || Date.now() - leftAt < POINTER_GRACE_MS;
    };
    const onOver = (e: Event) => { if (isFrame(e.target)) over = true; };
    const onOut = (e: Event) => {
      if (!isFrame(e.target)) return;
      over = false;
      leftAt = Date.now();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Tab") tabAt = Date.now(); };
    const onFocusIn = (e: Event) => { if (isFrame(e.target)) byKeyboard = Date.now() - tabAt < TAB_GRACE_MS; };
    const onFocusOut = (e: Event) => { if (isFrame(e.target)) byKeyboard = false; };
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const d = e.data as { source?: string; type?: string; height?: unknown; text?: unknown; url?: unknown } | null;
      if (d?.source !== "nyxs-mockup") return;
      if (d.type === "height" && typeof d.height === "number") return onHeightRef.current?.(Math.ceil(d.height));
      const now = Date.now();
      if (d.type === "prompt" && typeof d.text === "string" && d.text.trim()) {
        if (!userIsIn() || now - lastPrompt < PROMPT_GAP_MS) return;
        lastPrompt = now;
        window.dispatchEvent(new CustomEvent<string>(VISUAL_PROMPT_EVENT, { detail: d.text.trim().slice(0, MAX_PROMPT) }));
      } else if (d.type === "link" && typeof d.url === "string") {
        if (!userIsIn() || now - lastLink < LINK_GAP_MS) return;
        lastLink = now;
        openChatLink(d.url);
      }
    };
    document.addEventListener("pointerover", onOver, true);
    document.addEventListener("pointerout", onOut, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    window.addEventListener("message", onMessage);
    return () => {
      document.removeEventListener("pointerover", onOver, true);
      document.removeEventListener("pointerout", onOut, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      window.removeEventListener("message", onMessage);
    };
  }, [frameRef]);
}
