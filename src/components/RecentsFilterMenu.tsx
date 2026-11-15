import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SlidersHorizontal, Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { workspaceName } from "@/lib/workspace";
import { DEFAULT_RECENTS_FILTER, isRecentsFilterActive, type RecentsFilter } from "@/lib/recentsFilter";

type Opt = { value: string; label: string };

const MAIN_W = 224;
const SUB_W = 192;

export function RecentsFilterMenu({
  value,
  onChange,
  projects,
}: {
  value: RecentsFilter;
  onChange: (next: RecentsFilter) => void;
  projects: string[];
}) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<string | null>(null);
  const [subTop, setSubTop] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
      setSub(null);
    };
    const onScroll = () => { setOpen(false); setSub(null); };
    document.addEventListener("mousedown", h);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", h);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  const projectOpts: Opt[] = [
    { value: "all", label: "All projects" },
    ...projects.map((p) => ({ value: p, label: workspaceName(p) })),
  ];

  const ROWS: { key: keyof RecentsFilter; label: string; opts: Opt[] }[] = [
    {
      key: "status",
      label: "Status",
      opts: [
        { value: "active", label: "Active" },
        { value: "archived", label: "Archived" },
        { value: "all", label: "All" },
      ],
    },
    { key: "project", label: "Project", opts: projectOpts },
    {
      key: "activity",
      label: "Last activity",
      opts: [
        { value: "1d", label: "1d" },
        { value: "3d", label: "3d" },
        { value: "7d", label: "7d" },
        { value: "30d", label: "30d" },
        { value: "all", label: "All" },
      ],
    },
    {
      key: "groupBy",
      label: "Group by",
      opts: [
        { value: "project", label: "Project" },
        { value: "date", label: "Date" },
        { value: "state", label: "State" },
        { value: "prStatus", label: "PR status" },
        { value: "none", label: "None" },
      ],
    },
    {
      key: "sort",
      label: "Sort by",
      opts: [
        { value: "alphabetical", label: "Alphabetically" },
        { value: "created", label: "Created time" },
        { value: "recency", label: "Recency" },
      ],
    },
  ];

  const labelFor = (key: keyof RecentsFilter) => {
    const row = ROWS.find((r) => r.key === key)!;
    return row.opts.find((o) => o.value === value[key])?.label ?? String(value[key]);
  };

  const toggle = () => {
    if (open) { setOpen(false); setSub(null); return; }
    setRect(btnRef.current?.getBoundingClientRect() ?? null);
    setOpen(true);
  };

  const activeRow = ROWS.find((r) => r.key === sub) ?? null;

  let mainLeft = 8;
  let top = 8;
  if (rect) {
    // Opens from the button outward, past the sidebar's edge, like the folder and session menus.
    top = Math.min(rect.bottom + 4, window.innerHeight - 16);
    mainLeft = Math.max(8, Math.min(rect.left, window.innerWidth - MAIN_W - 8));
  }
  const subLeft = Math.min(mainLeft + MAIN_W + 4, window.innerWidth - SUB_W - 8);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        data-tooltip="Organize recents"
        className={cn(
          "relative p-1 rounded-md transition-colors",
          open ? "text-text-100 bg-bg-200" : "text-text-400 hover:text-text-200 hover:bg-bg-200",
        )}
      >
        <SlidersHorizontal className="w-3.5 h-3.5" />
        {isRecentsFilterActive(value) && (
          <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-accent" />
        )}
      </button>

      {open && createPortal(
        <div ref={panelRef} className="fixed inset-0 z-[200] pointer-events-none">
          <div
            data-mod-menu
            className="absolute pointer-events-auto bg-bg-100 border border-bg-300 rounded-[5px] shadow-2xl p-1"
            style={{ top, left: mainLeft, width: MAIN_W }}
          >
            {ROWS.map((row) => (
              <button
                key={row.key}
                type="button"
                onClick={(e) => { setSubTop(e.currentTarget.getBoundingClientRect().top); setSub((s) => (s === row.key ? null : row.key)); }}
                onMouseEnter={(e) => { setSubTop(e.currentTarget.getBoundingClientRect().top); setSub(row.key); }}
                className={cn(
                  "w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-[5px] text-[13px] transition-colors",
                  sub === row.key ? "bg-bg-200 text-text-100" : "text-text-200 hover:bg-bg-200",
                )}
              >
                <span>{row.label}</span>
                <span className="flex items-center gap-1 text-text-400">
                  <span className={cn("text-[12px]", value[row.key] !== defaultOf(row.key) && "text-accent")}>{labelFor(row.key)}</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </span>
              </button>
            ))}
          </div>

          {activeRow && (
            <div
              data-mod-menu
              className="absolute pointer-events-auto max-h-72 overflow-y-auto custom-scrollbar bg-bg-100 border border-bg-300 rounded-[5px] shadow-2xl p-1"
              style={{
                top: Math.max(8, Math.min(subTop, window.innerHeight - Math.min(activeRow.opts.length * 38 + 16, 296) - 8)),
                left: subLeft,
                width: SUB_W,
              }}
            >
              {activeRow.opts.map((o) => {
                const selected = value[activeRow.key] === o.value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => { onChange({ ...value, [activeRow.key]: o.value }); setOpen(false); setSub(null); }}
                    className="w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-[5px] text-[13px] text-text-200 hover:bg-bg-200 transition-colors"
                  >
                    <span className="truncate">{o.label}</span>
                    {selected && <Check className="w-4 h-4 text-accent shrink-0" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

function defaultOf(key: keyof RecentsFilter): string {
  return DEFAULT_RECENTS_FILTER[key];
}
