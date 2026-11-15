import { useEffect, useMemo, useState, type RefObject } from "react";
import { cn } from "@/lib/utils";

/** How much each tick grows with its distance from the hovered one: a wave instead of a single
 *  tick popping out. Index 0 is the hovered tick itself. */
const HORIZONTAL_WAVE = [2.8, 2.15, 1.55, 1.2];
const VERTICAL_WAVE = [1.4, 1.22, 1.1, 1.04];

/** Tick slot height bounds (px). Long chats shrink the slots so the whole minimap still fits. */
const SLOT_MAX = 10;
const SLOT_MIN = 4;

/** Fewer user messages than this and there is nothing to navigate. */
const MIN_MESSAGES = 2;

export interface MessageScrollerMessage {
  id: string;
  content: string;
  /** Tints the tick: something in this turn is highlighted in this color. */
  color?: string;
}

function waveScale(index: number, hovered: number | null, wave: number[]) {
  if (hovered === null) return 1;
  return wave[Math.abs(index - hovered)] ?? 1;
}

/** Conversation minimap: one tick per user message along the right edge of the chat. Ticks of the
 *  messages on screen are lit, hovering previews the message, clicking scrolls to it.
 *  It reads the chat's own scroll container and finds each message by `data-message-id`, so the
 *  transcript doesn't have to render anything for it. */
export function MessageScroller({
  containerRef,
  messages,
  label,
  jumpLabel,
  className,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  messages: MessageScrollerMessage[];
  /** Accessible name of the navigation. */
  label: string;
  /** Accessible prefix of each tick ("Jump to message: …"). */
  jumpLabel: string;
  className?: string;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [activeId, setActiveId] = useState<string>();
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const [viewportHeight, setViewportHeight] = useState(0);

  // The chat re-renders on every streamed token with a new array; only re-subscribe when the set
  // of user messages actually changes.
  const signature = messages.map((m) => m.id).join("|");
  const ids = useMemo(() => (signature ? signature.split("|") : []), [signature]);

  useEffect(() => {
    const viewport = containerRef.current;
    if (!viewport || ids.length < MIN_MESSAGES) return;
    let frame = 0;

    const update = () => {
      const bounds = viewport.getBoundingClientRect();
      const center = bounds.top + bounds.height / 2;
      const visible: string[] = [];
      let nearest: string | undefined;
      let nearestDistance = Infinity;
      for (const id of ids) {
        const el = viewport.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (rect.bottom > bounds.top && rect.top < bounds.bottom) visible.push(id);
        const distance = Math.abs(rect.top + rect.height / 2 - center);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = id;
        }
      }
      setActiveId(nearest);
      setViewportHeight(bounds.height);
      setVisibleIds((prev) =>
        prev.length === visible.length && prev.every((id, i) => id === visible[i]) ? prev : visible,
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };

    // A reply streaming in moves the messages without a scroll event, hence the content observer.
    const ro = new ResizeObserver(schedule);
    ro.observe(viewport);
    if (viewport.firstElementChild) ro.observe(viewport.firstElementChild);
    viewport.addEventListener("scroll", schedule, { passive: true });
    update();
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      viewport.removeEventListener("scroll", schedule);
    };
  }, [containerRef, ids]);

  if (messages.length < MIN_MESSAGES) return null;

  const jump = (id: string) => {
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
    if (!el) return;
    // scrollIntoView rather than scrollTop math: the transcript has a CSS zoom, which skews
    // rect-vs-scrollTop arithmetic but not the browser's own centering. It jumps straight there:
    // a smooth scroll through a long chat felt slow.
    el.scrollIntoView({ block: "center", behavior: "auto" });
  };

  const slot = Math.max(
    SLOT_MIN,
    Math.min(SLOT_MAX, viewportHeight ? Math.floor((viewportHeight * 0.7) / messages.length) : SLOT_MAX),
  );

  return (
    <nav
      aria-label={label}
      className={cn("pointer-events-none absolute inset-y-0 right-4 z-10 flex w-10 flex-col justify-center", className)}
      onPointerLeave={() => setHovered(null)}
    >
      {messages.map((message, index) => {
        const isActive = message.id === activeId;
        const isHovered = index === hovered;
        const lit = isActive || isHovered || visibleIds.includes(message.id);
        return (
          <div key={message.id} className="pointer-events-auto relative" style={{ height: slot }}>
            <button
              type="button"
              aria-current={isActive ? "true" : undefined}
              aria-label={`${jumpLabel}: ${message.content.slice(0, 120)}`}
              className="flex h-full w-full items-center justify-end rounded-[2px] outline-none focus-visible:ring-2 focus-visible:ring-accent"
              onClick={() => jump(message.id)}
              onPointerEnter={() => setHovered(index)}
              onFocus={() => setHovered(index)}
              onBlur={() => setHovered(null)}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "block h-0.5 w-3 origin-right rounded-full bg-text-500/40 transition-[transform,background-color,opacity] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] will-change-transform motion-reduce:transition-[background-color]",
                  lit && "bg-text-100",
                )}
                style={{
                  transform: `scaleX(${waveScale(index, hovered, HORIZONTAL_WAVE)}) scaleY(${waveScale(index, hovered, VERTICAL_WAVE)})`,
                  // A highlighted turn keeps its color, a little dimmer while it is off screen.
                  ...(message.color ? { backgroundColor: message.color, opacity: lit ? 1 : 0.75 } : null),
                }}
              />
            </button>
            {isHovered && (
              <span className="app-tooltip pointer-events-none absolute right-full top-1/2 z-50 mr-3 w-64 -translate-y-1/2 px-2.5 py-1.5 text-[12px] leading-5 shadow-xl animate-fade-in">
                <span className="line-clamp-4 whitespace-pre-wrap break-words">{message.content}</span>
              </span>
            )}
          </div>
        );
      })}
    </nav>
  );
}

export default MessageScroller;
