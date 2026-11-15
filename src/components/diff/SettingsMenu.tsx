import { useEffect, useRef, useState } from "react";
import { Check, MoreVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n";
import type { Settings } from "./settings";

// ── Settings menu ──────────────────────────────────────────────────────────

export function SettingsMenu({
  settings,
  set,
  onCollapseAll,
  onExpandAll,
  onRefresh,
}: {
  settings: Settings;
  set: (patch: Partial<Settings>) => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  onRefresh: () => void;
}) {
  const t = useTranslations().views;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const toggle = (label: string, key: keyof Settings, kbd?: string) => ({ label, checked: settings[key], kbd, run: () => set({ [key]: !settings[key] }) });
  const action = (label: string, run: () => void) => ({ label, run, checked: undefined as boolean | undefined, kbd: undefined as string | undefined });
  const sections = [
    [toggle(t.diffShowFiles, "showFiles", "Ctrl+Shift+Y"), toggle(t.diffGroupByFolder, "groupByFolder"), toggle(t.diffSeparateTests, "separateTests")],
    [action(t.diffCollapseAll, onCollapseAll), action(t.diffExpandAll, onExpandAll)],
    [toggle(t.diffSideBySide, "sideBySide"), toggle(t.diffWrap, "wrap"), toggle(t.diffWordHighlight, "wordHighlight"), toggle(t.diffHideWhitespace, "hideWhitespace")],
    [action(t.diffRefresh, onRefresh)],
  ];

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={t.diffSettings}
        data-tooltip={open ? undefined : t.diffSettings}
        aria-expanded={open}
        className={cn("p-1.5 rounded-md text-text-400 hover:text-text-100 hover:bg-bg-200", open && "bg-bg-200 text-text-100")}
      >
        <MoreVertical className="w-4 h-4" />
      </button>
      {open && (
        <div data-mod-menu role="menu" className="absolute right-0 top-full mt-1 z-30 w-80 rounded-[5px] border border-bg-300 bg-bg-100 shadow-2xl p-1">
          {sections.map((items, si) => (
            <div key={si} className={cn(si > 0 && "mt-1 pt-1 border-t border-bg-300")}>
              {items.map((it) => (
                <button
                  key={it.label}
                  type="button"
                  role={it.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                  aria-checked={it.checked}
                  onClick={() => { it.run(); if (it.checked === undefined) setOpen(false); }}
                  className="w-full flex items-center gap-2 px-2 py-1 rounded-[5px] text-left text-[13px] text-text-100 hover:bg-bg-200 transition-colors"
                >
                  <span className="min-w-0 flex-1 truncate">{it.label}</span>
                  {it.checked && <Check className="w-4 h-4 shrink-0 text-accent" />}
                  {it.kbd && <span className="shrink-0 text-[11px] text-text-400">{it.kbd}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
