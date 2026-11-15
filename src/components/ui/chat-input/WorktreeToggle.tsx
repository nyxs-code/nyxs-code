import { useEffect, useState } from "react";
import { GitBranch } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { setSessionWorktreeOn, useSessionWorktreeOn } from "@/lib/sessionWorktree";
import { worktreeSupported } from "@/lib/worktree";

/** "Worktree" in a new chat's composer: the session will work in its own copy of the project.
 *  Only shown for a git repository with commits, where a worktree can be made. */
export function WorktreeToggle({ workspace }: { workspace: string | null | undefined }) {
  const t = useTranslations().worktree;
  const on = useSessionWorktreeOn();
  const [supported, setSupported] = useState<{ ws: string; ok: boolean } | null>(null);
  useEffect(() => {
    if (!workspace) return;
    let alive = true;
    void worktreeSupported(workspace).then((ok) => { if (alive) setSupported({ ws: workspace, ok }); });
    return () => { alive = false; };
  }, [workspace]);
  if (!workspace || supported?.ws !== workspace || !supported.ok) return null;
  return (
    <button
      type="button"
      onClick={() => setSessionWorktreeOn(!on)}
      aria-pressed={on}
      className={`inline-flex shrink-0 items-center gap-1.5 h-6 px-1.5 rounded-[5px] text-[12px] transition-colors ${on ? "bg-accent/15 text-accent" : "text-text-300 hover:text-text-100 hover:bg-bg-200"}`}
    >
      <GitBranch className="w-3.5 h-3.5" />
      {t.toggle}
    </button>
  );
}
