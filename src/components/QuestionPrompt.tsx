import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, CornerDownLeft, Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n";
import type { AskQuestion, AskAnswer } from "@/lib/agentTools";
import { isComposingKey } from "@/lib/imeKeys";

/** One pickable line, in the order it is drawn — which is also the order the letters
 *  are handed out, so `A` is always the top row on screen. */
interface Row {
  label: string;
  description?: string;
  recommended: boolean;
  /** The "Other…" line: picking it opens the box to type an answer instead. */
  other: boolean;
}

// The model marks its pick by ending the label with "(Recommended)"; the card shows that
// as its own grey tag, so the answer sent back is the bare label.
const RECOMMENDED_RE = /\s*\((recommended|recomendad[oa])\)\s*$/i;

function rowsOf(q: AskQuestion, otherLabel: string): Row[] {
  const rows: Row[] = q.options
    .map((opt) => ({
      label: opt.label.replace(RECOMMENDED_RE, ""),
      description: opt.description,
      recommended: RECOMMENDED_RE.test(opt.label),
      other: false,
    }))
    .sort((a, b) => Number(b.recommended) - Number(a.recommended));
  if (q.options.length > 0) rows.push({ label: otherLabel, recommended: false, other: true });
  return rows;
}

/** The agent's questions (AskUserQuestion), one at a time with a counter, answerable from
 *  the keyboard once the card has focus: letters pick, Enter advances, arrows turn pages. */
export function QuestionPrompt({
  questions,
  onAnswer,
  onDismiss,
}: {
  questions: AskQuestion[];
  onAnswer: (answers: AskAnswer[]) => void;
  onDismiss: () => void;
}) {
  const t = useTranslations().question;
  const [sel, setSel] = useState<string[][]>(() => questions.map(() => []));
  const [other, setOther] = useState<boolean[]>(() => questions.map(() => false));
  const [typed, setTyped] = useState<string[]>(() => questions.map(() => ""));
  const [page, setPage] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const freeRef = useRef<HTMLInputElement>(null);

  const total = questions.length;
  const qi = Math.min(page, total - 1);
  const q = questions[qi];
  const rows = rowsOf(q, t.other);
  // A question with no options can only be answered by typing.
  const typing = q.options.length === 0 || (other[qi] ?? false);

  // Turning the page carries the keyboard with it; the first render is skipped so a card
  // appearing does not pull the caret out of the composer.
  const settled = useRef(false);
  useEffect(() => {
    if (!settled.current) { settled.current = true; return; }
    if (questions[qi]?.options.length === 0) freeRef.current?.focus();
    else cardRef.current?.focus();
  }, [qi, questions]);

  const setAt = <T,>(arr: T[], i: number, v: T): T[] => questions.map((_, k) => (k === i ? v : arr[k]));

  const pick = (row: Row) => {
    if (row.other) {
      setOther((prev) => setAt(prev, qi, !(prev[qi] ?? false)));
      // On a single-choice question the typed answer replaces the picked option.
      if (!q.multiSelect) setSel((prev) => setAt(prev, qi, []));
      requestAnimationFrame(() => freeRef.current?.focus());
      return;
    }
    setSel((prev) => {
      const cur = prev[qi] ?? [];
      if (q.multiSelect) return setAt(prev, qi, cur.includes(row.label) ? cur.filter((l) => l !== row.label) : [...cur, row.label]);
      return setAt(prev, qi, cur[0] === row.label ? [] : [row.label]);
    });
    if (!q.multiSelect && (other[qi] ?? false)) setOther((prev) => setAt(prev, qi, false));
  };

  const lit = (row: Row) => (row.other ? typing : (sel[qi] ?? []).includes(row.label));

  const answerFor = (i: number): string[] => {
    const question = questions[i];
    if (!question) return [];
    const picked = sel[i] ?? [];
    const open = question.options.length === 0 || (other[i] ?? false);
    const free = open ? (typed[i] ?? "").trim() : "";
    if (question.multiSelect) return free ? [...picked, free] : picked;
    if (free) return [free];
    return open ? [] : picked;
  };
  const answered = (i: number) => answerFor(i).length > 0;
  const ready = answered(qi);

  const last = qi === total - 1;
  // On the last page, Next walks back to the first question still unanswered.
  const missing = questions.findIndex((_, i) => !answered(i));
  const submits = last && missing < 0;
  const go = () => {
    if (!ready) return;
    if (submits) {
      onAnswer(questions.map((question, i) => ({ question: question.question, answer: answerFor(i).join(", ") })));
      return;
    }
    setPage(last ? missing : qi + 1);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !isComposingKey(e)) { e.preventDefault(); go(); return; }
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === "ArrowRight" && !last) { e.preventDefault(); setPage(qi + 1); return; }
    if (e.key === "ArrowLeft" && qi > 0) { e.preventDefault(); setPage(qi - 1); return; }
    if (e.key.length !== 1) return;
    const at = e.key.toLowerCase().charCodeAt(0) - 97;
    if (at >= 0 && at < rows.length) { e.preventDefault(); pick(rows[at]); }
  };

  const counter = t.ofCount.replace("{n}", String(qi + 1)).replace("{m}", String(total));

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="mb-2 rounded-[8px] border border-bg-300 bg-bg-100 shadow-sm overflow-hidden animate-fade-in outline-none"
    >
      <div className="flex items-center gap-2 pl-3 pr-2 py-2">
        <span className="flex-1 min-w-0 text-[12px] text-text-400">{t.title}</span>
        {collapsed && total > 1 && <span className="text-[12px] text-text-400 tabular-nums">{counter}</span>}
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? t.expand : t.minimize}
          aria-expanded={!collapsed}
          className="shrink-0 inline-flex items-center justify-center h-6 w-6 rounded-md text-text-400 hover:text-text-200 hover:bg-bg-200 transition-colors"
        >
          {collapsed ? <Plus className="w-3.5 h-3.5" /> : <Minus className="w-3.5 h-3.5" />}
        </button>
      </div>

      {!collapsed && (
        <>
          <div className="px-3 pb-2">
            <div className="flex items-baseline gap-2 mb-2">
              {q.header && (
                <span className="text-[10.5px] font-semibold uppercase tracking-wide text-accent shrink-0">{q.header}</span>
              )}
              <span className="text-[15px] text-text-100">{q.question}</span>
            </div>

            <div className="flex flex-col">
              {rows.map((row, i) => {
                const chosen = lit(row);
                return (
                  <button
                    key={`${row.label}-${i}`}
                    type="button"
                    onClick={() => pick(row)}
                    aria-pressed={chosen}
                    data-tooltip={row.description}
                    className={cn(
                      "w-full flex items-center gap-2.5 px-2 h-8 rounded-md text-left transition-colors",
                      chosen ? "bg-bg-200" : "hover:bg-bg-200/60",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "shrink-0 inline-flex items-center justify-center h-5 w-5 rounded text-[11px] font-medium transition-colors",
                        chosen ? "bg-accent/20 text-accent" : "bg-bg-200 text-text-400",
                      )}
                    >
                      {String.fromCharCode(65 + i)}
                    </span>
                    <span className={cn("min-w-0 truncate text-[13px]", row.other ? "text-text-400" : "text-text-200")}>
                      {row.label}
                    </span>
                    {row.recommended && <span className="shrink-0 text-[11px] text-text-400">{t.recommended}</span>}
                  </button>
                );
              })}
            </div>

            {typing && (
              <input
                ref={freeRef}
                type="text"
                value={typed[qi] ?? ""}
                onChange={(e) => setTyped((prev) => setAt(prev, qi, e.target.value))}
                placeholder={q.options.length > 0 ? t.otherPlaceholder : t.typeAnswer}
                className={cn(
                  "w-full rounded-md border border-bg-300 bg-bg-100 px-2.5 py-1.5 text-[13px] text-text-100",
                  "placeholder:text-text-500 focus:border-accent focus:outline-none transition",
                  q.options.length > 0 && "mt-1.5",
                )}
              />
            )}
            {q.multiSelect && q.options.length > 0 && <p className="text-[10.5px] text-text-400 mt-1.5 px-2">{t.pickSeveral}</p>}
          </div>

          <div className="flex items-center gap-2 px-2 py-2">
            {total > 1 && (
              <div className="flex items-center gap-0.5 text-[12px] text-text-400">
                <button
                  type="button"
                  onClick={() => setPage(qi - 1)}
                  disabled={qi === 0}
                  aria-label={t.prevQuestion}
                  className="inline-flex items-center justify-center h-6 w-6 rounded-md hover:text-text-200 hover:bg-bg-200 disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <span className="tabular-nums px-0.5">{counter}</span>
                <button
                  type="button"
                  onClick={() => setPage(qi + 1)}
                  disabled={last}
                  aria-label={t.nextQuestion}
                  className="inline-flex items-center justify-center h-6 w-6 rounded-md hover:text-text-200 hover:bg-bg-200 disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
            <div className="flex-1" />
            {/* Skip answers the whole card: the agent is waiting on all of it. */}
            <button
              type="button"
              onClick={onDismiss}
              className="inline-flex items-center h-7 px-2.5 rounded-md text-[13px] text-text-400 hover:text-text-200 hover:bg-bg-200 transition-colors"
            >
              {t.skip}
            </button>
            <button
              type="button"
              onClick={go}
              disabled={!ready}
              className={cn(
                "inline-flex items-center gap-1.5 h-7 px-3 rounded-md text-[13px] font-medium transition-colors",
                ready ? "bg-accent text-white hover:bg-accent-hover active:scale-95" : "bg-bg-200 text-text-500 cursor-default",
              )}
            >
              {submits ? t.send : t.next}
              <CornerDownLeft className="w-3 h-3 opacity-70" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default QuestionPrompt;
