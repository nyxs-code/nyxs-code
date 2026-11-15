import { useTranslations } from "@/lib/i18n";
import { baseName } from "@/lib/review/paths";
import type { ToolDetail } from "@/lib/agentTools";
import { FileIcon } from "@/components/views/FileIcon";
import { toolCompleted, type ToolEnd } from "./parse";
import { FILE_EDIT_TOOLS } from "./toolFormat";

/** Rows shown before "View all" takes over; the changes view has the rest. */
const MAX_ROWS = 6;

const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();

/** The folder a file sits in, to tell apart files with the same name (two SKILL.md). */
function parentName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : "";
}

function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-[12px] tabular-nums">
      <span className="text-green-600 dark:text-green-400">+{added}</span>
      <span className="ml-1 text-red-500 dark:text-red-400">−{removed}</span>
    </span>
  );
}

/** "Edited 2 files" under a reply that changed files: one row per file with its own counts, and
 *  "View all" with the totals. The counts are this reply's own edits, the same ones its trace
 *  shows. Clicking a row opens the changes view at that file. */
export function TurnChanges({
  files,
  toolData,
  endMap,
  subagentEdits,
  onReview,
}: {
  files: string[];
  toolData: Record<string, ToolDetail>;
  endMap: Map<string, ToolEnd>;
  /** Files the turn's subagents edited, with their counts (their tool calls aren't in toolData). */
  subagentEdits?: Record<string, { added: number; removed: number }>;
  onReview?: (path?: string) => void;
}) {
  const t = useTranslations().review;

  const edits = Object.entries(toolData).filter(([id, info]) => FILE_EDIT_TOOLS.has(info.name) && toolCompleted(endMap.get(id)));
  const delegated = Object.entries(subagentEdits ?? {});
  const same = (abs: string, other: string) => {
    const p = norm(other);
    return !!p && (p === abs || abs.endsWith(`/${p}`) || p.endsWith(`/${abs}`));
  };
  const rows = files.map((path) => {
    const abs = norm(path);
    let added = 0;
    let removed = 0;
    // Whether anything reported this file's lines: one edited outside what the turn can see (a
    // shell command, a subagent that didn't report back) shows no numbers rather than "+0 −0".
    let known = false;
    for (const [, info] of edits) {
      if (!same(abs, info.detail)) continue;
      known = true;
      added += info.added ?? 0;
      removed += info.removed ?? 0;
    }
    for (const [p, c] of delegated) {
      if (!same(abs, p)) continue;
      known = true;
      added += c.added;
      removed += c.removed;
    }
    return { path, added, removed, known };
  });
  const added = rows.reduce((n, r) => n + r.added, 0);
  const removed = rows.reduce((n, r) => n + r.removed, 0);
  const anyKnown = rows.some((r) => r.known);
  const title = files.length === 1 ? t.filesEditedOne : t.filesEditedMany.replace("{count}", String(files.length));

  const row = "flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left";
  const clickable = onReview ? "hover:bg-bg-200 transition-colors" : "";

  return (
    <div className="mt-2 w-full overflow-hidden rounded-[8px] border border-bg-300 bg-bg-000 text-[13px]">
      <div className="border-b border-bg-300 px-3 py-2 text-text-200">{title}</div>
      <div className="py-1">
        {rows.slice(0, MAX_ROWS).map((r) => (
          <button
            key={r.path}
            type="button"
            disabled={!onReview}
            onClick={() => onReview?.(r.path)}
            className={`${row} ${clickable}`}
          >
            <FileIcon name={baseName(r.path)} className="h-3.5 w-3.5" />
            <span className="shrink-0 text-text-100">{baseName(r.path)}</span>
            <span className="min-w-0 flex-1 truncate text-text-400">{parentName(r.path)}</span>
            {r.known && <Counts added={r.added} removed={r.removed} />}
          </button>
        ))}
        <button type="button" disabled={!onReview} onClick={() => onReview?.()} className={`${row} ${clickable}`}>
          <span className="flex-1 text-text-200">{t.viewAll}</span>
          {anyKnown && <Counts added={added} removed={removed} />}
        </button>
      </div>
    </div>
  );
}

export default TurnChanges;
