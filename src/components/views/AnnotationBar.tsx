import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, ChevronDown, Circle, Pencil, Redo2, Slash, Square, Trash2, Type, Undo2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n";
import { ANNOT_COLORS, ANNOT_WIDTHS, type AnnotShape, type AnnotTool } from "@/lib/annotations";
import { CursorIcon } from "@/components/ui/cursor-icon";
import { ACTIVE_TOGGLE } from "@/lib/uiClasses";

/** A numbered step marker: a circle with a 1 in it. */
function StepIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M10.5 9.5 12.5 8v8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ShapeIcon({ shape, className }: { shape: AnnotShape; className?: string }) {
  if (shape === "line") return <Slash className={className} strokeWidth={1.8} />;
  if (shape === "arrow") return <ArrowUpRight className={className} strokeWidth={1.8} />;
  if (shape === "ellipse") return <Circle className={className} strokeWidth={1.8} />;
  if (shape === "step") return <StepIcon className={className} />;
  return <Square className={className} strokeWidth={1.8} />;
}

const SHAPES: AnnotShape[] = ["line", "arrow", "rect", "ellipse", "step"];

type Menu = "shape" | "color" | "width";

/** A toolbar button with its tooltip drawn by hand: over a website the app's shared tooltip
 *  would sit behind the native page, while this one opens a hole in it (data-webview-hole). */
function BarButton({
  label,
  active,
  open,
  disabled,
  tip,
  onClick,
  children,
  className,
}: {
  label: string;
  active?: boolean;
  /** Its menu is open: shaded grey, not marked as the current tool. */
  open?: boolean;
  disabled?: boolean;
  /** False while a menu is open, so the tooltip never covers it. */
  tip: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div className="relative" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={active}
        className={cn(
          "inline-flex items-center justify-center gap-0.5 h-7 min-w-7 px-1.5 rounded-md transition-colors disabled:opacity-35 disabled:cursor-default",
          active
            ? ACTIVE_TOGGLE
            : cn("text-text-200 enabled:hover:bg-bg-200 enabled:hover:text-text-100", open && "bg-bg-200 text-text-100"),
          className,
        )}
      >
        {children}
      </button>
      {hover && tip && !disabled && (
        <span
          role="tooltip"
          data-webview-hole
          className="app-tooltip pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 whitespace-nowrap px-2.5 py-1.5 text-[12px] shadow-xl z-50"
        >
          {label}
        </span>
      )}
    </div>
  );
}

function MenuPanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      role="menu"
      data-webview-hole
      className={cn("absolute bottom-full mb-2 z-50 rounded-lg border border-bg-300 bg-bg-100 shadow-lg p-1", className)}
    >
      {children}
    </div>
  );
}

const menuRow = "w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[13px] text-text-100 hover:bg-bg-200 transition-colors text-left";

/** The browser's annotation toolbar, floating at the bottom of the page while the element
 *  picker is on: pick an element, draw (pen, shapes, steps), write, then add the annotated
 *  screenshot to the chat. */
export function AnnotationBar({
  tool,
  shape,
  color,
  width,
  canUndo,
  canRedo,
  canClear,
  onTool,
  onShape,
  onColor,
  onWidth,
  onUndo,
  onRedo,
  onClear,
  onAddToChat,
  onClose,
}: {
  /** The tool lit up; null when the arrow has stopped after a pick and none is in use. */
  tool: AnnotTool | null;
  shape: AnnotShape;
  color: string;
  width: number;
  canUndo: boolean;
  canRedo: boolean;
  canClear: boolean;
  onTool: (tool: AnnotTool) => void;
  onShape: (shape: AnnotShape) => void;
  onColor: (color: string) => void;
  onWidth: (width: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  onAddToChat: () => void;
  onClose: () => void;
}) {
  const t = useTranslations().views;
  const [menu, setMenu] = useState<Menu | null>(null);
  const toggle = (m: Menu) => setMenu((cur) => (cur === m ? null : m));
  const rootRef = useRef<HTMLDivElement>(null);
  // A click on the page goes to the page (the app only sees its window lose focus), and a click
  // elsewhere in the app lands outside the bar: both close an open menu.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const outside = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) close(); };
    window.addEventListener("blur", close);
    document.addEventListener("mousedown", outside);
    return () => { window.removeEventListener("blur", close); document.removeEventListener("mousedown", outside); };
  }, [menu]);
  const tip = menu === null;
  const shapeLabel: Record<AnnotShape, string> = {
    line: t.annotLine,
    arrow: t.annotArrow,
    rect: t.annotRect,
    ellipse: t.annotEllipse,
    step: t.annotStep,
  };
  const isShape = !!tool && (SHAPES as string[]).includes(tool);
  const sep = <span className="w-px h-4 mx-1 bg-bg-300 shrink-0" aria-hidden />;

  return (
    <div
      ref={rootRef}
      data-webview-hole
      onKeyDown={(e) => { if (e.key === "Escape") setMenu(null); }}
      className="flex items-center gap-0.5 rounded-lg border border-bg-300 bg-bg-100 shadow-lg px-1.5 py-1"
    >
      <BarButton label={t.selectElement} active={tool === "select"} tip={tip} onClick={() => { setMenu(null); onTool("select"); }}>
        <CursorIcon className="w-4 h-4" />
      </BarButton>
      <BarButton label={t.annotPen} active={tool === "pen"} tip={tip} onClick={() => { setMenu(null); onTool("pen"); }}>
        <Pencil className="w-4 h-4" strokeWidth={1.8} />
      </BarButton>
      <div className="relative">
        <BarButton label={t.annotShapes} active={isShape} tip={tip} onClick={() => { onTool(shape); toggle("shape"); }}>
          <ShapeIcon shape={shape} className="w-4 h-4" />
          <ChevronDown className="w-3 h-3 opacity-60" />
        </BarButton>
        {menu === "shape" && (
          <MenuPanel className="left-1/2 -translate-x-1/2 w-40">
            {SHAPES.map((s) => (
              <button key={s} type="button" role="menuitem" className={menuRow} onClick={() => { onShape(s); onTool(s); setMenu(null); }}>
                <ShapeIcon shape={s} className="w-4 h-4 shrink-0 text-text-300" />
                {shapeLabel[s]}
              </button>
            ))}
          </MenuPanel>
        )}
      </div>
      <BarButton label={t.annotText} active={tool === "text"} tip={tip} onClick={() => { setMenu(null); onTool("text"); }}>
        <Type className="w-4 h-4" strokeWidth={1.8} />
      </BarButton>
      {sep}
      <div className="relative">
        <BarButton label={t.annotColor} tip={tip} open={menu === "color"} onClick={() => toggle("color")}>
          <span className="w-3.5 h-3.5 rounded-full border border-black/15" style={{ background: color }} />
          <ChevronDown className="w-3 h-3 opacity-60" />
        </BarButton>
        {menu === "color" && (
          <MenuPanel className="left-1/2 -translate-x-1/2 w-32">
            {ANNOT_COLORS.map((c, i) => (
              <button
                key={c}
                type="button"
                role="menuitemradio"
                aria-checked={c === color}
                aria-label={`${t.annotColor} ${i + 1}`}
                className={menuRow}
                onClick={() => { onColor(c); setMenu(null); }}
              >
                <span className="w-3.5 h-3.5 rounded-full border border-black/20 shrink-0" style={{ background: c }} />
                <span className="flex-1" />
                {c === color && <Check className="w-3.5 h-3.5 text-sky-600 dark:text-sky-300" />}
              </button>
            ))}
          </MenuPanel>
        )}
      </div>
      <div className="relative">
        <BarButton label={t.annotWidth} tip={tip} open={menu === "width"} onClick={() => toggle("width")}>
          <span className="w-5 rounded-full bg-current" style={{ height: Math.max(2, Math.round(width / 1.6)) }} />
          <ChevronDown className="w-3 h-3 opacity-60" />
        </BarButton>
        {menu === "width" && (
          <MenuPanel className="left-1/2 -translate-x-1/2 w-32">
            {ANNOT_WIDTHS.map((w, i) => (
              <button
                key={w}
                type="button"
                role="menuitemradio"
                aria-checked={w === width}
                aria-label={`${t.annotWidth} ${i + 1}`}
                className={menuRow}
                onClick={() => { onWidth(w); setMenu(null); }}
              >
                <span className="w-6 rounded-full bg-text-100 shrink-0" style={{ height: Math.max(2, Math.round(w / 1.6)) }} />
                <span className="flex-1" />
                {w === width && <Check className="w-3.5 h-3.5 text-sky-600 dark:text-sky-300" />}
              </button>
            ))}
          </MenuPanel>
        )}
      </div>
      {sep}
      <BarButton label={t.annotUndo} disabled={!canUndo} tip={tip} onClick={() => { setMenu(null); onUndo(); }}>
        <Undo2 className="w-4 h-4" strokeWidth={1.8} />
      </BarButton>
      <BarButton label={t.annotRedo} disabled={!canRedo} tip={tip} onClick={() => { setMenu(null); onRedo(); }}>
        <Redo2 className="w-4 h-4" strokeWidth={1.8} />
      </BarButton>
      <BarButton label={t.annotClear} disabled={!canClear} tip={tip} onClick={() => { setMenu(null); onClear(); }}>
        <Trash2 className="w-4 h-4" strokeWidth={1.8} />
      </BarButton>
      <button
        type="button"
        onClick={() => { setMenu(null); onAddToChat(); }}
        className="ml-1 h-6 px-2 rounded-md text-[12px] font-semibold whitespace-nowrap bg-[#1a1a19] text-white hover:bg-black dark:bg-text-100 dark:text-bg-0 dark:hover:bg-white transition-colors"
      >
        {t.annotAddToChat}
      </button>
      <BarButton label={t.annotClose} tip={tip} onClick={() => { setMenu(null); onClose(); }}>
        <X className="w-4 h-4" strokeWidth={1.8} />
      </BarButton>
    </div>
  );
}
