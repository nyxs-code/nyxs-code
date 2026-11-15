import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { INPUT } from "./fields";
import { GOOGLE_FONTS } from "./fonts";

/** Shows the family; opens a searchable list. */
export function FontPicker({ value, onChange, projectFonts, label, searchLabel }: { value: string; onChange: (family: string) => void; projectFonts: string[]; label: string; searchLabel: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const all = useMemo(() => {
    const own = projectFonts.map((family) => ({ family, category: "project" as const }));
    const seen = new Set(own.map((f) => f.family));
    return [...own, ...GOOGLE_FONTS.filter((f) => !seen.has(f.family))];
  }, [projectFonts]);
  const q = query.trim().toLowerCase();
  const items = q ? all.filter((f) => f.family.toLowerCase().includes(q)) : all;
  // A family typed that isn't in the list is still usable (any font the template can load).
  const custom = q && !all.some((f) => f.family.toLowerCase() === q) ? query.trim() : null;
  const rows = custom ? [{ family: custom, category: "custom" as const }, ...items] : items;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (family: string) => {
    onChange(family);
    setOpen(false);
    setQuery("");
  };

  return (
    <div ref={boxRef} className="relative min-w-0 flex-1">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setActive(0);
        }}
        className={cn(INPUT, "flex items-center justify-between gap-1 text-left")}
      >
        <span className="truncate">{value}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-400" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 rounded-[8px] border border-bg-300 bg-bg-100 p-1 shadow-lg">
          <div className="relative mb-1">
            <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-400" />
            <input
              autoFocus
              value={query}
              aria-label={searchLabel}
              placeholder={searchLabel}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => Math.min(rows.length - 1, a + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => Math.max(0, a - 1));
                } else if (e.key === "Enter" && rows[active]) {
                  e.preventDefault();
                  pick(rows[active].family);
                } else if (e.key === "Escape") {
                  setOpen(false);
                }
              }}
              className={cn(INPUT, "pl-6")}
            />
          </div>
          <div ref={listRef} role="listbox" aria-label={label} className="max-h-56 overflow-y-auto custom-scrollbar">
            {rows.map((f, i) => (
              <button
                key={`${f.category}:${f.family}`}
                type="button"
                role="option"
                data-index={i}
                aria-selected={f.family === value}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(f.family)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-[6px] px-2 py-1 text-left text-[12.5px] text-text-100",
                  i === active && "bg-bg-200",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{f.family}</span>
                {f.category === "custom" && <span className="shrink-0 text-[11px] text-text-400">↵</span>}
                {f.category === "project" && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
                {f.family === value && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
