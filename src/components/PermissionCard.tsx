import { useEffect, useRef, useState } from "react";
import { ChevronDown, FileText, Terminal, TriangleAlert, Wrench } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import {
  EDIT_TOOLS,
  commandAnalysisFor,
  formatRule,
  isProtectedConfigTarget,
  permissionKey,
  suggestPrefixRule,
  type PermissionRule,
} from "@/lib/permissions";
import type { CommandRisk } from "@/lib/bashSafety";
import { cn } from "@/lib/utils";

export interface PermissionDecision {
  allow: boolean;
  rule: PermissionRule | null;
}

/** Amber for both: red made a routine `rm -rf dist` look like an alarm. A destructive command
 *  still stands out by its amber border and icon, and by Reject taking the focus (when the
 *  user isn't typing). */
const RISK_BADGE: Record<Exclude<CommandRisk, "safe">, string> = {
  dangerous: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
  destructive: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
};

/** Lines of a command shown before "Show full command": enough to recognize it. */
const COLLAPSED_LINES = 3;

const SECONDARY_BUTTON =
  "px-4 py-1.5 rounded-[6px] text-[12.5px] font-medium text-text-200 bg-bg-0 border border-bg-300 hover:bg-bg-200 active:scale-95 transition";

/** Permission card: what the agent wants to run, why it needs a look as warning chips, the
 *  command folded to its first lines, and Reject / Always allow / Allow once in the footer. */
export function PermissionCard({
  toolName,
  input,
  label,
  queued,
  onRespond,
}: {
  toolName: string;
  input: unknown;
  label: string;
  queued: number;
  onRespond: (decision: PermissionDecision) => void;
}) {
  const all = useTranslations();
  const tApp = all.app;
  const t = all.consent;
  const key = permissionKey(toolName, input);
  const analysis = commandAnalysisFor(toolName, input);
  const protectedTarget = isProtectedConfigTarget(toolName, input);
  const baseRisk: CommandRisk = analysis?.risk ?? (EDIT_TOOLS.has(toolName) ? "dangerous" : "safe");
  const risk: CommandRisk = protectedTarget && baseRisk === "safe" ? "dangerous" : baseRisk;
  const destructive = risk === "destructive";
  const prefixRule = suggestPrefixRule(toolName, input);
  const reasons = Array.from(
    new Set([
      ...(protectedTarget ? [t.protectedConfig] : []),
      ...(analysis?.findings ?? []).filter((f) => f.risk !== "safe").map((f) => f.reason),
    ]),
  ).slice(0, 3);
  const isCommand = toolName === "Bash" && !!key;
  const isFile = EDIT_TOOLS.has(toolName) && !!key;
  const Icon = destructive ? TriangleAlert :isCommand ? Terminal : isFile ? FileText : Wrench;
  const [ruleBefore, ruleAfter = ""] = t.allowRule.split("{rule}");
  const allowTool = !destructive && !protectedTarget;
  const lines = (key ?? "").split("\n");
  const long = lines.length > COLLAPSED_LINES;
  const [expanded, setExpanded] = useState(false);
  const shownLines = long && !expanded ? lines.slice(0, COLLAPSED_LINES) : lines;
  // The button takes the narrowest "always": the command's prefix when there is one, else the
  // whole tool. The tool-wide one stays a quiet link when the button already shows the prefix.
  const alwaysRule: PermissionRule | null = prefixRule ?? (allowTool ? { toolName, behavior: "allow" } : null);
  const toolLink = !!prefixRule && allowTool;
  // The card takes the keyboard (Reject for a destructive command, else Allow once) unless the
  // user is typing: a card appearing mid-sentence would take the next key as the answer.
  const rejectRef = useRef<HTMLButtonElement>(null);
  const allowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && (active.isContentEditable || active.closest("input, textarea, select, [contenteditable='true']"))) return;
    (destructive ? rejectRef : allowRef).current?.focus();
    // Once, when the card appears: each request mounts its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      role="alertdialog"
      aria-live="polite"
      aria-label={tApp.allowAction}
      className={cn(
        "rounded-[8px] border bg-bg-100 px-4 py-2.5 shadow-[0_1px_3px_rgba(0,0,0,0.06)] animate-fade-in",
        destructive ? "border-yellow-500/50" : "border-bg-300",
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-text-100 min-w-0">
          <Icon className={cn("w-3.5 h-3.5 shrink-0", destructive ? "text-yellow-600 dark:text-yellow-400" : "text-text-300")} />
          <span className="shrink-0">{tApp.allowAction}</span>
          <span className="min-w-0 truncate font-normal text-text-400">· {toolName}</span>
          {risk !== "safe" && (
            <span className={cn("shrink-0 rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide", RISK_BADGE[risk])}>
              {risk === "dangerous" ? t.riskDangerous : t.riskDestructive}
            </span>
          )}
          {queued > 0 && <span className="ml-auto shrink-0 text-[11px] font-normal text-text-400">{tApp.queued.replace("{count}", String(queued))}</span>}
        </div>

        {reasons.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {reasons.map((r) => (
              <span
                key={r}
                className={cn(
                  "inline-flex max-w-full items-center gap-1 rounded-[6px] px-2 py-0.5 text-[12px] leading-snug",
                  destructive ? RISK_BADGE.destructive : RISK_BADGE.dangerous,
                )}
              >
                <TriangleAlert className="h-3 w-3 shrink-0" />
                <span className="min-w-0 break-words">{r}</span>
              </span>
            ))}
          </div>
        )}

        {isCommand || isFile ? (
          <>
            <div className="relative mt-2">
              <pre
                className={cn(
                  "custom-scrollbar overflow-x-auto rounded-[6px] bg-bg-200/60 px-2.5 py-1.5 font-mono text-[12px] leading-[1.45] text-text-200",
                  expanded && "max-h-72 overflow-y-auto",
                )}
              >
                {shownLines.map((line, i) => (
                  <div key={i} className="flex">
                    {lines.length > 1 && (
                      <span className="w-6 shrink-0 select-none text-right pr-2.5 text-text-500">{i + 1}</span>
                    )}
                    <span className="whitespace-pre">{line || " "}</span>
                  </div>
                ))}
              </pre>
              {long && !expanded && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 rounded-b-[6px] bg-gradient-to-b from-transparent to-bg-200" />
              )}
            </div>
            {long && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="mt-1 inline-flex items-center gap-1 text-[12px] text-accent-main-100 hover:underline"
              >
                <ChevronDown className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")} />
                {expanded ? t.hideCommand : t.showFullCommand.replace("{count}", String(lines.length))}
              </button>
            )}
          </>
        ) : (
          <p className="mt-0.5 break-words text-[12px] leading-snug text-text-400">{label}</p>
        )}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
        {toolLink && (
          <button
            type="button"
            onClick={() => onRespond({ allow: true, rule: { toolName, behavior: "allow" } })}
            className="mr-auto text-[12px] text-text-400 hover:text-text-100 transition-colors"
          >
            {t.allowTool.replace("{tool}", toolName)}
          </button>
        )}
        <button
          type="button"
          ref={rejectRef}
          onClick={() => onRespond({ allow: false, rule: null })}
          className={SECONDARY_BUTTON}
        >
          {tApp.reject}
        </button>
        {alwaysRule && (
          <button
            type="button"
            onClick={() => onRespond({ allow: true, rule: alwaysRule })}
            data-tooltip={formatRule(alwaysRule)}
            className={cn(SECONDARY_BUTTON, "max-w-[260px] truncate")}
          >
            {alwaysRule.ruleContent ? (
              <>
                {ruleBefore}
                <code className="font-mono text-[11.5px]">{alwaysRule.ruleContent}</code>
                {ruleAfter}
              </>
            ) : (
              t.allowTool.replace("{tool}", toolName)
            )}
          </button>
        )}
        <button
          type="button"
          ref={allowRef}
          onClick={() => onRespond({ allow: true, rule: null })}
          className="px-4 py-1.5 rounded-[6px] text-[12.5px] font-semibold bg-text-100 text-bg-0 hover:opacity-90 active:scale-95 transition"
        >
          {tApp.allowOnce}
        </button>
      </div>
    </div>
  );
}
