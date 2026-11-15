import { useCallback, useRef, useState } from "react";
import { useTranslations } from "@/lib/i18n";
import { remoteHostOf } from "@/lib/remote";
import { prepareRemoteServer, runsOnNode, type ServerPrep } from "@/lib/remoteServerPrep";

/** Getting a remote machine ready before one of its Node servers starts, and the card's answer
 *  to the one question it asks. On this PC, or for any other program, there's nothing to do. */
export function useServerPrep(workspace: string | null) {
  const t = useTranslations().views;
  const [prep, setPrep] = useState<ServerPrep | null>(null);
  const answer = useRef<((go: boolean) => void) | null>(null);

  const prepare = useCallback(
    async (name: string, cwd: string, command: string, onShell: (id: string, started: boolean) => void): Promise<boolean> => {
      if (!workspace || !remoteHostOf(workspace) || !runsOnNode(command)) return true;
      return prepareRemoteServer({
        name,
        cwd,
        workspace,
        labels: { node: t.prepNodeRunning, deps: t.prepDepsRunning },
        onPrep: setPrep,
        confirm: () => new Promise<boolean>((resolve) => { answer.current = resolve; }),
        onShell,
      });
    },
    [workspace, t.prepNodeRunning, t.prepDepsRunning],
  );

  const answerPrep = useCallback((go: boolean) => {
    answer.current?.(go);
    answer.current = null;
  }, []);

  const clearPrep = useCallback(() => setPrep(null), []);

  return { prep, prepare, answerPrep, clearPrep };
}
