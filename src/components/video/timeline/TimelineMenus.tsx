import { useEffect, useLayoutEffect, useRef, type ComponentType } from "react";
import { Keyboard } from "lucide-react";
import type { Translations } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface MenuItem {
  label: string;
  icon?: ComponentType<{ className?: string }>;
  kbd?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect(): void;
  /** Draws the row as a label followed by small choice buttons (e.g. speed presets). */
  chips?: { label: string; active: boolean; onSelect(): void }[];
}

/** A right-click menu at the pointer; `null` entries draw a separator. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: (MenuItem | null)[]; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Keep the menu inside the window once its size is known.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  }, [x, y]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div
        className="fixed inset-0 z-[90]"
        onPointerDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
        aria-hidden
      />
      <div
        data-mod-menu
        ref={ref}
        role="menu"
        data-webview-hole
        className="fixed z-[91] min-w-[200px] rounded-[8px] border border-bg-300 bg-bg-100 p-1 shadow-lg"
        style={{ left: x, top: y }}
      >
        {items.map((item, i) =>
          item === null ? (
            <div key={`sep-${i}`} className="mx-1 my-1 h-px bg-bg-300" />
          ) : item.chips ? (
            <div key={item.label} className={cn("flex items-center gap-2.5 px-2 py-1 text-[13px] text-text-200", item.disabled && "pointer-events-none opacity-40")}>
              {item.icon ? <item.icon className="h-4 w-4 text-text-400" /> : <span className="w-4" />}
              <span className="flex-1">{item.label}</span>
              <span className="flex gap-0.5">
                {item.chips.map((chip) => (
                  <button
                    key={chip.label}
                    type="button"
                    role="menuitemradio"
                    aria-checked={chip.active}
                    onClick={() => {
                      onClose();
                      chip.onSelect();
                    }}
                    className={cn(
                      "rounded-[5px] px-1.5 py-0.5 font-mono text-[11px] tabular-nums hover:bg-bg-200",
                      chip.active ? "bg-accent/12 text-accent" : "text-text-300",
                    )}
                  >
                    {chip.label}
                  </button>
                ))}
              </span>
            </div>
          ) : (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-[6px] px-2 py-1.5 text-left text-[13px] hover:bg-bg-200 disabled:pointer-events-none disabled:opacity-40",
                item.danger ? "text-danger" : "text-text-200",
              )}
            >
              {item.icon ? <item.icon className={cn("h-4 w-4", item.danger ? "text-danger" : "text-text-400")} /> : <span className="w-4" />}
              <span className="flex-1">{item.label}</span>
              {item.kbd && <span className="text-[11px] text-text-400">{item.kbd}</span>}
            </button>
          ),
        )}
      </div>
    </>
  );
}

/** The "?" button and its list of timeline shortcuts. */
export function ShortcutsPopover({ t, open, onOpenChange }: { t: Translations["videoTimeline"]; open: boolean; onOpenChange(open: boolean): void }) {
  const rows: [string, string][] = [
    ["S", t.scSplit],
    ["Del", t.scDelete],
    ["Shift+Del", t.scRippleDelete],
    ["Ctrl+Z", t.scUndo],
    ["Ctrl+Shift+Z", t.scRedo],
    ["Ctrl+C / Ctrl+X / Ctrl+V", t.scClipboard],
    ["Ctrl+D", t.scDuplicate],
    ["Ctrl+A", t.scSelectAll],
    ["M", t.scMarker],
    ["I / O", t.scInOut],
    ["← / →", t.scNudge],
    ["Ctrl+Wheel", t.scZoom],
    ["Shift+Click", t.scMultiSelect],
    ["Alt", t.scNoSnap],
    ["↕", t.scResizeTrack],
  ];
  return (
    <div className="relative">
      <button
        type="button"
        aria-label={t.shortcuts}
        aria-expanded={open}
        data-tooltip={open ? undefined : t.shortcuts}
        data-tooltip-kbd="?"
        onClick={() => onOpenChange(!open)}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded-[6px] text-text-400 hover:bg-bg-200 hover:text-text-200",
          open && "bg-bg-200 text-text-200",
        )}
      >
        <Keyboard className="h-3.5 w-3.5" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[90]" onPointerDown={() => onOpenChange(false)} aria-hidden />
          <div
            data-mod-menu
            data-webview-hole
            className="absolute bottom-full right-0 z-[91] mb-1 w-[300px] rounded-[8px] border border-bg-300 bg-bg-100 p-2 shadow-lg"
          >
            <p className="px-1 pb-1.5 text-[12px] font-medium text-text-200">{t.shortcutsTitle}</p>
            <div className="flex flex-col">
              {rows.map(([keys, label]) => (
                <div key={keys} className="flex items-center justify-between gap-3 rounded-[6px] px-1 py-[3px]">
                  <span className="text-[12px] text-text-300">{label}</span>
                  <kbd className="shrink-0 rounded-[4px] border border-bg-300 bg-bg-200 px-1.5 py-[1px] font-mono text-[10.5px] text-text-200">
                    {keys}
                  </kbd>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
