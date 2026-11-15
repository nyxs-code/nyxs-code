import { useMemo, useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n";
import { tokenize } from "@/lib/highlight";
import type { DiffLine } from "@/lib/agentTools";
import { diffWordMarks, foldDiff, splitTokens, type Ranges } from "@/lib/diffLayout";

const marker = (type: DiffLine["type"]) => (type === "add" ? "+" : type === "del" ? "−" : "");

/** One gutter, like Claude's: the line's number in the new file, and a removed line's in the old
 *  one, so the numbers run on without repeating around the change. */
function lineNumbers(diff: DiffLine[]): (number | undefined)[] {
  const hasLn = diff.some((l) => l.ln !== undefined);
  let n = 0;
  // Diffs saved before context lines carried `newLn`: added minus removed lines so far is how
  // far the new file has moved from the old one.
  let shift = 0;
  return diff.map((l) => {
    if (l.type === "hunk") return undefined;
    if (!hasLn) return l.type === "del" ? undefined : ++n;
    if (l.type === "add") {
      shift++;
      return l.ln;
    }
    if (l.type === "del") {
      shift--;
      return l.ln;
    }
    return l.newLn ?? (l.ln !== undefined ? l.ln + shift : undefined);
  });
}

/** The line's own tint again on a changed word: the token is translucent, so it doubles up.
 *  Square, because a changed stretch is several highlight tokens side by side. */
const MARK = { add: "bg-[color:var(--code-addBg)]", del: "bg-[color:var(--code-delBg)]" } as const;

/** Syntax-highlighted line text with the changed words marked. */
function LineText({ text, lang, marks, tone }: { text: string; lang: string; marks?: Ranges; tone: DiffLine["type"] }) {
  const parts = useMemo(() => splitTokens(tokenize(text, lang), marks ?? []), [text, lang, marks]);
  if (!text) return <>{" "}</>;
  return (
    <>
      {parts.map((t, i) => (
        <span key={i} className={cn(t.cls, t.marked && (tone === "add" || tone === "del") && MARK[tone])}>
          {t.text}
        </span>
      ))}
    </>
  );
}

export function DiffView({
  diff,
  lang = "text",
  embedded = false,
  className,
}: {
  diff: DiffLine[];
  lang?: string;
  embedded?: boolean;
  className?: string;
}) {
  const t = useTranslations().views;
  const numbers = useMemo(() => lineNumbers(diff), [diff]);
  const marks = useMemo(() => diffWordMarks(diff), [diff]);
  const segments = useMemo(() => foldDiff(diff), [diff]);
  // Folds the user opened, by their first line.
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set());

  const renderLine = (i: number) => {
    const line = diff[i];
    if (line.type === "hunk") {
      return (
        <div key={i} className="px-3 text-[color:var(--code-line)] select-none whitespace-pre">
          {line.text}
        </div>
      );
    }
    return (
      <div
        key={i}
        className={cn(
          "flex pl-1 pr-3",
          line.type === "add" && "bg-[color:var(--code-addBg)]",
          line.type === "del" && "bg-[color:var(--code-delBg)]",
        )}
      >
        <span className="select-none w-10 shrink-0 pr-3 text-right text-[color:var(--code-line)]">{numbers[i] ?? ""}</span>
        <span
          className={cn(
            "select-none w-4 shrink-0 text-center opacity-70",
            line.type === "add" && "text-green-400",
            line.type === "del" && "text-red-400",
          )}
        >
          {marker(line.type)}
        </span>
        {/* Long lines wrap under the code, never under the gutters: no sideways scroll. */}
        <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
          <LineText text={line.text} lang={lang} marks={marks.get(i)} tone={line.type} />
        </span>
      </div>
    );
  };

  const lines = (start: number, end: number) => Array.from({ length: end - start }, (_, k) => renderLine(start + k));

  return (
    <pre
      className={cn(
        "overflow-y-auto overflow-x-hidden custom-scrollbar bg-bg-0 text-[12px] leading-relaxed",
        embedded ? "" : "mt-1 mb-2 max-h-80 rounded-lg border border-bg-300",
        className,
      )}
    >
      {segments.map((seg) =>
        seg.kind === "lines" || opened.has(seg.start) ? (
          lines(seg.start, seg.end)
        ) : (
          <button
            key={`fold-${seg.start}`}
            type="button"
            onClick={() => setOpened((s) => new Set(s).add(seg.start))}
            className="w-full flex items-center gap-2 pl-6 pr-3 py-0.5 text-left font-sans text-[11.5px] text-[color:var(--code-line)] bg-bg-200/50 hover:bg-bg-200 hover:text-text-200 transition-colors select-none"
          >
            <ChevronsUpDown className="w-3.5 h-3.5 shrink-0" />
            {t.diffUnmodified.replace("{n}", String(seg.end - seg.start))}
          </button>
        ),
      )}
    </pre>
  );
}

export default DiffView;
