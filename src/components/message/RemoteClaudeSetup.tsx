import { useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle, Check, CircleUser, ExternalLink, Loader2, RefreshCw, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n";
import {
  askRemoteSignInCode,
  retryRemoteClaude,
  sendRemoteSignInCode,
  signInRemoteClaude,
  useRemoteClaudeStep,
} from "@/lib/remoteClaude";

function Card({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="my-2 flex flex-col gap-2 rounded-[8px] border border-bg-300 bg-bg-100 p-3 animate-fade-in" role="status">
      <div className="flex items-center gap-2 text-[13.5px] font-medium text-text-100">
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}

const Hint = ({ children }: { children: ReactNode }) => <p className="text-[13px] text-text-400">{children}</p>;
const iconClass = "h-4 w-4 shrink-0";

/** What the user sees while Claude Code is made ready on the project's machine: nothing to do
 *  until it needs them to sign in. A check that finds everything in place shows nothing. */
export function RemoteClaudeSetup({ host, onCancel }: { host: string; onCancel: () => void }) {
  const t = useTranslations().remoteClaude;
  const step = useRemoteClaudeStep(host);
  const [code, setCode] = useState("");
  const named = (text: string) => text.replace("{host}", host);

  if (!step || step.kind === "checking") return null;

  if (step.kind === "installing" || step.kind === "updating") {
    return (
      <Card icon={<Server className={iconClass} />} title={named(t.preparing)}>
        <div className="flex flex-col gap-1.5 text-[13px] text-text-200">
          <div className="flex items-center gap-2"><Check className={`${iconClass} text-green-500`} />{t.connected}</div>
          <div className="flex items-center gap-2"><Loader2 className={`${iconClass} animate-spin`} />{step.kind === "installing" ? t.installing : t.updating}</div>
          <div className="flex items-center gap-2 text-text-400"><span className="flex h-4 w-4 shrink-0 items-center justify-center"><span className="h-1 w-1 rounded-full bg-current" /></span>{t.checkSession}</div>
        </div>
      </Card>
    );
  }

  if (step.kind === "login") {
    return (
      <Card icon={<CircleUser className={iconClass} />} title={named(t.loginTitle)}>
        {step.error !== undefined ? <Hint>{step.error ? `${t.loginFailed} ${step.error}` : t.loginFailed}</Hint> : <Hint>{t.loginHint}</Hint>}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => void signInRemoteClaude(host)}>
            {t.signIn}
            <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" onClick={onCancel}>{t.cancel}</Button>
        </div>
      </Card>
    );
  }

  if (step.kind === "signingIn") {
    const submit = (e: FormEvent) => {
      e.preventDefault();
      if (!code.trim()) return;
      void sendRemoteSignInCode(host, code);
      setCode("");
    };
    return (
      <Card icon={<Loader2 className={`${iconClass} animate-spin`} />} title={t.waitingTitle}>
        {step.askCode ? (
          <form onSubmit={submit} className="flex flex-col gap-2">
            <Hint>{t.codeHint}</Hint>
            <div className="flex items-center gap-2">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={t.codePlaceholder}
                aria-label={t.codePlaceholder}
                autoComplete="off"
                spellCheck={false}
                className="h-7 min-w-0 flex-1 rounded-[6px] border border-bg-300 bg-bg-0 px-2 text-[13px] text-text-100 outline-none placeholder:text-text-400 focus:border-text-400"
              />
              <Button type="submit" variant="primary" disabled={!code.trim()}>{t.continue}</Button>
            </div>
          </form>
        ) : step.manualUrl ? (
          <Hint>{t.waitingHint}</Hint>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {step.manualUrl && !step.askCode && <Button variant="ghost" onClick={() => askRemoteSignInCode(host)}>{t.useCode}</Button>}
          <Button variant="ghost" onClick={onCancel}>{t.cancel}</Button>
        </div>
      </Card>
    );
  }

  const reason = step.reason === "download" ? t.failedDownload : step.reason === "noDownloader" ? t.failedNoDownloader : step.detail;
  return (
    <Card icon={<AlertTriangle className={`${iconClass} text-amber-500`} />} title={named(t.failedTitle)}>
      {reason && <p className="whitespace-pre-wrap break-words text-[13px] text-text-300">{reason}</p>}
      <Hint>{t.keepsMessage}</Hint>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => retryRemoteClaude(host)}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          {t.retry}
        </Button>
        <Button variant="ghost" onClick={onCancel}>{t.cancel}</Button>
      </div>
    </Card>
  );
}
