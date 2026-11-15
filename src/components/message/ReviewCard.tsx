import { useState } from "react";
import { CheckCircle2, GitCompare, Wrench } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { VISUAL_PROMPT_EVENT } from "@/lib/visualBridge";
import { addDiffComment, openDiff } from "@/lib/diffComments";
import { currentWorkspace } from "@/lib/filePaths";
import { describeFinding, findingWhere, parseReviewReport, type ReviewFinding } from "@/lib/reviewCard";
import { InlineCode } from "./FilePathCode";

const SEVERITY_CLS: Record<ReviewFinding["severity"], string> = {
  high: "bg-red-500/15 text-red-600 dark:text-red-400",
  med: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
  low: "bg-bg-200 text-text-300",
};

const send = (text: string) => window.dispatchEvent(new CustomEvent<string>(VISUAL_PROMPT_EVENT, { detail: text }));

/** The /review report as a card, like Claude Code Desktop's: each finding opens in the diff or
 *  is fixed on its own, and all of them can be walked through in the diff or fixed at once. */
export function ReviewCard({ content, closed }: { content: string; closed: boolean }) {
  const t = useTranslations().reviewCard;
  const report = parseReviewReport(content);
  const [asked, setAsked] = useState<Set<number>>(new Set());
  const [allAsked, setAllAsked] = useState(false);

  if (!report) {
    // Still streaming, or the model wrote broken JSON: say so rather than show raw data.
    return <p className="my-2 text-[13px] text-text-400">{closed ? t.unreadable : t.preparing}</p>;
  }
  const { verdict, findings } = report;
  const counts = (["high", "med", "low"] as const).map((s) => [s, findings.filter((f) => f.severity === s).length] as const);

  const fixOne = (i: number) => {
    send(`${t.fixOnePrompt}\n\n${describeFinding(findings[i], t.fixLabel)}`);
    setAsked((s) => new Set(s).add(i));
  };
  const fixAll = () => {
    send(`${t.fixAllPrompt}\n\n${findings.map((f, i) => `${i + 1}. ${describeFinding(f, t.fixLabel)}`).join("\n\n")}`);
    setAllAsked(true);
  };
  // Each finding becomes a comment on its line of the diff, where it can be edited or dropped
  // and sent back with the others.
  const walkThrough = () => {
    const ws = currentWorkspace();
    if (ws) {
      for (const f of findings) {
        if (f.line) addDiffComment(ws, { path: f.file, side: "new", line: f.line, code: "", text: `${f.title}\n${f.detail}${f.fix ? `\n${t.fixLabel} ${f.fix}` : ""}` });
      }
    }
    openDiff(findings[0]?.file);
  };

  return (
    <div className="my-3 rounded-[8px] border border-bg-300 bg-bg-100">
      <div className="flex flex-wrap items-center gap-2 border-b border-bg-300 px-3 py-2">
        <span className="text-[13px] font-medium text-text-100">{t.title}</span>
        {counts.map(([s, n]) =>
          n ? (
            <span key={s} className={cn("rounded-[4px] px-1.5 py-px text-[11px] font-medium", SEVERITY_CLS[s])}>
              {n} {t[s]}
            </span>
          ) : null,
        )}
        {verdict && <span className="min-w-0 flex-1 truncate text-right text-[12.5px] text-text-300">{verdict}</span>}
      </div>

      {findings.length === 0 ? (
        <div className="flex items-center gap-2 px-3 py-3 text-[13px] text-text-200">
          <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-500" />
          {t.noFindings}
        </div>
      ) : (
        <ol className="divide-y divide-bg-300">
          {findings.map((f, i) => (
            <li key={i} className="px-3 py-2.5">
              <div className="flex items-start gap-2">
                <span className={cn("mt-px shrink-0 rounded-[4px] px-1.5 py-px text-[11px] font-medium", SEVERITY_CLS[f.severity])}>{t[f.severity]}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-text-100">{f.title}</p>
                  <p className="mt-0.5 text-[12.5px] text-text-400">
                    <InlineCode text={findingWhere(f)} />
                  </p>
                  {f.detail && <p className="mt-1 text-[13px] leading-relaxed text-text-200">{f.detail}</p>}
                  {f.fix && (
                    <p className="mt-1 text-[13px] leading-relaxed text-text-300">
                      <span className="font-medium text-text-200">{t.fixLabel}</span> {f.fix}
                    </p>
                  )}
                  <div className="mt-1.5 flex items-center gap-3 text-[12.5px]">
                    <button type="button" onClick={() => openDiff(f.file)} className="text-text-400 hover:text-text-100">
                      {t.showInDiff}
                    </button>
                    <button
                      type="button"
                      onClick={() => fixOne(i)}
                      disabled={asked.has(i) || allAsked}
                      className="text-[color:var(--link)] hover:underline disabled:text-text-500 disabled:no-underline"
                    >
                      {asked.has(i) || allAsked ? t.asked : t.fixOne}
                    </button>
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      {findings.length > 0 && (
        <div className="flex items-center justify-end gap-2 border-t border-bg-300 px-3 py-2">
          <button
            type="button"
            onClick={walkThrough}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-[6px] text-[12.5px] text-text-200 border border-bg-300 bg-bg-0 hover:bg-bg-200"
          >
            <GitCompare className="h-3.5 w-3.5" />
            {t.walkThrough}
          </button>
          <button
            type="button"
            onClick={fixAll}
            disabled={allAsked}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-[6px] text-[12.5px] font-medium bg-text-100 text-bg-0 hover:opacity-90 disabled:opacity-40"
          >
            <Wrench className="h-3.5 w-3.5" />
            {allAsked ? t.asked : t.applyAll}
          </button>
        </div>
      )}
    </div>
  );
}
