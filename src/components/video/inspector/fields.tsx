import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Diamond } from "lucide-react";
import { cn } from "@/lib/utils";

export const INPUT =
  "h-6 w-full min-w-0 rounded-[6px] border border-bg-300 bg-bg-0 px-1.5 text-[12px] text-text-100 tabular-nums outline-none transition-colors focus:border-accent/70 hover:border-bg-400";

/** A collapsible group of the inspector. Remembers whether it was open per title. */
export function Section({ title, children, actions, defaultOpen = true }: { title: string; children: ReactNode; actions?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(() => sectionOpen.get(title) ?? defaultOpen);
  return (
    <section className="border-b border-bg-300/70 last:border-b-0">
      <div className="flex h-8 items-center gap-1 pl-2 pr-1.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            sectionOpen.set(title, !open);
            setOpen(!open);
          }}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-[6px] py-1 text-left text-[12px] font-medium text-text-200 hover:text-text-100"
        >
          <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-text-400 transition-transform", !open && "-rotate-90")} />
          <span className="truncate">{title}</span>
        </button>
        {actions}
      </div>
      {open && <div className="space-y-1.5 px-3 pb-3">{children}</div>}
    </section>
  );
}

const sectionOpen = new Map<string, boolean>();

/** Label on the left, control(s) on the right. */
export function Row({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid grid-cols-[84px_minmax(0,1fr)] items-center gap-2", className)}>
      <div className="truncate text-[12px] text-text-300">{label}</div>
      <div className="flex min-w-0 items-center gap-1">{children}</div>
    </div>
  );
}

interface NumberInputProps {
  value: number;
  onChange: (v: number, phase: "drag" | "commit") => void;
  min?: number;
  max?: number;
  step?: number;
  /** Digits after the point shown and kept. */
  precision?: number;
  suffix?: string;
  className?: string;
  "aria-label"?: string;
  disabled?: boolean;
}

function clampRound(v: number, min: number | undefined, max: number | undefined, precision: number) {
  let n = v;
  if (min !== undefined) n = Math.max(min, n);
  if (max !== undefined) n = Math.min(max, n);
  const f = 10 ** precision;
  return Math.round(n * f) / f;
}

/** A number field: type and press Enter, arrows step (Shift ×10), or drag the small handle
 *  sideways to scrub, like the value fields of every video editor. */
export function NumberInput({ value, onChange, min, max, step = 1, precision = 0, suffix, className, disabled, ...rest }: NumberInputProps) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? formatNum(value, precision);
  const commit = (raw: string) => {
    setText(null);
    const n = Number(raw.replace(",", "."));
    if (raw.trim() === "" || !Number.isFinite(n)) return;
    const v = clampRound(n, min, max, precision);
    if (v !== value) onChange(v, "commit");
  };

  const scrub = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (disabled) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const base = value;
    let last = value;
    const move = (ev: PointerEvent) => {
      const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      last = clampRound(base + ((ev.clientX - startX) / 2) * step * mult, min, max, precision);
      onChange(last, "drag");
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      if (last !== base) onChange(last, "commit");
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  return (
    <div className={cn("relative flex min-w-0 flex-1 items-center", className)}>
      <span
        aria-hidden
        onPointerDown={scrub}
        className={cn("absolute inset-y-0 left-0 z-[1] w-2.5 rounded-l-[6px]", disabled ? "cursor-default" : "cursor-ew-resize hover:bg-accent/15")}
      />
      <input
        type="text"
        inputMode="decimal"
        disabled={disabled}
        aria-label={rest["aria-label"]}
        value={shown}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit(e.currentTarget.value);
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setText(null);
            e.currentTarget.blur();
            e.stopPropagation();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const delta = (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            setText(null);
            onChange(clampRound(value + delta, min, max, precision), "commit");
          }
          // The editor's own shortcuts (Space, arrows, J/K/L) must not fire while typing.
          e.stopPropagation();
        }}
        className={cn(INPUT, "pl-3", suffix && "pr-7", disabled && "opacity-50")}
      />
      {suffix && <span className="pointer-events-none absolute right-1.5 text-[11px] text-text-400">{suffix}</span>}
    </div>
  );
}

function formatNum(v: number, precision: number) {
  if (!Number.isFinite(v)) return "";
  return precision > 0 ? String(Math.round(v * 10 ** precision) / 10 ** precision) : String(Math.round(v));
}

/** A text field that commits on Enter or blur. */
export function TextInput({ value, onCommit, placeholder, className, multiline, "aria-label": ariaLabel }: { value: string; onCommit: (v: string) => void; placeholder?: string; className?: string; multiline?: boolean; "aria-label"?: string }) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? value;
  const commit = () => {
    if (text !== null && text !== value) onCommit(text);
    setText(null);
  };
  const common = {
    value: shown,
    placeholder,
    "aria-label": ariaLabel,
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        setText(null);
        e.currentTarget.blur();
      } else if (e.key === "Enter" && (!multiline || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        commit();
      }
    },
  };
  return multiline ? (
    <textarea
      {...common}
      rows={3}
      onChange={(e) => setText(e.target.value)}
      className={cn(INPUT, "h-auto resize-y py-1 leading-snug custom-scrollbar", className)}
    />
  ) : (
    <input {...common} type="text" onChange={(e) => setText(e.target.value)} className={cn(INPUT, className)} />
  );
}

/** A CSS color: a swatch opening the system picker plus the text value. Accepts any CSS color
 *  in the text; the swatch only edits hex. */
export function ColorInput({ value, onChange, allowEmpty, "aria-label": ariaLabel }: { value: string | undefined; onChange: (v: string | undefined) => void; allowEmpty?: boolean; "aria-label"?: string }) {
  const hex = toHex(value);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <label className="relative h-6 w-6 shrink-0 cursor-pointer overflow-hidden rounded-[6px] border border-bg-300" style={{ background: value || "transparent" }}>
        {!value && <span aria-hidden className="absolute inset-0 bg-[linear-gradient(135deg,transparent_45%,var(--color-red-500,#ef4444)_45%,var(--color-red-500,#ef4444)_55%,transparent_55%)]" />}
        <input
          type="color"
          aria-label={ariaLabel}
          value={hex ?? "#000000"}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </label>
      <TextInput value={value ?? ""} aria-label={ariaLabel} placeholder={allowEmpty ? "—" : undefined} onCommit={(v) => onChange(v.trim() || (allowEmpty ? undefined : value))} />
    </div>
  );
}

function toHex(c: string | undefined): string | null {
  if (!c) return null;
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  if (/^#[0-9a-f]{3}$/i.test(c)) return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  if (/^#[0-9a-f]{8}$/i.test(c)) return c.slice(0, 7);
  return null;
}

export function Select<T extends string>({ value, options, onChange, className, "aria-label": ariaLabel }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; className?: string; "aria-label"?: string }) {
  return (
    <div className={cn("relative min-w-0 flex-1", className)}>
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        onKeyDown={(e) => e.stopPropagation()}
        className={cn(INPUT, "appearance-none pr-6")}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-400" />
    </div>
  );
}

/** A row of exclusive buttons (alignment, fit, …). */
export function Segmented<T extends string>({ value, options, onChange }: { value: T | undefined; options: { value: T; label: string; icon?: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" className="flex h-6 min-w-0 flex-1 items-center rounded-[6px] border border-bg-300 bg-bg-0 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          aria-label={o.icon ? o.label : undefined}
          data-tooltip={o.icon ? o.label : undefined}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex h-full min-w-0 flex-1 items-center justify-center rounded-[4px] px-1 text-[11.5px] transition-colors",
            value === o.value ? "bg-bg-200 text-text-100" : "text-text-300 hover:text-text-100",
          )}
        >
          {o.icon ?? <span className="truncate">{o.label}</span>}
        </button>
      ))}
    </div>
  );
}

export interface KeyframeLabels {
  add: string;
  remove: string;
  prev: string;
  next: string;
}

/** ‹ ◆ › next to an animatable value: jump between keyframes and add/remove one at the playhead. */
export function KeyframeControls({ keyed, animated, onToggle, prev, next, onJump, labels }: {
  keyed: boolean;
  animated: boolean;
  onToggle: () => void;
  prev: number | null;
  next: number | null;
  onJump: (frameInClip: number) => void;
  labels: KeyframeLabels;
}) {
  const nav = "flex h-6 w-3.5 items-center justify-center text-text-400 hover:text-text-100 disabled:opacity-0";
  return (
    <div className="flex shrink-0 items-center">
      <button type="button" className={nav} disabled={prev === null} onClick={() => prev !== null && onJump(prev)} aria-label={labels.prev} data-tooltip={labels.prev}>
        <ChevronLeft className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={keyed}
        aria-label={keyed ? labels.remove : labels.add}
        data-tooltip={keyed ? labels.remove : labels.add}
        className={cn(
          "flex h-6 w-5 items-center justify-center rounded-[4px] transition-colors hover:bg-bg-200",
          keyed ? "text-accent" : animated ? "text-accent/60" : "text-text-400 hover:text-text-200",
        )}
      >
        <Diamond className={cn("h-3 w-3", keyed && "fill-current")} />
      </button>
      <button type="button" className={nav} disabled={next === null} onClick={() => next !== null && onJump(next)} aria-label={labels.next} data-tooltip={labels.next}>
        <ChevronRight className="h-3 w-3" />
      </button>
    </div>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cn("relative h-[18px] w-8 shrink-0 rounded-full transition-colors", on ? "bg-accent" : "bg-bg-300")}
    >
      <span className={cn("absolute left-0.5 top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-transform", on && "translate-x-3.5")} />
    </button>
  );
}
