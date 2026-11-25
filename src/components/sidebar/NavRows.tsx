import { useEffect, useRef, useState, type ComponentType } from "react";
import { EyeOff, MoreHorizontal, Pin } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { setSidebarRowHidden, useHiddenSidebarRows } from "@/lib/sidebarRows";
import { cn } from "@/lib/utils";

/** A sidebar row the user can move to the More menu. */
export interface NavRow {
  id: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  active?: boolean;
  /** A longer name, for the tooltip and screen readers ("Search sessions" for Search). */
  tooltip?: string;
  /** Its shortcut, for the tooltip. */
  kbd?: string;
  badge?: string;
  /** Drawn in the main text color, like New session (Search), not the rows' quieter one. */
  bright?: boolean;
}

const PANEL = "bg-bg-100 border border-bg-300 rounded-[6px] shadow-2xl p-1.5";
const ROW = "w-full flex items-center gap-2.5 px-2 py-1 rounded-[5px] text-sm leading-5 transition-colors";

/** Closes a menu on a click elsewhere or Escape. */
function useDismiss(open: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open, ref, close]);
}

/** The sidebar's rows under New session. A right click hides one: it moves to More, a row that
 *  appears once something is in it, as in Claude. From More a row opens, or goes back. */
export function NavRows({ rows }: { rows: NavRow[] }) {
  const t = useTranslations().sidebarMenu;
  const hidden = useHiddenSidebarRows();
  const shown = rows.filter((r) => !hidden.includes(r.id));
  const inMore = rows.filter((r) => hidden.includes(r.id));
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [said, setSaid] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  useDismiss(!!menu, menuRef, () => setMenu(null));
  useDismiss(moreOpen, moreRef, () => setMoreOpen(false));

  const label = (id: string) => rows.find((r) => r.id === id)?.label ?? id;
  const hide = (id: string) => {
    setSidebarRowHidden(id, true);
    setSaid(t.movedToMore.replace("{row}", label(id)));
    setMenu(null);
  };

  return (
    <>
      {shown.map((r) => (
        <button
          key={r.id}
          onClick={r.onClick}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ id: r.id, x: e.clientX, y: e.clientY });
          }}
          aria-label={r.tooltip}
          data-tooltip={r.tooltip}
          data-tooltip-kbd={r.kbd}
          className={cn(ROW, r.active ? "bg-bg-200 text-text-100" : r.bright ? "text-text-100 hover:bg-bg-200" : "text-text-300 hover:bg-bg-200")}
        >
          <r.icon className="w-4 h-4 shrink-0" />
          <span className="flex-1 text-left truncate">{r.label}</span>
          {r.badge && <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide bg-bg-300 text-text-400">{r.badge}</span>}
        </button>
      ))}
      {inMore.length > 0 && (
        <div ref={moreRef} className="relative">
          <button
            onClick={() => setMoreOpen((o) => !o)}
            aria-expanded={moreOpen}
            aria-haspopup="menu"
            className={cn(ROW, inMore.some((r) => r.active) || moreOpen ? "bg-bg-200 text-text-100" : "text-text-300 hover:bg-bg-200")}
          >
            <MoreHorizontal className="w-4 h-4 shrink-0" />
            <span className="flex-1 text-left">{t.moreRows}</span>
          </button>
          {moreOpen && (
            <div role="menu" className={cn("absolute left-0 right-0 top-full z-[70] mt-1", PANEL)}>
              {inMore.map((r) => (
                <div key={r.id} className="group flex items-center rounded-[5px] hover:bg-bg-200">
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      r.onClick();
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1 text-left text-sm leading-5 text-text-100"
                  >
                    <r.icon className="w-4 h-4 shrink-0" />
                    <span className="truncate">{r.label}</span>
                  </button>
                  <button
                    onClick={() => setSidebarRowHidden(r.id, false)}
                    aria-label={t.showRow.replace("{row}", r.label)}
                    data-tooltip={t.showRow.replace("{row}", r.label)}
                    className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-text-400 opacity-0 transition-opacity hover:text-text-100 group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <Pin className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {menu && (
        <div ref={menuRef} role="menu" className={cn("fixed z-[70] w-56", PANEL)} style={{ left: menu.x, top: menu.y }}>
          <button role="menuitem" onClick={() => hide(menu.id)} className="flex w-full items-center gap-2.5 rounded-[5px] px-2 py-1 text-left text-sm leading-5 text-text-100 hover:bg-bg-200">
            <EyeOff className="w-4 h-4 shrink-0" />
            {t.hideRow.replace("{row}", label(menu.id))}
          </button>
        </div>
      )}
      <p role="status" className="sr-only">{said}</p>
    </>
  );
}
