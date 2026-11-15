import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/components/Message";

/** Messages rendered at first, and how many more each "show earlier" adds. */
const MESSAGE_RENDER_CAP = 60;

/** How many messages, counted from the end, Find in chat has to draw to reach the first one whose
 *  text holds `query` (any case); 0 when none does. */
export function messagesToShowFor(messages: ChatMessage[], query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const first = messages.findIndex((m) => typeof m.content === "string" && m.content.toLowerCase().includes(q));
  return first < 0 ? 0 : messages.length - first;
}

/** Growth this soon after a click or key press in the chat is the user opening something (a tool's
 *  details, a message to edit): the chat stays put so what they opened doesn't jump away. */
const USER_ACTION_GRACE_MS = 1000;

/** Scrolling of the open chat: it follows new output while the user is at the bottom, stops
 *  following when they scroll up, and keeps their place when older messages are shown. */
export function useChatScroll(activeId: string | null, messages: ChatMessage[] | undefined) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  // Set before the app scrolls by itself, so that scroll event doesn't count as the user's.
  const programmaticScrollRef = useRef(false);
  const lastUserActionRef = useRef(Number.NEGATIVE_INFINITY);

  const pinToEnd = useCallback(() => {
    const el = scrollRef.current;
    // Already there no scroll event fires, and the mark would swallow the user's next one.
    if (!el || el.scrollHeight - el.scrollTop - el.clientHeight < 1) return;
    programmaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
  }, []);

  const handleChatScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (programmaticScrollRef.current) {
      programmaticScrollRef.current = false;
      lastScrollTopRef.current = el.scrollTop;
      return;
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const scrolledUp = el.scrollTop < lastScrollTopRef.current - 1;
    lastScrollTopRef.current = el.scrollTop;
    // Content shrinking also moves scrollTop up, but leaves it at the end: the user didn't leave.
    if (scrolledUp && distanceFromBottom >= 1) {
      stickToBottomRef.current = false;
    } else if (distanceFromBottom < 80) {
      stickToBottomRef.current = true;
    }
  }, []);

  const [visibleCount, setVisibleCount] = useState(MESSAGE_RENDER_CAP);
  // Another chat starts with the usual number drawn, not with what the previous one grew to.
  const [countedChat, setCountedChat] = useState(activeId);
  if (countedChat !== activeId) {
    setCountedChat(activeId);
    setVisibleCount(MESSAGE_RENDER_CAP);
  }
  const restoreScrollRef = useRef<number | null>(null);
  const showEarlierMessages = useCallback(() => {
    const el = scrollRef.current;
    if (el) restoreScrollRef.current = el.scrollHeight - el.scrollTop;
    setVisibleCount((c) => c + MESSAGE_RENDER_CAP);
  }, []);
  /** Draws at least the last `count` messages, keeping the scroll where it is. */
  const showAtLeast = useCallback((count: number) => {
    setVisibleCount((c) => Math.max(c, count));
  }, []);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && restoreScrollRef.current != null) {
      programmaticScrollRef.current = true;
      el.scrollTop = el.scrollHeight - restoreScrollRef.current;
      restoreScrollRef.current = null;
    }
  }, [visibleCount]);

  // Another chat opens at its end.
  useEffect(() => {
    stickToBottomRef.current = true;
    lastScrollTopRef.current = 0;
    lastUserActionRef.current = Number.NEGATIVE_INFINITY;
  }, [activeId]);
  useEffect(() => {
    if (stickToBottomRef.current) pinToEnd();
  }, [messages, pinToEnd]);

  // Some content takes its height after the messages render, with no new message to trigger the
  // effect above: a visual loads its iframe and reports its size, an image decodes.
  useEffect(() => {
    const el = scrollRef.current;
    const content = el?.firstElementChild;
    if (!el || !content) return;
    const noteUserAction = () => { lastUserActionRef.current = performance.now(); };
    const onContentResize = () => {
      if (!stickToBottomRef.current) return;
      if (performance.now() - lastUserActionRef.current < USER_ACTION_GRACE_MS) return;
      // Clicks inside a visual never reach the page, only the focus shows the user is using it.
      const active = document.activeElement;
      if (active?.tagName === "IFRAME" && el.contains(active)) return;
      pinToEnd();
    };
    el.addEventListener("click", noteUserAction, true);
    el.addEventListener("keydown", noteUserAction, true);
    const ro = new ResizeObserver(onContentResize);
    ro.observe(content);
    return () => {
      el.removeEventListener("click", noteUserAction, true);
      el.removeEventListener("keydown", noteUserAction, true);
      ro.disconnect();
    };
  }, [pinToEnd]);

  /** Follow new output again (the user jumped to the end). */
  const followOutput = useCallback(() => { stickToBottomRef.current = true; }, []);

  return { scrollRef, handleChatScroll, visibleCount, showEarlierMessages, showAtLeast, followOutput };
}
