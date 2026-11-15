import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

export interface SettingSelectOption<T extends string> {
  id: T;
  label: string;
  description?: string;
}

/** Compact value button for a settings row that opens a menu of options, each with an optional
 *  description. Every choice in Settings uses it, never a native `<select>` (skill
 *  `nyxs-setting-select`). The menu opens under the button's right edge, or its left with
 *  `align="left"` (a button at the start of a column). */
export function SettingSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  align = "right",
}: {
  value: T;
  options: SettingSelectOption<T>[];
  onChange: (v: T) => void;
  ariaLabel?: string;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = options.find((o) => o.id === value) ?? options[0];
  const wide = options.some((o) => o.description);

  return (
    <div className="relative w-fit" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[13px] text-text-100 transition-colors whitespace-nowrap ${open ? "bg-bg-200" : "hover:bg-bg-200"}`}
      >
        {current?.label}
        <ChevronDown className={`w-3.5 h-3.5 text-text-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          data-mod-menu
          role="menu"
          className={`absolute ${align === "left" ? "left-0" : "right-0"} top-full mt-1.5 z-50 p-1.5 rounded-[8px] border border-bg-300 bg-bg-100 shadow-2xl ${wide ? "w-80" : "min-w-[11rem]"}`}
        >
          {options.map((o) => {
            const active = o.id === value;
            return (
              <button
                key={o.id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  onChange(o.id);
                  setOpen(false);
                }}
                className={`w-full text-left px-2.5 py-2 rounded-md flex items-start justify-between gap-3 transition-colors hover:bg-bg-200 ${active && wide ? "bg-bg-200/60" : ""}`}
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[13px] text-text-100">{o.label}</span>
                  {o.description && <span className="text-[11px] leading-snug text-text-400">{o.description}</span>}
                </span>
                {active && <Check className={`w-4 h-4 shrink-0 text-accent ${wide ? "self-center" : ""}`} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
