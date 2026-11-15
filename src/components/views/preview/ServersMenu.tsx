import type { Dispatch, RefObject, SetStateAction } from "react";
import { ArrowRight, Loader2, Play, Server, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n";
import type { LaunchEntry } from "@/lib/launchConfig";
import type { ServerPrep } from "@/lib/remoteServerPrep";
import { VISUAL_PROMPT_EVENT } from "@/lib/visualBridge";
import type { BgShell } from "../bgShells";
import type { LaunchFailure } from "./useDevServers";
import { ServerBootStatus, type ServerBoot } from "./ServerBootStatus";
import { ServerPrepCard } from "./ServerPrepCard";

/** Why a server couldn't be started, with its last output. */
export function LaunchError({ error }: { error: LaunchFailure | null }) {
  const t = useTranslations().views;
  if (!error) return null;
  const { missing } = error;
  const askAgent = () => {
    if (!missing) return;
    const prompt = t.launchAskAgentPrompt.replace("{program}", missing.program).replace("{host}", missing.host).replace("{name}", error.name);
    window.dispatchEvent(new CustomEvent<string>(VISUAL_PROMPT_EVENT, { detail: prompt }));
  };
  return (
    <div role="alert" className="mt-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-left">
      <p className="text-[12px] font-medium text-red-600 dark:text-red-400">{t.launchFailed.replace("{name}", error.name)}</p>
      {missing ? (
        <>
          <p className="mt-1 text-[12.5px] text-text-200">{t.launchMissing.replace("{program}", missing.program).replace("{host}", missing.host)}</p>
          <Button className="mt-2" onClick={askAgent}>{t.launchAskAgent}</Button>
        </>
      ) : (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] font-mono text-text-300">{error.message}</pre>
      )}
    </div>
  );
}

/** The toolbar's list of launch.json servers, to start, open or stop them. */
export function ServersMenu({
  launch,
  launching,
  launchError,
  serversOpen,
  setServersOpen,
  serversRef,
  runningShellOf,
  isUp,
  canStop,
  stopServer,
  stopping,
  startLaunch,
  boot,
  cancelBoot,
  prep,
  answerPrep,
  workspace,
  onAddServer,
}: {
  launch: LaunchEntry[];
  launching: string | null;
  launchError: LaunchFailure | null;
  serversOpen: boolean;
  setServersOpen: Dispatch<SetStateAction<boolean>>;
  serversRef: RefObject<HTMLDivElement | null>;
  runningShellOf: (e: LaunchEntry) => BgShell | undefined;
  isUp: (e: LaunchEntry) => boolean;
  canStop: (e: LaunchEntry) => boolean;
  stopServer: (e: LaunchEntry) => Promise<void>;
  stopping: string | null;
  startLaunch: (entry: LaunchEntry) => Promise<boolean>;
  boot: ServerBoot | null;
  cancelBoot: () => void;
  prep: ServerPrep | null;
  answerPrep: (go: boolean) => void;
  workspace: string | null;
  onAddServer?: () => void;
}) {
  const t = useTranslations().views;
  return (
    <div className="relative shrink-0" ref={serversRef}>
      <button
        type="button"
        onClick={() => setServersOpen((o) => !o)}
        aria-label={t.servers}
        aria-expanded={serversOpen}
        data-tooltip={serversOpen ? undefined : t.servers}
        className={cn("p-1 rounded hover:bg-bg-200", serversOpen ? "bg-bg-200 text-text-100" : "text-text-400 hover:text-text-100")}
      >
        <Server className="w-3.5 h-3.5" />
      </button>
      {serversOpen && (
        <div data-mod-menu role="menu" data-webview-hole className="absolute right-0 top-full mt-1 z-30 w-56 rounded-[5px] border border-bg-300 bg-bg-100 shadow-lg p-1">
          <p className="px-2 pt-0.5 pb-1 text-[11px] font-medium text-text-400">{t.servers}</p>
          {launch.map((e) => {
            const shell = runningShellOf(e);
            const busy = launching === e.name || stopping === e.name;
            const up = isUp(e);
            const label = (shell ? t.stopServerNamed : up ? t.launchOpen : t.launchStart).replace("{name}", e.name);
            // One Nyxs didn't start (a terminal, another app) can be opened and stopped too.
            const external = !shell && up && canStop(e);
            return (
              <div key={e.name} className="flex items-center gap-2 px-2 py-0.5 rounded-[5px]">
                <span className="min-w-0 flex-1 truncate text-[13px] text-text-100">{e.name}</span>
                {external && !busy && (
                  <button
                    type="button"
                    onClick={() => void stopServer(e)}
                    disabled={!!launching}
                    aria-label={t.stopServerNamed.replace("{name}", e.name)}
                    className="shrink-0 inline-flex items-center justify-center w-7 h-5 rounded-[4px] bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
                  >
                    <Square className="w-3 h-3" strokeWidth={2.5} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    if (shell) { void stopServer(e); return; }
                    // Stays open while it boots, so the spinner (or the error) is visible.
                    void startLaunch(e).then((ok) => { if (ok) setServersOpen(false); });
                  }}
                  disabled={!!launching && !busy}
                  aria-label={label}
                  className={cn(
                    "shrink-0 inline-flex items-center justify-center w-7 h-5 rounded-[4px] disabled:opacity-50 transition-colors",
                    shell && !busy
                      ? "bg-red-600 text-white hover:bg-red-700"
                      : "border border-bg-300 bg-bg-100 text-text-200 hover:bg-bg-200 hover:text-text-100",
                  )}
                >
                  {busy ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : shell ? (
                    <Square className="w-3 h-3" strokeWidth={2.5} />
                  ) : up ? (
                    <ArrowRight className="w-3.5 h-3.5" />
                  ) : (
                    <Play className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            );
          })}
          {prep && <div className="px-1 pb-1"><ServerPrepCard prep={prep} workspace={workspace} onAnswer={answerPrep} /></div>}
          {boot && <div className="px-1 pb-1"><ServerBootStatus boot={boot} onCancel={cancelBoot} /></div>}
          {launchError && <div className="px-1 pb-1"><LaunchError error={launchError} /></div>}
          {onAddServer && (
            <>
              {launch.length > 0 && <div className="my-1 border-t border-bg-300" />}
              <button
                type="button"
                onClick={() => { setServersOpen(false); onAddServer(); }}
                className="w-full text-left px-2 py-1 rounded-[5px] text-[13px] text-text-100 hover:bg-bg-200 transition-colors"
              >
                {t.addServer}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
