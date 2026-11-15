import { useEffect, useRef, type RefObject } from "react";
import { clearHighlights, paintHighlights, type TextHighlight } from "@/lib/chatHighlights";

/** Paints the open chat's highlights and keeps them on their text as the transcript re-renders
 *  (a streamed token, a trace folding open). Renders nothing. */
export function ChatHighlights({
  containerRef,
  highlights,
}: {
  containerRef: RefObject<HTMLElement | null>;
  highlights: Record<string, TextHighlight[] | undefined>;
}) {
  const latest = useRef(highlights);
  const signature = JSON.stringify(highlights);

  useEffect(() => {
    latest.current = highlights;
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let frame = 0;
    const paint = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => paintHighlights(el, latest.current));
    };
    paint();
    // Ranges point at text nodes: a re-render that swaps them needs the highlights placed again.
    const mo = new MutationObserver(paint);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(frame);
      mo.disconnect();
      clearHighlights(el);
    };
  }, [containerRef, signature]);

  return null;
}

export default ChatHighlights;
