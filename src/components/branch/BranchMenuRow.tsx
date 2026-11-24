import { useMemo, useRef, useState } from "react";
import { Check, ChevronRight, Loader2 } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { fill } from "./branchText";
import type { BranchPicker } from "./useBranchPicker";

/** The folder menu's "Branch" row and its submenu: search, then the folder's branches. */
export function BranchMenuRow({ picker, folder, onPicked }: { picker: BranchPicker; folder: string; onPicked: () => void }) {
  const t = useTranslations().branchPicker;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const { data, current, selected, worktreeOn, busy } = picker;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.branches ?? []).filter((b) => !q || b.toLowerCase().includes(q));
  }, [data, query]);
  if (!data) return null;

  const show = () => {
    if (open || busy) return;
    setOpen(true);
    setQuery("");
    setHighlight(Math.max(0, data.branches.indexOf(selected ?? "")));
    picker.reread();
    setTimeout(() => searchRef.current?.focus(), 0);
  };
  const choose = (b: string) => {
    setOpen(false);
    onPicked();
    picker.pick(b);
  };
  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(filtered.length - 1, h + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(0, h - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); const b = filtered[highlight]; if (b) choose(b); }
    else if (e.key === "Escape" || e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); setOpen(false); }
  };

  return (
    <div className="relative" onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        role="menuitem"
        aria-haspopup="listbox"
        aria-expanded={open}
        onMouseEnter={show}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => { if (e.key === "ArrowRight") { e.preventDefault(); show(); } }}
        className={cn("w-full text-left px-2 py-0.5 rounded-[5px] flex items-center gap-2 transition-colors hover:bg-bg-200 dark:hover:bg-[#30302E]", open && "bg-bg-200 dark:bg-[#30302E]")}
      >
        <span className="flex-1 text-[13px] leading-5 text-text-100">{t.label}</span>
        {busy && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-text-400" />}
        <span className="min-w-0 max-w-[140px] truncate text-[12px] text-text-400">{busy ?? selected ?? "HEAD"}</span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-400" />
      </button>
      {/* `pl-1` instead of a margin, so the pointer crossing to the submenu never leaves the row. */}
      {open && (
        <div className="absolute bottom-0 left-full z-50 pl-1">
          <div data-mod-menu data-composer-menu className="w-72 rounded-[5px] border border-bg-300 bg-bg-100 p-1 shadow-2xl">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setHighlight(0); }}
              onKeyDown={onSearchKey}
              placeholder={t.search}
              aria-label={t.search}
              className="mb-1 w-full rounded-[5px] border border-bg-300 bg-bg-0 px-2 py-1 text-[13px] text-text-100 outline-none placeholder:text-text-500 focus:border-text-500"
            />
            <p className="px-2 pb-1 text-[11.5px] leading-snug text-text-400">{worktreeOn ? t.modeWorktree : fill(t.modeSwitch, { folder })}</p>
            <div role="listbox" aria-label={t.label} className="max-h-64 overflow-y-auto custom-scrollbar">
              {filtered.length === 0 && <p className="px-2 py-1.5 text-[13px] text-text-400">{t.noMatches}</p>}
              {filtered.map((b, i) => {
                const elsewhere = !worktreeOn && data.elsewhere.has(b);
                return (
                  <button
                    key={b}
                    type="button"
                    role="option"
                    aria-selected={b === selected}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => choose(b)}
                    className={cn("flex w-full items-center gap-2 rounded-[5px] px-2 py-1 text-left", i === highlight && "bg-bg-200 dark:bg-[#30302E]")}
                  >
                    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">{b === selected && <Check className="h-3.5 w-3.5 text-accent" />}</span>
                    <span className={cn("min-w-0 flex-1 truncate text-[13px] leading-5", elsewhere ? "text-text-400" : "text-text-100")}>{b}</span>
                    {b === current ? (
                      <span className="shrink-0 text-[11.5px] text-text-500">{t.current}</span>
                    ) : elsewhere ? (
                      <span className="shrink-0 text-[11.5px] text-text-500">{t.inWorktree}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
