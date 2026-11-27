import { useTranslations } from "@/lib/i18n";
import type { ThreadEntry } from "./projectDirectory";

/** "Trabajando · rama fix/x": a thread's state and branch, as its card and row say it. */
export function useThreadLine() {
  const t = useTranslations().projects;
  const group = { waiting: t.statusNeedsInput, working: t.statusWorking, review: t.statusReview, resolved: t.statusResolved, failed: t.statusFailed };
  return (thread: Pick<ThreadEntry, "group" | "status" | "branch">) => {
    const state = thread.group === "resolved" && thread.status === "idle" ? t.statusIdle : group[thread.group];
    return thread.branch ? `${state} · ${t.branch.replace("{branch}", thread.branch)}` : state;
  };
}

export function repliesLabel(t: { replies: string; reply1: string }, n: number): string {
  return n === 1 ? t.reply1 : t.replies.replace("{count}", String(n));
}
