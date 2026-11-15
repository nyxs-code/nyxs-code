import { ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useTranslations } from "@/lib/i18n";
import type { ProjectTrustState, TrustFinding } from "@/lib/settingsRuntime";

const MAX_FINDINGS = 12;

export function TrustWorkspaceModal({
  path,
  kind = "workspace",
  status,
  findings = [],
  onTrust,
  onCancel,
}: {
  path: string;
  kind?: "workspace" | "settings";
  status?: ProjectTrustState["status"];
  findings?: TrustFinding[];
  onTrust: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations().modals;
  const settingsPrompt = kind === "settings";
  const title = settingsPrompt
    ? status === "changed" ? t.trustSettingsChangedTitle : t.trustSettingsTitle
    : t.trustTitle;
  const Icon = findings.length ? ShieldAlert : ShieldCheck;
  const shown = findings.slice(0, MAX_FINDINGS);
  return (
    <Dialog open onClose={onCancel} role="alertdialog">
      <DialogHeader close={false}>
        <Icon className={findings.length ? "w-4 h-4 text-amber-400" : "w-4 h-4 text-accent"} />
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <div className="min-h-0 overflow-y-auto custom-scrollbar px-4">
        <p className="text-[13px] text-text-300 leading-relaxed">
          {settingsPrompt ? t.trustSettingsDesc : t.trustDesc}
        </p>
        <p className="mt-2.5 text-xs font-mono text-text-200 break-all bg-bg-200 rounded-[6px] px-2.5 py-2">
          {path}
        </p>
        {shown.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-[11px] text-text-400">{t.trustConfigHeading}</div>
            <ul className="max-h-48 overflow-auto custom-scrollbar space-y-1 rounded-[6px] border border-bg-300 bg-bg-0 px-2.5 py-2">
              {shown.map((f) => (
                <li key={`${f.key}:${f.detail}`} className="flex gap-2 text-[12px] leading-snug">
                  <span className="shrink-0 rounded bg-bg-300/70 px-1.5 font-mono text-[11px] text-text-200">{f.key}</span>
                  <span className="min-w-0 break-all font-mono text-text-100">{f.detail}</span>
                </li>
              ))}
              {findings.length > shown.length && (
                <li className="text-[11px] text-text-400">+{findings.length - shown.length}</li>
              )}
            </ul>
          </div>
        )}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>{settingsPrompt ? t.trustSettingsKeepOff : t.cancel}</Button>
        <Button variant="primary" onClick={onTrust}>{settingsPrompt ? t.trustSettingsEnable : t.trustWorkspace}</Button>
      </DialogFooter>
    </Dialog>
  );
}

export default TrustWorkspaceModal;
