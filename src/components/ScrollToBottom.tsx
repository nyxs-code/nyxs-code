import { useEffect, useState, type RefObject } from "react";
import { ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";

/** How far from the end (CSS px) the chat must be before the button shows. A small nudge of
 *  the wheel doesn't bring it up; reading back a bit does. */
const SHOW_AFTER_PX = 240;

/** Round "jump to the end" button over the bottom of the chat. It listens to the scroll itself so
 *  the app doesn't re-render on every wheel tick. */
export function ScrollToBottom({
  containerRef,
  onJump,
  label,
  working = false,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  /** Called before scrolling, to stick the chat to the bottom again. */
  onJump?: () => void;
  label: string;
  /** The agent is replying: the arrow becomes three dots in a wave, so a user reading back
   *  knows more is arriving below. */
  working?: boolean;
}) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const check = () => setShow(el.scrollHeight - el.scrollTop - el.clientHeight > SHOW_AFTER_PX);
    check();
    el.addEventListener("scroll", check, { passive: true });
    // A reply streaming in while the user reads above grows the distance without a scroll.
    const ro = new ResizeObserver(check);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", check);
      ro.disconnect();
    };
  }, [containerRef]);

  const jump = () => {
    const el = containerRef.current;
    if (!el) return;
    onJump?.();
    // Straight to the end, like the minimap: no smooth scroll through the whole chat.
    el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
  };

  return (
    <div className="pointer-events-none relative h-0">
      <button
        type="button"
        onClick={jump}
        aria-label={label}
        tabIndex={show ? 0 : -1}
        className={cn(
          "absolute bottom-3 left-1/2 z-10 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-bg-300 bg-bg-000 text-text-200 shadow-sm transition-all duration-150 hover:bg-bg-200 hover:text-text-100",
          show ? "pointer-events-auto translate-y-0 opacity-100" : "translate-y-1 opacity-0",
        )}
      >
        {working ? (
          <span className="flex items-center gap-[3px]" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="h-1 w-1 rounded-full bg-current animate-[typing_1.2s_ease-in-out_infinite] motion-reduce:animate-none"
                style={{ animationDelay: `${i * 150}ms` }}
              />
            ))}
          </span>
        ) : (
          <ArrowDown className="h-4 w-4" strokeWidth={2} />
        )}
      </button>
    </div>
  );
}

export default ScrollToBottom;
