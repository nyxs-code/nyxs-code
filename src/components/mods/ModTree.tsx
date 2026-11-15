import type { CSSProperties, ReactNode } from "react";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { svgSource } from "@/lib/mods/svg";
import { isElement, isFnRef, type RenderElement, type RenderNode } from "@/lib/mods/types";

/**
 * Draws a tree a mod returned from `ui.render` with Nyxs' own look: the desktop table of Claude
 * Code's elements (Box, Text, Button, Svg, Link, Markdown, Progress, Code). An element Nyxs
 * doesn't draw is left out.
 *
 * A few shapes mods draw cards with get a layout of their own, as Claude Code's desktop app does:
 * a row holding a close button is the card's header (the close button an ✕), a row of buttons
 * alone is one control of joined segments, and a column whose first row is a title and its
 * buttons is a list entry, with its buttons on the right and its texts under the title. Anything
 * else is drawn as the mod laid it out.
 */

const MAX_SVG = 131_072;
const GAPS: Record<string, number> = { none: 0, xs: 4, sm: 6, md: 10, lg: 16, xl: 24 };
/** A cell of the terminal, where these sizes come from, as pixels here. */
const CELL = 6;

/** The theme keys a mod may color text with, as Nyxs paints them. */
const THEME_KEYS: Record<string, string> = {
  text: "var(--text-100)",
  inverseText: "var(--bg-0)",
  inactive: "var(--text-400)",
  subtle: "var(--text-500)",
  suggestion: "var(--accent)",
  claude: "var(--accent)",
  permission: "var(--accent)",
  planMode: "var(--accent)",
  autoAccept: "var(--accent)",
  promptBorder: "var(--bg-300)",
  ide: "var(--accent)",
  remember: "var(--accent)",
  success: "var(--success)",
  error: "var(--danger)",
  warning: "var(--warning)",
  merged: "var(--accent)",
  diffAdded: "var(--success)",
  diffRemoved: "var(--danger)",
};

function color(v: unknown): string | undefined {
  if (typeof v !== "string" || !v) return undefined;
  return THEME_KEYS[v] ?? v;
}

function space(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, v) * CELL;
  if (typeof v === "string" && v in GAPS) return GAPS[v];
  return undefined;
}

function size(v: unknown): string | number | undefined {
  if (typeof v === "number") return v * CELL;
  if (typeof v === "string" && /^\d+(\.\d+)?%$/.test(v)) return v;
  return undefined;
}

interface Ctx {
  press: (fn: number, args?: unknown[]) => void;
}

const isEl = (n: RenderNode | undefined, name?: string): n is RenderElement => isElement(n) && (!name || n.$el === name);
const isColumn = (n: RenderNode | undefined): n is RenderElement =>
  isEl(n, "Box") && (n.props.flexDirection === "column" || n.props.flexDirection === "column-reverse");
const isRow = (n: RenderNode | undefined): n is RenderElement => isEl(n, "Box") && !isColumn(n);
const isDismiss = (n: RenderNode | undefined) => isEl(n, "Button") && n.props.role === "dismiss";

function textOf(n: RenderNode): string {
  return typeof n === "string" ? n : isElement(n) ? n.children.map(textOf).join("") : "";
}

function labelOf(b: RenderElement): string {
  return typeof b.props.label === "string" && b.props.label ? b.props.label : textOf(b);
}

function pressOf(b: RenderElement): number | null {
  return isFnRef(b.props.onPress) ? b.props.onPress.$fn : null;
}

const keyOf = (n: RenderElement, fallback: string | number) => (typeof n.props.key === "string" ? n.props.key : fallback);

/** A row of buttons and nothing else. */
function buttonGroup(n: RenderNode | undefined): RenderElement[] | null {
  if (!isRow(n) || n.children.length < 2 || !n.children.every((c) => isEl(c, "Button"))) return null;
  return n.children as RenderElement[];
}

/** A row holding the card's close button: the card's header. */
const isHeader = (n: RenderElement) => isRow(n) && n.children.some(isDismiss);

/** A pairing note some mods write under an entry ("For light windows: Halftone Dawn"): a chip by the title. */
const TWIN = /^For (light|dark) windows: (.+)$/;

interface Item {
  title: RenderElement;
  buttons: RenderElement[];
  notes: RenderElement[];
}

/** A list entry: a column whose first row is a title and its buttons, the rest texts under it. */
function itemOf(n: RenderNode): Item | null {
  if (!isColumn(n) || !isRow(n.children[0])) return null;
  const [first, ...rest] = n.children;
  const head = (first as RenderElement).children;
  if (head.length < 2 || !isEl(head[0], "Text") || !rest.every((c) => isEl(c, "Text"))) return null;
  const after = head.slice(1);
  const buttons = after.length === 1 ? (buttonGroup(after[0]) ?? (isEl(after[0], "Button") ? [after[0]] : null)) : after.every((c) => isEl(c, "Button")) ? (after as RenderElement[]) : null;
  return buttons ? { title: head[0] as RenderElement, buttons, notes: rest as RenderElement[] } : null;
}

function drawSegments(buttons: RenderElement[], ctx: Ctx, on: boolean) {
  // The first is the main action; once the entry is in use, the button that says so is filled.
  const marked = buttons.findIndex((b) => labelOf(b).trimStart().startsWith("✓"));
  const filled = on ? (marked >= 0 ? marked : 0) : -1;
  return (
    <div className="inline-flex shrink-0 divide-x divide-bg-300 overflow-hidden rounded-[6px] border border-bg-300">
      {buttons.map((b, i) => {
        const fn = pressOf(b);
        return (
          <button
            key={keyOf(b, i)}
            type="button"
            disabled={!!b.props.disabled || fn === null}
            onClick={() => fn !== null && ctx.press(fn)}
            className={cn(
              "h-7 px-2.5 text-[12px] transition-colors disabled:opacity-50",
              i === filled
                ? "bg-accent text-white hover:bg-accent-hover"
                : i === 0 && filled < 0
                  ? "font-medium text-accent hover:bg-bg-200"
                  : "text-text-300 hover:bg-bg-200 hover:text-text-100",
            )}
          >
            {labelOf(b).replace(/^\s*✓\s*/, "")}
          </button>
        );
      })}
    </div>
  );
}

function drawItem(item: Item, ctx: Ctx, key: string | number) {
  const raw = textOf(item.title).trim();
  const on = raw.startsWith("✓");
  const twins = item.notes.map((n) => TWIN.exec(textOf(n).trim())).filter((m): m is RegExpExecArray => !!m);
  const notes = item.notes.filter((n) => !TWIN.test(textOf(n).trim()));
  return (
    <div
      key={key}
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[6px] px-2 py-1.5 transition-colors", on ? "bg-accent/10" : "hover:bg-bg-200/60")}
    >
      <div className="min-w-0 flex-1 basis-56">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13px] font-medium text-text-100">
          {on && <Check className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />}
          <span className="min-w-0">{raw.replace(/^✓\s*/, "")}</span>
          {twins.map((m) => (
            <span key={m[0]} className="rounded-[6px] bg-bg-200 px-1.5 py-px text-[11px] font-normal text-text-300">
              {m[1][0].toUpperCase() + m[1].slice(1)}: {m[2]}
            </span>
          ))}
        </div>
        {notes.map((n, i) => (
          <p key={i} className="mt-0.5 whitespace-pre-wrap break-words text-[12px] leading-snug text-text-400">
            {textOf(n)}
          </p>
        ))}
      </div>
      {item.buttons.length > 0 && <div className="ml-auto">{drawSegments(item.buttons, ctx, on)}</div>}
    </div>
  );
}

/** The card's header: its title on the left, its other buttons quiet on the right, closing with ✕. */
// It sticks over the band's top padding too (-top-2.5), or rows scrolling up show above it.
function drawHeader(n: RenderElement, ctx: Ctx, key: string | number) {
  const buttons = n.children.filter((c): c is RenderElement => isEl(c, "Button"));
  const rest = n.children.filter((c) => !isEl(c, "Button"));
  return (
    <div key={key} className="sticky -top-2.5 z-10 -mx-3 -mt-2.5 mb-1 flex items-center gap-2 border-b border-bg-300 bg-bg-100 px-3 pb-2 pt-2.5">
      <div className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-text-100">{rest.map((c, i) => draw(c, ctx, i, 1))}</div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {buttons.map((b, i) => {
          const fn = pressOf(b);
          return isDismiss(b) ? (
            <button
              key={keyOf(b, i)}
              type="button"
              aria-label={labelOf(b)}
              onClick={() => fn !== null && ctx.press(fn)}
              className="flex h-7 w-7 items-center justify-center rounded-[6px] text-text-400 transition-colors hover:bg-bg-200 hover:text-text-100"
            >
              <X className="h-4 w-4" />
            </button>
          ) : (
            <button
              key={keyOf(b, i)}
              type="button"
              disabled={fn === null}
              onClick={() => fn !== null && ctx.press(fn)}
              className="h-7 rounded-[6px] px-2 text-[12.5px] text-text-300 transition-colors hover:bg-bg-200 hover:text-text-100 disabled:opacity-50"
            >
              {labelOf(b)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function draw(node: RenderNode, ctx: Ctx, key: string | number, depth: number): ReactNode {
  if (typeof node === "string") return node;
  if (!isElement(node)) return null;
  const p = node.props;
  const k = keyOf(node, key);
  if (node.$el === "Box") {
    if (isHeader(node)) return drawHeader(node, ctx, k);
    const item = itemOf(node);
    if (item) return drawItem(item, ctx, k);
    const group = buttonGroup(node);
    if (group) return <div key={k}>{drawSegments(group, ctx, false)}</div>;
  }
  const kids = node.children.map((c, i) => draw(c, ctx, i, depth + 1));
  switch (node.$el) {
    case "Box": {
      // Entries of a list sit close together: each has its own padding and hover.
      const list = isColumn(node) && node.children.some((c) => itemOf(c) !== null);
      // The band already draws a card around each mod's row: a card at the root isn't drawn twice.
      const root = depth === 0;
      const style: CSSProperties = {
        display: p.display === "none" ? "none" : "flex",
        flexDirection: p.flexDirection === "column" || p.flexDirection === "column-reverse" || p.flexDirection === "row-reverse" ? p.flexDirection : "row",
        flexWrap: p.flexWrap === "wrap" ? "wrap" : undefined,
        justifyContent: typeof p.justifyContent === "string" ? p.justifyContent : undefined,
        alignItems: typeof p.alignItems === "string" ? p.alignItems : undefined,
        flexGrow: typeof p.flexGrow === "number" ? p.flexGrow : undefined,
        flexShrink: typeof p.flexShrink === "number" ? p.flexShrink : undefined,
        gap: list ? 2 : space(p.gap),
        columnGap: space(p.columnGap),
        rowGap: list ? undefined : space(p.rowGap),
        padding: root ? undefined : space(p.padding),
        paddingLeft: root ? undefined : space(p.paddingX ?? p.paddingLeft),
        paddingRight: root ? undefined : space(p.paddingX ?? p.paddingRight),
        paddingTop: root ? undefined : space(p.paddingY ?? p.paddingTop),
        paddingBottom: root ? undefined : space(p.paddingY ?? p.paddingBottom),
        margin: space(p.margin),
        marginTop: space(p.marginY ?? p.marginTop),
        marginBottom: space(p.marginY ?? p.marginBottom),
        width: size(p.width),
        height: size(p.height),
        minWidth: 0,
        backgroundColor: p.backgroundColor === "transparent" ? "transparent" : color(p.backgroundColor),
        borderColor: color(p.borderColor),
      };
      const bordered = !root && typeof p.borderStyle === "string" && p.borderStyle !== "none";
      return (
        <div key={k} style={style} className={cn(bordered && "rounded-[8px] border border-bg-300 py-2", bordered && p.paddingX === undefined && "px-3")}>
          {kids}
        </div>
      );
    }
    case "Text": {
      if (p.size === "heading") {
        return (
          <p key={k} className="px-2 pb-0.5 pt-2 text-[12px] font-medium text-text-400">
            {kids}
          </p>
        );
      }
      const style: CSSProperties = { color: color(p.color) ?? (p.dimColor ? "var(--text-400)" : undefined), backgroundColor: color(p.backgroundColor) };
      return (
        <span
          key={k}
          style={style}
          className={cn(
            "min-w-0 text-[13px]",
            !!p.bold && "font-medium text-text-100",
            !!p.italic && "italic",
            !!p.underline && "underline",
            !!p.strikethrough && "line-through",
            p.wrap === "truncate" || p.wrap === "truncate-end" ? "truncate" : "whitespace-pre-wrap break-words",
          )}
        >
          {kids}
        </span>
      );
    }
    case "Button": {
      const label = typeof p.label === "string" && p.label ? p.label : null;
      const onPress = pressOf(node);
      const primary = p.variant === "primary";
      // `autoFocus` isn't followed: a mod's card never takes the keyboard from the chat box.
      return (
        <button
          key={k}
          type="button"
          disabled={!!p.disabled || onPress === null}
          onClick={() => onPress !== null && ctx.press(onPress)}
          className={cn(
            "inline-flex h-7 shrink-0 items-center gap-1 rounded-[6px] px-2.5 text-[12.5px] transition-colors disabled:opacity-50",
            primary ? "bg-accent text-white hover:bg-accent-hover" : "border border-bg-300 text-text-200 hover:bg-bg-200 hover:text-text-100",
          )}
        >
          {label ?? kids}
        </button>
      );
    }
    case "Svg": {
      const source = typeof p.source === "string" ? p.source : "";
      if (!source || source.length > MAX_SVG) return null;
      return <img key={k} src={svgSource(source)} alt={typeof p.alt === "string" ? p.alt : ""} className="max-w-full" draggable={false} />;
    }
    case "Link": {
      const href = typeof p.href === "string" && /^(https?|file):/i.test(p.href) ? p.href : undefined;
      return (
        <a key={k} href={href} target="_blank" rel="noreferrer" className="text-[13px] text-[var(--link)] underline underline-offset-2">
          {kids.length ? kids : href}
        </a>
      );
    }
    case "Markdown":
      return (
        <div key={k} className="whitespace-pre-wrap break-words text-[13px] text-text-200">
          {typeof p.text === "string" ? p.text : kids}
        </div>
      );
    case "Code":
      return (
        <pre key={k} className="overflow-x-auto rounded-[6px] bg-bg-200 px-2 py-1.5 font-mono text-[12px] text-text-200">
          {typeof p.source === "string" ? p.source : kids}
        </pre>
      );
    case "Progress": {
      const max = typeof p.max === "number" && p.max > 0 ? p.max : 1;
      const value = typeof p.value === "number" ? Math.max(0, Math.min(1, p.value / max)) : null;
      return (
        <div key={k} className="flex min-w-0 items-center gap-2 text-[12.5px] text-text-300">
          {typeof p.label === "string" && <span className="truncate">{p.label}</span>}
          <span className="h-1 w-20 shrink-0 overflow-hidden rounded-full bg-bg-300" aria-hidden>
            <span className={cn("block h-full rounded-full bg-accent", value === null && "w-1/3 animate-pulse")} style={value === null ? undefined : { width: `${value * 100}%` }} />
          </span>
        </div>
      );
    }
    case "Newline":
      return <br key={k} />;
    case "Spacer":
      return <span key={k} className="flex-1" />;
    case "Divider":
      return <hr key={k} className="w-full border-bg-300" />;
    default:
      return null;
  }
}

export function ModTree({ tree, onPress }: { tree: RenderNode; onPress: (fn: number, args?: unknown[]) => void }) {
  return <>{draw(tree, { press: onPress }, 0, 0)}</>;
}
