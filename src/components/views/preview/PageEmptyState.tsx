import { Loader2, Play, Server, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n";
import type { LaunchEntry } from "@/lib/launchConfig";
import type { PreviewConfig } from "@/lib/previewConfig";
import type { ServerPrep } from "@/lib/remoteServerPrep";
import type { BgShell } from "../bgShells";
import { LaunchError } from "./ServersMenu";
import { ServerBootStatus, type ServerBoot } from "./ServerBootStatus";
import { ServerPrepCard } from "./ServerPrepCard";
import type { LaunchFailure } from "./useDevServers";

/** What a tab without a page shows: the launch.json servers, the saved dev server, or how to
 *  get one started. */
export function PageEmptyState({
  launch,
  launching,
  launchError,
  runningShellOf,
  isUp,
  canStop,
  stopServer,
  stopping,
  startLaunch,
  config,
  starting,
  startSavedServer,
  boot,
  cancelBoot,
  prep,
  answerPrep,
  workspace,
  hasDevScript,
  onRequestDevServer,
}: {
  launch: LaunchEntry[];
  launching: string | null;
  launchError: LaunchFailure | null;
  runningShellOf: (e: LaunchEntry) => BgShell | undefined;
  isUp: (e: LaunchEntry) => boolean;
  /** Whether it can be stopped from here: Nyxs started it, or something answers on its port. */
  canStop: (e: LaunchEntry) => boolean;
  stopServer: (e: LaunchEntry) => Promise<void>;
  stopping: string | null;
  startLaunch: (entry: LaunchEntry) => Promise<boolean>;
  config: PreviewConfig | null;
  starting: boolean;
  startSavedServer: () => Promise<void>;
  /** The server being started, with its output; null when none is. */
  boot: ServerBoot | null;
  cancelBoot: () => void;
  prep: ServerPrep | null;
  answerPrep: (go: boolean) => void;
  workspace: string | null;
  hasDevScript: boolean;
  onRequestDevServer?: () => void;
}) {
  const t = useTranslations().views;
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-6 bg-bg-100">
      {launch.length > 0 ? (
        <div className="w-full max-w-md">
          <div className="rounded-lg border border-bg-300 bg-bg-100 divide-y divide-bg-300 overflow-hidden text-left">
            {launch.map((e) => {
              const busy = launching === e.name || stopping === e.name;
              const up = isUp(e);
              // Ours or not (a terminal, another app), a server that answers can be stopped.
              const stoppable = !!runningShellOf(e) || canStop(e);
              return (
                // A running server's row is shaded; clicking it opens the page, and its
                // stop button is red.
                <div key={e.name} className={cn("flex items-center gap-2.5 pr-3 transition-colors", up ? "bg-bg-200" : "hover:bg-bg-200/60")}>
                  <button
                    type="button"
                    onClick={() => void startLaunch(e)}
                    disabled={!!launching}
                    aria-label={(up ? t.launchOpen : t.launchStart).replace("{name}", e.name)}
                    className="min-w-0 flex-1 flex items-center gap-2.5 pl-3 py-2 text-left disabled:cursor-default"
                  >
                    <Server className="w-3.5 h-3.5 shrink-0 text-text-400" />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-text-200">{e.name}</span>
                    {e.port && <span className="shrink-0 text-[12px] tabular-nums text-text-400">:{e.port}</span>}
                  </button>
                  {busy ? (
                    <span className="shrink-0 inline-flex items-center justify-center w-8 h-6 text-text-300">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    </span>
                  ) : stoppable ? (
                    <button
                      type="button"
                      onClick={() => void stopServer(e)}
                      aria-label={t.stopServerNamed.replace("{name}", e.name)}
                      className="shrink-0 inline-flex items-center justify-center w-8 h-6 rounded-[6px] bg-red-600 text-white hover:bg-red-700 transition-colors"
                    >
                      <Square className="w-3 h-3" strokeWidth={2.5} />
                    </button>
                  ) : !up ? (
                    <button
                      type="button"
                      onClick={() => void startLaunch(e)}
                      disabled={!!launching}
                      aria-label={t.launchStart.replace("{name}", e.name)}
                      className="shrink-0 inline-flex items-center justify-center w-8 h-6 rounded-[6px] border border-bg-300 bg-bg-100 text-text-200 hover:bg-bg-200 hover:text-text-100 disabled:opacity-50 transition-colors"
                    >
                      <Play className="w-3.5 h-3.5" />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
          {prep && <ServerPrepCard prep={prep} workspace={workspace} onAnswer={answerPrep} />}
          {boot && <ServerBootStatus boot={boot} onCancel={cancelBoot} />}
          <LaunchError error={launchError} />
          <p className="mt-2 text-[11px] text-text-500">{t.launchHint}</p>
        </div>
      ) : config ? (
        <>
          <Play className="w-7 h-7 text-text-500 mb-2" />
          <p className="text-sm text-text-300">{t.devServerSaved}</p>
          <code className="mt-1.5 px-2 py-0.5 rounded bg-bg-200 border border-bg-300 text-[11px] font-mono text-text-300 max-w-xs truncate" data-tooltip={config.command}>
            {config.command}
          </code>
          <button
            onClick={() => void startSavedServer()}
            disabled={starting}
            className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-accent text-bg-0 hover:bg-accent-hover transition-colors disabled:opacity-60"
          >
            {starting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {starting ? t.startingServer : t.startServer}
          </button>
          {prep && <div className="w-full max-w-md"><ServerPrepCard prep={prep} workspace={workspace} onAnswer={answerPrep} /></div>}
          {boot && <ServerBootStatus boot={boot} onCancel={cancelBoot} />}
          {launchError && <div className="w-full max-w-md"><LaunchError error={launchError} /></div>}
          {onRequestDevServer && !starting && (
            <button onClick={onRequestDevServer} className="mt-2 text-[11px] text-text-500 hover:text-text-300 transition-colors">
              {t.askAgentToStart}
            </button>
          )}
        </>
      ) : (
        <>
          <Play className="w-7 h-7 text-text-500 mb-2" />
          <p className="text-sm text-text-300">{t.noDevServer}</p>
          <p className="text-xs text-text-500 mt-1 max-w-xs">
            {hasDevScript ? t.noDevServerDescSaved : t.noDevServerDesc}
          </p>
          {onRequestDevServer && (
            <button
              onClick={onRequestDevServer}
              className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-accent text-bg-0 hover:bg-accent-hover transition-colors"
            >
              <Play className="w-3.5 h-3.5" /> {t.startServer}
            </button>
          )}
        </>
      )}
    </div>
  );
}
