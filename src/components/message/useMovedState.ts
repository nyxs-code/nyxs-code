import { useTranslations } from "@/lib/i18n";
import { useShellEnd } from "@/lib/commandBackground";

/** How a command that moved to the background is doing, for its row: running, then how it ended. */
export function useMovedState(shellId: string | undefined, limitMs: number | undefined): string | null {
  const t = useTranslations().commandBackground;
  const end = useShellEnd(shellId);
  if (!shellId) return null;
  if (end === "done") return t.finished;
  if (end === "failed") return t.failed;
  if (end === "killed") return t.stopped;
  return limitMs !== undefined ? t.movedAfterLimit.replace("{duration}", formatLimit(limitMs)) : t.running;
}

function formatLimit(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 && s % 60 === 0 ? `${s / 60} min` : `${s} s`;
}
