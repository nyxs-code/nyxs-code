import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Loader2 } from "lucide-react";
import { invoke } from "@/lib/ipc";
import { useTranslations } from "@/lib/i18n";
import { lastOutputLine } from "../bgShells";

/** The server being started (see `useDevServers`): its shell, and whether the tab started it,
 *  which is when it may also stop it. */
export type ServerBoot = { name: string; shellId: string; started: boolean };

/** The last line a starting server printed, live, so a long build doesn't look stuck, and a
 *  button to cancel it. Its own component: a build prints many lines a second, and only this
 *  line should re-render for them. */
export function ServerBootStatus({ boot, onCancel }: { boot: ServerBoot; onCancel: () => void }) {
  const t = useTranslations().views;
  const [line, setLine] = useState("");

  useEffect(() => {
    let alive = true;
    // What it printed before this showed up.
    void invoke<{ output: string }>("agent_bg_output", { id: boot.shellId })
      .then((r) => { if (alive) setLine((cur) => cur || lastOutputLine(r.output)); })
      .catch(() => {});
    const unlisten = listen<{ id: string; line: string }>("bg-shell-output", ({ payload }) => {
      if (payload.id !== boot.shellId) return;
      const next = lastOutputLine(payload.line);
      if (next) setLine(next);
    });
    return () => {
      alive = false;
      void unlisten.then((f) => f());
    };
  }, [boot.shellId]);

  return (
    <div role="status" className="mt-2 flex items-center gap-2 w-full max-w-md rounded-[6px] border border-bg-300 bg-bg-200/50 px-2.5 py-1.5 text-left">
      <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-text-400" />
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-300">
        {line || t.serverStartWaiting}
      </span>
      {boot.started && (
        <button
          type="button"
          onClick={onCancel}
          aria-label={t.serverStartCancelNamed.replace("{name}", boot.name)}
          className="shrink-0 px-2 py-0.5 rounded-[6px] text-[11px] text-text-300 hover:bg-bg-300 hover:text-text-100 transition-colors"
        >
          {t.serverStartCancel}
        </button>
      )}
    </div>
  );
}
