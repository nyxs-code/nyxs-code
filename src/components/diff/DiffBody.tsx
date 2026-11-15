import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n";
import { langFromPath, tokenize } from "@/lib/highlight";
import { useExpansion } from "./expansion";
import type { DiffFile, Row } from "./parse";
import type { Settings } from "./settings";
import { useWordMarks, type Ranges } from "./wordDiff";
import { CommentButton, LineComments, type LineTarget } from "./DiffComments";

/** Syntax-highlighted line text with the changed character ranges marked. */
function LineText({ text, lang, marks, tone }: { text: string; lang: string; marks?: Ranges; tone?: "add" | "del" }) {
  const tokens = useMemo(() => tokenize(text, lang), [text, lang]);
  if (!text) return <>{" "}</>;
  if (!marks?.length) return <>{tokens.map((t, i) => <span key={i} className={t.cls}>{t.text}</span>)}</>;
  const mark = tone === "add" ? "bg-[rgba(46,160,67,0.28)] rounded-[2px]" : "bg-[rgba(248,81,73,0.28)] rounded-[2px]";
  const out: React.ReactNode[] = [];
  let pos = 0;
  tokens.forEach((t, ti) => {
    const start = pos;
    const end = pos + t.text.length;
    pos = end;
    const cuts = new Set<number>([start, end]);
    for (const [a, b] of marks) {
      if (a > start && a < end) cuts.add(a);
      if (b > start && b < end) cuts.add(b);
    }
    const points = [...cuts].sort((x, y) => x - y);
    for (let p = 0; p < points.length - 1; p++) {
      const a = points[p];
      const b = points[p + 1];
      const inMark = marks.some(([m0, m1]) => a >= m0 && b <= m1);
      out.push(
        <span key={`${ti}-${a}`} className={cn(t.cls, inMark && mark)}>
          {t.text.slice(a - start, b - start)}
        </span>,
      );
    }
  });
  return <>{out}</>;
}

const ROW_BG = { add: "bg-[color:var(--code-addBg)]", del: "bg-[color:var(--code-delBg)]", context: "" } as const;
const MARKER = { add: "+", del: "-", context: " " } as const;
// A solid bar down the left edge of changed lines, so changes stand out while scrolling.
const ROW_BAR = {
  add: "border-l-[3px] border-l-green-600 dark:border-l-green-500",
  del: "border-l-[3px] border-l-red-600 dark:border-l-red-500",
  context: "border-l-[3px] border-l-transparent",
} as const;

function GapRow({ count, onExpand }: { count: number | null; onExpand: () => void }) {
  const t = useTranslations().views;
  return (
    <button
      type="button"
      onClick={onExpand}
      className="w-full flex items-center gap-2 px-3 py-1 text-left text-[12px] font-sans text-text-400 bg-bg-200/50 hover:bg-bg-200 hover:text-text-200 transition-colors"
    >
      <ChevronsUpDown className="w-3.5 h-3.5" />
      {count === null ? t.diffShowMore : t.diffUnmodified.replace("{n}", String(count))}
    </button>
  );
}

/** A removed line is commented by its old number, every other line by its new one. */
function targetOf(row: Row | undefined, side: "old" | "new"): LineTarget | null {
  const line = side === "old" ? row?.oldLn : row?.newLn;
  return row && line ? { side, line, code: row.text } : null;
}

const keyOf = (t: LineTarget | null) => (t ? `${t.side}:${t.line}` : "");

export function UnifiedBody({ file, settings, workspace }: { file: DiffFile; settings: Settings; workspace: string }) {
  const lang = langFromPath(file.path);
  const { view, expand } = useExpansion(file, workspace);
  const marks = useWordMarks(file, settings.wordHighlight);
  // The line a comment is being written on.
  const [writing, setWriting] = useState("");
  const under = (target: LineTarget | null) => (
    <LineComments workspace={workspace} path={file.path} target={target} writing={!!target && writing === keyOf(target)} onDone={() => setWriting("")} />
  );
  const renderRow = (row: Row, key: string) => {
    const target = targetOf(row, row.type === "del" ? "old" : "new");
    return (
      <Fragment key={key}>
        <div className={cn("group/line relative flex", ROW_BG[row.type], ROW_BAR[row.type])}>
          {target && <CommentButton onClick={() => setWriting(keyOf(target))} />}
          <span className="w-12 shrink-0 pr-3 text-right select-none text-[color:var(--code-line)]">{row.newLn ?? row.oldLn}</span>
          <span className={cn("w-4 shrink-0 select-none", row.type === "add" ? "text-green-600" : row.type === "del" ? "text-red-500" : "")}>
            {MARKER[row.type]}
          </span>
          <span className={cn("min-w-0 pr-4", settings.wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre")}>
            <LineText text={row.text} lang={lang} marks={marks.get(row)} tone={row.type === "add" ? "add" : "del"} />
          </span>
        </div>
        {under(target)}
      </Fragment>
    );
  };
  return (
    <div className={cn("font-mono text-[12px] leading-[20px] py-1", !settings.wrap && "overflow-x-auto custom-scrollbar")}>
      <div className={cn(!settings.wrap && "min-w-max")}>
        {view.map((seg) =>
          seg.kind === "rows" ? (
            <Fragment key={seg.key}>{seg.rows.map((r, i) => renderRow(r, `${seg.key}-${i}`))}</Fragment>
          ) : (
            <GapRow key={seg.key} count={seg.count} onExpand={() => expand(seg.key)} />
          ),
        )}
      </div>
    </div>
  );
}

type Side = { row?: Row };

/** Pairs each run of removed lines with the run of added lines after it, row by row. */
function sideRows(rows: Row[]): [Side, Side][] {
  const out: [Side, Side][] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].type === "context") { out.push([{ row: rows[i] }, { row: rows[i] }]); i++; continue; }
    let j = i;
    while (j < rows.length && rows[j].type === "del") j++;
    let k = j;
    while (k < rows.length && rows[k].type === "add") k++;
    const dels = rows.slice(i, j);
    const adds = rows.slice(j, k);
    for (let p = 0; p < Math.max(dels.length, adds.length); p++) out.push([{ row: dels[p] }, { row: adds[p] }]);
    i = k === i ? i + 1 : k;
  }
  return out;
}

export function SplitBody({ file, settings, workspace }: { file: DiffFile; settings: Settings; workspace: string }) {
  const lang = langFromPath(file.path);
  const { view, expand } = useExpansion(file, workspace);
  const marks = useWordMarks(file, settings.wordHighlight);
  const [writing, setWriting] = useState("");
  const under = (target: LineTarget | null) => (
    <LineComments workspace={workspace} path={file.path} target={target} writing={!!target && writing === keyOf(target)} onDone={() => setWriting("")} />
  );
  // An unchanged line shows on both sides: it's commented on the new side only.
  const sideTarget = (side: Side, which: "old" | "new") =>
    which === "old" && side.row?.type === "context" ? null : targetOf(side.row, which);

  const cell = (side: Side, which: "old" | "new") => {
    const row = side.row;
    const ln = row ? (which === "old" ? row.oldLn : row.newLn) : undefined;
    const target = sideTarget(side, which);
    const tone =
      row?.type === "context" || !row
        ? ROW_BAR.context
        : which === "old"
          ? cn(ROW_BG.del, ROW_BAR.del)
          : cn(ROW_BG.add, ROW_BAR.add);
    return (
      <div className={cn("group/line relative flex min-w-0 flex-1", tone, !row && "bg-bg-200/40")}>
        {target && <CommentButton onClick={() => setWriting(keyOf(target))} />}
        <span className="w-10 shrink-0 pr-2 text-right select-none text-[color:var(--code-line)]">{ln ?? ""}</span>
        <span className={cn("min-w-0 flex-1 pr-3", settings.wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre overflow-hidden")}>
          {row ? <LineText text={row.text} lang={lang} marks={marks.get(row)} tone={which === "new" ? "add" : "del"} /> : null}
        </span>
      </div>
    );
  };

  return (
    <div className="font-mono text-[12px] leading-[20px] py-1">
      {view.map((seg) =>
        seg.kind === "rows" ? (
          <Fragment key={seg.key}>
            {sideRows(seg.rows).map(([l, r], i) => (
              <Fragment key={`${seg.key}-${i}`}>
                <div className="flex divide-x divide-bg-300">
                  {cell(l, "old")}
                  {cell(r, "new")}
                </div>
                {under(sideTarget(l, "old"))}
                {under(sideTarget(r, "new"))}
              </Fragment>
            ))}
          </Fragment>
        ) : (
          <GapRow key={seg.key} count={seg.count} onExpand={() => expand(seg.key)} />
        ),
      )}
    </div>
  );
}

/** Draws a file's diff only when it scrolls near the view (thousands of highlighted lines at
 *  once froze the panel on open). Until then it holds about the same height, so the scroll
 *  bar and "jump to file" stay right. */
export function LazyBody({ file, root, children }: { file: DiffFile; root: React.RefObject<HTMLDivElement | null>; children: () => React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (shown) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { root: root.current, rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown, root]);
  const rows = file.hunks.reduce((n, h) => n + h.rows.length, 0);
  const estimate = rows * 20 + (file.hunks.length + 1) * 24 + 8;
  return (
    <div ref={ref} style={shown ? undefined : { height: estimate }}>
      {shown ? children() : null}
    </div>
  );
}

export function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 flex items-center gap-1 text-[11.5px] font-mono tabular-nums">
      <span className="text-green-600 dark:text-green-400">+{added}</span>
      <span className="text-red-500 dark:text-red-400">-{removed}</span>
    </span>
  );
}
