import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Globe, Maximize2, Terminal, X } from "lucide-react";
import { cornerStyle, MARGIN, useChatArea } from "@/components/chatAreaCorner";
import { useTranslations } from "@/lib/i18n";
import { cornerAfterKey, forgetMinimized, setMinimizedCorner, useMinimizedViews, type MinimizableView } from "@/lib/minimizedViews";
import { nearestCorner } from "@/lib/sideChat";
import { cn } from "@/lib/utils";

/** The browser and the terminal while minimized: a small card in a corner of the chat with a
 *  row for each, to bring it back. Dragged by its edge (or moved with the arrow keys) it goes to
 *  another corner, like the minimized side chat. */
export function MinimizedViews({ onRestore }: { onRestore: (view: MinimizableView) => void }) {
  const t = useTranslations().views;
  const { views, corner } = useMinimizedViews();
  const area = useChatArea();
  const cardRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  if (!views.length) return null;

  const name = (v: MinimizableView) => (v === "preview" ? t.preview : t.terminal);
  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button") || e.button !== 0) return;
    const box = cardRef.current?.getBoundingClientRect();
    if (!box) return;
    e.preventDefault();
    const dx = e.clientX - box.left;
    const dy = e.clientY - box.top;
    const at = (ev: PointerEvent) => ({
      x: Math.min(Math.max(ev.clientX - dx, area.left), Math.max(area.left, area.right - box.width)),
      y: Math.min(Math.max(ev.clientY - dy, area.top), Math.max(area.top, area.bottom - box.height)),
    });
    const move = (ev: PointerEvent) => setDrag(at(ev));
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const p = at(ev);
      setMinimizedCorner(nearestCorner(p.x + box.width / 2 - area.left, p.y + box.height / 2 - area.top, area.right - area.left, area.bottom - area.top));
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    setDrag({ x: box.left, y: box.top });
  };

  return (
    <div
      ref={cardRef}
      role="group"
      aria-label={t.minimizedPanels}
      tabIndex={0}
      data-webview-hole
      data-tooltip={t.minimizedHint}
      onPointerDown={startDrag}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        const next = cornerAfterKey(corner, e.key);
        if (!next) return;
        e.preventDefault();
        setMinimizedCorner(next);
      }}
      style={{ ...(drag ? { left: drag.x, top: drag.y } : cornerStyle(corner, area)), maxWidth: Math.max(160, area.right - area.left - 2 * MARGIN) }}
      className={cn(
        "fixed z-[65] flex w-64 flex-col gap-0.5 rounded-[8px] border border-bg-300 bg-bg-100 p-1.5 shadow-xl outline-none focus-visible:ring-2 focus-visible:ring-accent",
        drag ? "cursor-grabbing select-none" : "cursor-grab",
      )}
    >
      {views.map((v) => {
        const Icon = v === "preview" ? Globe : Terminal;
        return (
          <div key={v} className="flex items-center gap-1 rounded-[6px] hover:bg-bg-200">
            <button
              type="button"
              onClick={() => onRestore(v)}
              aria-label={t.restorePanel.replace("{name}", name(v))}
              className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-[13px] text-text-100"
            >
              <Icon className="h-4 w-4 shrink-0 text-text-300" />
              <span className="truncate">{name(v)}</span>
              <Maximize2 className="ml-auto h-3.5 w-3.5 shrink-0 text-text-400" />
            </button>
            <button
              type="button"
              onClick={() => forgetMinimized(v)}
              aria-label={t.hideMinimized.replace("{name}", name(v))}
              data-tooltip={t.hideMinimized.replace("{name}", name(v))}
              className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-text-400 hover:bg-bg-300 hover:text-text-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
