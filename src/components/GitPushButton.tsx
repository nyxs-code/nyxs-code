import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Loader2 } from "lucide-react";
import { loadUpstreamStatus, pullBranch, pushBranch, type UpstreamStatus } from "@/lib/gitPush";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type Problem = { text: string; canPull: boolean } | null;

/** "Push (N)" next to an open PR when the branch has commits the remote doesn't: pushes right
 *  away, without an agent turn. A push the remote turns away (it moved) offers to pull first. */
export function GitPushButton({
  workspace,
  branch,
  version,
  disabled,
  className,
  onPushed,
}: {
  workspace: string;
  branch: string;
  /** Changes whenever the bar reloads, so the counts are read again. */
  version: unknown;
  disabled: boolean;
  /** Classes shared with the bar's other buttons. */
  className: string;
  onPushed: () => void;
}) {
  const t = useTranslations().gitBar;
  const [status, setStatus] = useState<UpstreamStatus | null>(null);
  const [busy, setBusy] = useState<"push" | "pull" | null>(null);
  const [problem, setProblem] = useState<Problem>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void loadUpstreamStatus(workspace, branch)
      .catch(() => null)
      .then((s) => { if (alive) setStatus(s); });
    return () => { alive = false; };
  }, [workspace, branch, version]);

  useEffect(() => {
    if (!problem) return;
    const close = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setProblem(null); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [problem]);

  const push = useCallback(async () => {
    if (!status) return;
    setBusy("push");
    setProblem(null);
    const res = await pushBranch(workspace, branch, !!status.upstream);
    setBusy(null);
    if (res.ok) {
      setStatus({ ...status, upstream: status.upstream ?? `origin/${branch}`, ahead: 0 });
      onPushed();
    } else if (res.reason === "rejected") setProblem({ text: t.pushRejected, canPull: true });
    else if (res.reason === "auth") setProblem({ text: t.pushAuth, canPull: false });
    else setProblem({ text: t.pushFailed.replace("{message}", res.message), canPull: false });
  }, [status, workspace, branch, onPushed, t]);

  const pullThenPush = async () => {
    setBusy("pull");
    setProblem(null);
    const res = await pullBranch(workspace, branch, !!status?.upstream);
    setBusy(null);
    if (!res.ok) {
      setProblem({ text: res.reason === "conflict" ? t.pullConflict : t.pullFailed.replace("{message}", res.message), canPull: false });
      onPushed();
      return;
    }
    await push();
  };

  if (!status || status.ahead === 0) return null;
  const target = status.upstream ?? `origin/${branch}`;
  return (
    <div ref={boxRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => void push()}
        disabled={disabled || busy !== null}
        data-tooltip={busy ? undefined : t.pushTooltip.replace("{target}", target)}
        className={cn(className, "flex items-center gap-1 rounded-[6px]")}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUp className="h-3.5 w-3.5" />}
        {busy === "push" ? t.pushing : busy === "pull" ? t.pulling : t.push.replace("{n}", String(status.ahead))}
      </button>
      {problem && (
        <div role="alert" className="absolute bottom-full right-0 z-30 mb-1 w-72 rounded-[8px] border border-bg-300 bg-bg-100 p-2.5 shadow-lg">
          <p className="whitespace-pre-line break-words text-[12.5px] leading-snug text-text-200">{problem.text}</p>
          {problem.canPull && (
            <div className="mt-2 flex justify-end">
              <button type="button" onClick={() => void pullThenPush()} className={cn(className, "rounded-[6px]")}>
                {t.pullAndPush}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
