import { useEffect, useState } from "react";
import { Loader2, TerminalSquare } from "lucide-react";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { localizedError, useTranslations } from "@/lib/i18n";
import { closeCliResume, listCliSessions, readCliSession, useCliResumeOpen, type CliMessage, type CliSessionSummary } from "@/lib/cliSessions";

/** /resume, like Claude Code Desktop: the project's Claude Code sessions (terminal, Claude app,
 *  other apps), any of which continues here as a chat. */
export function CliResumeDialog(props: { workspace: string | null; onImport: (session: CliSessionSummary, messages: CliMessage[]) => void }) {
  // Mounted only while open, so each opening lists the sessions afresh.
  return useCliResumeOpen() ? <CliResumeList {...props} /> : null;
}

function CliResumeList({ workspace, onImport }: { workspace: string | null; onImport: (session: CliSessionSummary, messages: CliMessage[]) => void }) {
  const t = useTranslations().cliResume;
  const [list, setList] = useState<CliSessionSummary[] | null>(null);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState<string | null>(null);

  useEffect(() => {
    if (!workspace) return;
    let alive = true;
    void listCliSessions(workspace)
      .then((l) => { if (alive) setList(l); })
      .catch((e) => { if (alive) setError(localizedError(e)); });
    return () => { alive = false; };
  }, [workspace]);

  const origin = (e: string) => (e === "cli" ? t.fromTerminal : e === "claude-desktop" ? t.fromDesktop : t.fromOther);
  const run = async (s: CliSessionSummary) => {
    if (!workspace || importing) return;
    setImporting(s.id);
    try {
      onImport(s, await readCliSession(workspace, s.id));
      closeCliResume();
    } catch (e) {
      setError(localizedError(e));
    } finally {
      setImporting(null);
    }
  };

  return (
    <Dialog open onClose={closeCliResume} className="max-w-xl">
      <DialogHeader>
        <TerminalSquare className="h-4 w-4 text-accent" />
        <DialogTitle>{t.title}</DialogTitle>
      </DialogHeader>
      <div className="max-h-[60vh] min-h-0 overflow-y-auto custom-scrollbar px-4 pb-4">
        <p className="pb-2 text-[12.5px] text-text-400">{t.hint}</p>
        {!workspace ? (
          <p className="py-6 text-center text-sm text-text-400">{t.noProject}</p>
        ) : error ? (
          <p className="py-3 text-[13px] text-red-500 break-words">{error}</p>
        ) : !list ? (
          <p className="flex justify-center py-6 text-text-400"><Loader2 className="h-4 w-4 animate-spin" /></p>
        ) : list.length === 0 ? (
          <p className="py-6 text-center text-sm text-text-400">{t.none}</p>
        ) : (
          <ul className="divide-y divide-bg-300">
            {list.map((s) => (
              <li key={s.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] text-text-100">{s.title || t.untitled}</p>
                  <p className="text-[12px] text-text-400">
                    {origin(s.entrypoint)} · {t.messages.replace("{n}", String(s.messageCount))} · {new Date(s.modifiedAt).toLocaleString()}
                  </p>
                </div>
                <Button onClick={() => void run(s)} disabled={!!importing}>
                  {importing === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  {t.continue}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
