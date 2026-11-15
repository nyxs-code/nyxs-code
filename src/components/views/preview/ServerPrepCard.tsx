import { Check, Loader2, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n";
import { remoteHostOf } from "@/lib/remote";
import type { PrepStep, ServerPrep } from "@/lib/remoteServerPrep";
import { cn } from "@/lib/utils";

/** What a remote machine lacks to run a server: the question before installing Node, then how
 *  the installs go. The output of what's running shows below it (ServerBootStatus). */
export function ServerPrepCard({ prep, workspace, onAnswer }: { prep: ServerPrep; workspace: string | null; onAnswer: (go: boolean) => void }) {
  const t = useTranslations().views;
  const node = prep.nodeMajor ? t.prepNode.replace("{version}", String(prep.nodeMajor)) : t.prepNodeLts;

  if (prep.current === null) {
    return (
      <div role="group" className="mt-2 flex flex-col gap-2 rounded-[8px] border border-bg-300 bg-bg-200/50 p-2.5 text-left">
        <p className="flex items-center gap-2 text-[13px] font-medium text-text-100">
          <Package className="h-3.5 w-3.5 shrink-0 text-text-400" />
          {t.prepTitle.replace("{host}", remoteHostOf(workspace) ?? "")}
        </p>
        <div className="flex flex-col gap-1 text-[13px] text-text-200">
          {prep.steps.includes("node") && (
            <div className="flex items-baseline justify-between gap-3">
              <span>{node}</span>
              <span className="min-w-0 truncate text-[12px] text-text-400">{t.prepNodeWhere}</span>
            </div>
          )}
          {prep.steps.includes("deps") && (
            <div className="flex items-baseline justify-between gap-3">
              <span>{t.prepDeps}</span>
              <span className="min-w-0 truncate text-[12px] text-text-400">{t.prepDepsWhere.replace("{dir}", prep.depsDir ?? "")}</span>
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => onAnswer(true)}>{t.prepInstall}</Button>
          <Button variant="ghost" onClick={() => onAnswer(false)}>{t.serverStartCancel}</Button>
        </div>
      </div>
    );
  }

  const label: Record<PrepStep, [running: string, done: string]> = {
    node: [t.prepNodeRunning, t.prepNodeDone],
    deps: [t.prepDepsRunning, t.prepDepsDone],
    start: [t.prepStart, t.prepStart],
  };
  const reached = prep.steps.indexOf(prep.current);
  return (
    <div role="status" className="mt-2 flex flex-col gap-1.5 rounded-[8px] border border-bg-300 bg-bg-200/50 p-2.5 text-left text-[13px] text-text-200">
      {prep.steps.map((step, i) => (
        <div key={step} className={cn("flex items-center gap-2", i > reached && "text-text-400")}>
          {i < reached ? (
            <Check className="h-3.5 w-3.5 shrink-0 text-green-500" />
          ) : i === reached ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          ) : (
            <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center"><span className="h-1 w-1 rounded-full bg-current" /></span>
          )}
          {i < reached ? label[step][1] : label[step][0]}
        </div>
      ))}
    </div>
  );
}
