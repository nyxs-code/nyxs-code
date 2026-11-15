import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Download, ExternalLink, Loader2, LogIn, Plug, RefreshCw } from "lucide-react";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { handleExternalLinkClick } from "@/lib/openExternal";
import { useTranslations } from "@/lib/i18n";
import { PROVIDERS, type ProviderId } from "@/lib/models";
import type { AgentCliStatus } from "@/lib/agentCli";
import { useAgentCliPlanUsage, useAgentCliStatus } from "@/lib/useAgentCliStatus";
import { AccountUsageCard } from "./AccountUsageCard";
import { WaitingNote } from "./WaitingNote";

const primary =
  "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[6px] text-sm font-medium bg-accent text-bg-0 hover:opacity-90 disabled:opacity-50";
const secondary =
  "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[6px] text-[13px] font-medium border border-bg-300 text-text-200 hover:bg-bg-200 disabled:opacity-50";

function useFill(provider: ProviderId, status: AgentCliStatus | null) {
  const name = PROVIDERS[provider].name;
  return (s: string) => s.replace("{name}", name).replace("{version}", status?.version ?? "").replace(/\s+\./, ".");
}

/** CLIs that run on an API key Nyxs hands them, rather than a sign-in of their own. */
function keyBased(provider: ProviderId): boolean {
  return provider === "deepseek-cli";
}

/** What the CLI's state is in words: installed and signed in, or what is missing. */
function StatusLines({ provider, status }: { provider: ProviderId; status: AgentCliStatus }) {
  const t = useTranslations().settings;
  const tc = t.agentCli;
  const fill = useFill(provider, status);
  const who = status.account?.email ?? status.account?.name;
  return (
    <>
      <p className="text-[13px] text-text-200">{fill(tc.detected)}</p>
      {keyBased(provider) ? (
        <p className="text-[12px] text-text-400">{tc.apiKeyHint}</p>
      ) : status.loggedIn === true || (status.loggedIn == null && who) ? (
        <p className="text-[12px] text-text-300 inline-flex items-center gap-1.5">
          <CheckCircle2 className="w-3.5 h-3.5 text-accent" /> {who ? t.claudeCode.connectedAs.replace("{account}", who) : fill(tc.signedIn)}
        </p>
      ) : status.loggedIn === false ? (
        <p className="text-[12px] text-amber-500">{fill(tc.signedOut)}</p>
      ) : (
        <p className="text-[12px] text-text-400">{fill(tc.loginHint)}</p>
      )}
    </>
  );
}

export function AgentCliConnectModal({
  provider,
  defaultKey = "",
  onConnect,
  onClose,
}: {
  provider: ProviderId;
  /** For a CLI that runs on an API key: the one Nyxs already has (DeepSeek's provider). */
  defaultKey?: string;
  /** `apiKey` for a CLI that runs on one. */
  onConnect: (apiKey?: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations().settings;
  const tc = t.agentCli;
  const name = PROVIDERS[provider].name;
  const needsKey = keyBased(provider);
  const [apiKey, setApiKey] = useState(defaultKey);
  const connect = () => {
    if (needsKey && !apiKey.trim()) return;
    onConnect(needsKey ? apiKey.trim() : undefined);
  };
  const onConnectRef = useRef(connect);
  useEffect(() => {
    onConnectRef.current = connect;
  });
  const { status, error, waiting, check, open } = useAgentCliStatus(provider, () => onConnectRef.current(), true);
  const fill = useFill(provider, status);
  // Installed from here: connected as soon as the terminal is done (signed in, when the CLI
  // can tell; otherwise right away).
  const installing = useRef(false);
  useEffect(() => {
    if (waiting === "install") installing.current = true;
    else if (installing.current && status?.installed && status.loggedIn !== false) {
      installing.current = false;
      onConnectRef.current();
    }
  }, [waiting, status?.installed, status?.loggedIn]);

  const signedOut = status?.loggedIn === false;

  return (
    <Dialog open onClose={onClose} stacked className="overflow-y-auto custom-scrollbar">
      <DialogHeader className="px-5 pt-5 pb-0">
        <DialogTitle className="text-base font-semibold">{name}</DialogTitle>
      </DialogHeader>
      <div className="px-5 pt-4 pb-5 space-y-4">
        <p className="text-[12px] text-text-400">{fill(tc.intro)}</p>

        {!status ? (
          !error && (
            <p className="text-[13px] text-text-300 inline-flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> {fill(tc.checking)}
            </p>
          )
        ) : status.installed ? (
          <div className="space-y-2">
            <StatusLines provider={provider} status={status} />
            {needsKey && (
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") connect();
                }}
                placeholder="sk-…"
                aria-label={tc.apiKeyLabel}
                autoFocus
                className="w-full h-8 px-2.5 rounded-[6px] border border-bg-300 bg-bg-100 text-[13px] text-text-100 placeholder:text-text-500 outline-none focus:border-accent"
              />
            )}
            <div className="flex flex-wrap gap-2">
              {signedOut ? (
                <button type="button" onClick={() => void open("login")} disabled={waiting === "login"} className={primary}>
                  <LogIn className="w-4 h-4" /> {tc.login}
                </button>
              ) : (
                <button type="button" onClick={connect} disabled={needsKey && !apiKey.trim()} className={primary}>
                  <Plug className="w-4 h-4" /> {tc.connect}
                </button>
              )}
              {status.loggedIn !== true && !signedOut && !needsKey && (
                <button type="button" onClick={() => void open("login")} disabled={waiting === "login"} className={secondary}>
                  <LogIn className="w-3.5 h-3.5" /> {tc.login}
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-[13px] text-text-200">{fill(tc.notInstalled)}</p>
            <p className="text-[12px] text-text-400">{tc.installHint}</p>
            <button type="button" onClick={() => void open("install")} disabled={waiting === "install"} className={primary}>
              <Download className="w-4 h-4" /> {tc.install}
            </button>
          </div>
        )}

        {waiting && <WaitingNote waiting={waiting} terminalText={tc.waiting} />}
        {error && <p className="text-[12px] text-red-400 break-words">{error}</p>}

        <div className="flex items-center justify-between gap-2 pt-1">
          <a
            href={PROVIDERS[provider].keysUrl}
            onClick={handleExternalLinkClick}
            rel="noreferrer"
            className="text-[12px] text-accent hover:underline inline-flex items-center gap-1"
          >
            {tc.docs} <ExternalLink className="w-3 h-3" />
          </a>
          <button type="button" onClick={() => void check()} className={secondary}>
            <RefreshCw className="w-3.5 h-3.5" /> {tc.recheck}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** The CLI's account in the provider list: who is signed in, their plan and limits like zeron
 *  shows them, or what is missing (installing it, signing in). `onSignedIn` reloads the model
 *  list, which the CLI only gives once signed in. */
export function AgentCliAccount({
  provider,
  onSignedIn,
  modelsMissing = false,
}: {
  provider: ProviderId;
  onSignedIn?: () => void;
  /** The saved list still has the stand-in for the CLI's own model: it was connected before
   *  its models could be read (before signing in, or by an older Nyxs). */
  modelsMissing?: boolean;
}) {
  const tc = useTranslations().settings.agentCli;
  const { status, error, waiting, check, open } = useAgentCliStatus(provider, onSignedIn);
  const fill = useFill(provider, status);
  // Its models can be read now: read them, once.
  const reloaded = useRef(false);
  useEffect(() => {
    if (!modelsMissing || !status?.installed || status.loggedIn === false || reloaded.current) return;
    reloaded.current = true;
    onSignedIn?.();
  }, [modelsMissing, status?.installed, status?.loggedIn, onSignedIn]);

  const account = status?.account;
  const ready = !!status?.installed && !keyBased(provider) && (status.loggedIn === true || (status.loggedIn == null && !!account));
  const plan = useAgentCliPlanUsage(provider, ready);

  if (status && ready) {
    const name = PROVIDERS[provider].name;
    const who = account?.email ?? account?.name ?? "";
    return (
      <AccountUsageCard
        title={who || fill(tc.signedIn)}
        initialOf={who || name}
        subtitle={[account?.email && account.name, account?.plan, status.version && `${name} ${status.version}`].filter(Boolean).join(" · ")}
        limits={plan.usage?.limits ?? null}
        loadingLimits={plan.loading}
        refreshing={plan.refreshing}
        refreshLabel={tc.recheck}
        onRefresh={() => {
          void check();
          plan.load(true);
        }}
      >
        {error && <p className="text-[12px] text-red-400 break-words">{error}</p>}
      </AccountUsageCard>
    );
  }

  return (
    <div className="mb-3 rounded-[8px] border border-bg-300 bg-bg-200/40 px-3 py-2.5 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          {!status ? (
            !error && (
              <p className="text-[13px] text-text-300 inline-flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> {fill(tc.checking)}
              </p>
            )
          ) : status.installed ? (
            <>
              <StatusLines provider={provider} status={status} />
              {status.loggedIn !== true && !keyBased(provider) && (
                <button type="button" onClick={() => void open("login")} disabled={waiting === "login"} className={secondary}>
                  <LogIn className="w-3.5 h-3.5" /> {tc.login}
                </button>
              )}
            </>
          ) : (
            <>
              <p className="text-[13px] text-text-200">{fill(tc.notInstalled)}</p>
              <button type="button" onClick={() => void open("install")} disabled={waiting === "install"} className={secondary}>
                <Download className="w-3.5 h-3.5" /> {tc.install}
              </button>
            </>
          )}
        </div>
        <button
          type="button"
          onClick={() => void check()}
          className="p-1 rounded-[6px] text-text-400 hover:text-text-100 shrink-0"
          aria-label={tc.recheck}
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>
      {waiting && <WaitingNote waiting={waiting} terminalText={tc.waiting} />}
      {error && <p className="text-[12px] text-red-400 break-words">{error}</p>}
    </div>
  );
}
