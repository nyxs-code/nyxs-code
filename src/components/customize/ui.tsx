import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight, Search } from "lucide-react";
import { cn } from "@/lib/utils";

/** The gray search field of the Customize page and its directory. */
export function SearchBox({
  value,
  onChange,
  placeholder,
  className,
  autoFocus,
  size = "sm",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  className?: string;
  autoFocus?: boolean;
  size?: "sm" | "lg";
}) {
  return (
    <div className={cn("relative", className)}>
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-400 pointer-events-none" />
      <input
        type="text"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          "w-full pl-9 pr-3 rounded-[6px] bg-bg-200 border border-transparent text-text-100 placeholder:text-text-400 outline-none focus:border-accent",
          size === "lg" ? "h-10 text-[14px]" : "h-8 text-[13px]",
        )}
      />
    </div>
  );
}

/**
 * A button that opens a small menu under it. The menu closes on a click outside, on Escape
 * (without closing the dialog it may sit in) and when an item calls `close`.
 */
export function Dropdown({
  trigger,
  children,
  align = "right",
  className,
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div
      ref={ref}
      className="relative shrink-0"
      onKeyDown={(e) => {
        if (open && e.key === "Escape") {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      {trigger(open, () => setOpen((o) => !o))}
      {open && (
        <div
          data-mod-menu
          role="menu"
          className={cn(
            "absolute z-30 mt-1.5 min-w-[200px] max-h-[60vh] overflow-y-auto custom-scrollbar rounded-[8px] border border-bg-300 bg-bg-100 p-1.5 shadow-xl",
            align === "right" ? "right-0" : "left-0",
            className,
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  icon,
  label,
  onClick,
  checked,
  count,
  danger,
  submenu,
  disabled,
}: {
  icon?: ReactNode;
  label: string;
  onClick: () => void;
  checked?: boolean;
  count?: number;
  danger?: boolean;
  submenu?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-[6px] text-left text-[13px] transition-colors disabled:opacity-50",
        danger ? "text-red-400 hover:bg-red-500/10" : "text-text-200 hover:bg-bg-200 hover:text-text-100",
      )}
    >
      {icon && <span className="w-4 h-4 shrink-0 flex items-center justify-center text-text-300">{icon}</span>}
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {count !== undefined && <span className="text-[12px] text-text-500 tabular-nums">{count.toLocaleString()}</span>}
      {checked && <Check className="w-4 h-4 text-accent shrink-0" />}
      {submenu && <ChevronRight className="w-3.5 h-3.5 text-text-400 shrink-0" />}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <p className="px-2.5 pt-1.5 pb-1 text-[12px] text-text-500">{children}</p>;
}

export function MenuSeparator() {
  return <div className="h-px bg-bg-300 my-1.5 -mx-1.5" />;
}

/** The small gray number next to a section title. */
export function CountBadge({ n }: { n: number }) {
  return (
    <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-[5px] bg-bg-200 text-[10.5px] font-medium text-text-400 tabular-nums">
      {n.toLocaleString()}
    </span>
  );
}

/** A row of text tabs where the chosen one has a gray fill (Plugins · Connectors). */
export function PillTabs<T extends string>({
  items,
  value,
  onChange,
}: {
  items: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-1" role="tablist">
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          role="tab"
          aria-selected={value === it.id}
          onClick={() => onChange(it.id)}
          className={cn(
            "h-8 px-3 rounded-[6px] text-[14px] transition-colors",
            value === it.id ? "bg-bg-200 text-text-100" : "text-text-200 hover:bg-bg-200/60",
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** Two choices in a bordered box where the chosen one is a raised white tile (Yours · Discover). */
export function SegmentedTabs<T extends string>({
  items,
  value,
  onChange,
}: {
  items: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center p-0.5 rounded-[8px] bg-bg-200 border border-bg-300" role="tablist">
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          role="tab"
          aria-selected={value === it.id}
          onClick={() => onChange(it.id)}
          className={cn(
            "h-7 px-3 rounded-[6px] text-[14px] transition-colors",
            value === it.id ? "bg-bg-0 text-text-100 shadow-sm" : "text-text-300 hover:text-text-100",
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** The square gray "+" (or state icon) at the right of a connector or plugin. */
export function SquareAction({
  children,
  onClick,
  label,
  disabled,
  tone = "gray",
}: {
  children: ReactNode;
  onClick?: () => void;
  label: string;
  disabled?: boolean;
  tone?: "gray" | "success";
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      className={cn(
        "w-7 h-7 shrink-0 rounded-[6px] flex items-center justify-center transition-colors disabled:cursor-default",
        tone === "success"
          ? "bg-green-500/15 text-green-500"
          : "bg-bg-200 text-text-200 hover:bg-bg-300 hover:text-text-100",
      )}
    >
      {children}
    </button>
  );
}
