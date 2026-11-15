import { useEffect, useRef, useState } from "react";
import { FolderGit2, MessageSquare, Search, X } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { relativeTime } from "@/lib/time";
import { workspaceName } from "@/lib/workspace";
import { searchSessions, splitSnippet, type SessionSearchHit } from "@/lib/sessionSearch";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

const DEBOUNCE_MS = 180;

export function SessionSearchModal({
  onClose,
  workspaces,
  onOpen,
}: {
  onClose: () => void;
  workspaces: (string | null)[];
  onOpen: (hit: SessionSearchHit) => void;
}) {
  const t = useTranslations().search;
  const tClose = useTranslations().archived.close;
  const listRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SessionSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const workspacesKey = workspaces.filter(Boolean).join("\u0000");

  useEffect(() => {
    if (!query.trim()) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchSessions(workspacesKey.split("\u0000"), query)
        .then((res) => {
          if (cancelled) return;
          setHits(res);
          setActive(0);
        })
        .catch(() => !cancelled && setHits([]))
        .finally(() => !cancelled && setLoading(false));
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, workspacesKey]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const shown = query.trim() ? hits : [];

  const choose = (hit: SessionSearchHit | undefined) => {
    if (!hit) return;
    onOpen(hit);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(shown.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(shown[active]);
    }
  };

  return (
    // Near the top like a command palette, not centred.
    <Dialog open onClose={onClose} stacked label={t.sessionsTitle} className="mt-[12vh] max-h-[70vh] max-w-2xl self-start overflow-hidden">
      <div className="flex min-h-0 flex-col" onKeyDown={onKeyDown}>
        <div className="flex items-center gap-3 border-b border-bg-300 px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-text-400" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLoading(!!e.target.value.trim());
            }}
            placeholder={t.sessionsPlaceholder}
            className="flex-1 bg-transparent text-[15px] text-text-100 placeholder:text-text-400 outline-none"
          />
          {loading && <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-bg-300 border-t-accent" />}
          <Button variant="ghost" icon data-dialog-close onClick={onClose} aria-label={tClose} className="-mr-1.5">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="overflow-y-auto custom-scrollbar">
          {!query.trim() ? (
            <p className="px-5 py-10 text-center text-[13px] text-text-400">{t.sessionsHint}</p>
          ) : !loading && shown.length === 0 ? (
            <p className="px-5 py-10 text-center text-[13px] text-text-400">{t.sessionsEmpty}</p>
          ) : (
            <ul ref={listRef} className="p-2 space-y-1">
              {shown.map((hit, i) => (
                <li key={`${hit.workspace}:${hit.sessionId}`} data-index={i}>
                  <button
                    type="button"
                    onMouseMove={() => setActive(i)}
                    onClick={() => choose(hit)}
                    className={cn(
                      "w-full rounded-[6px] px-3 py-2.5 text-left transition-colors",
                      i === active ? "bg-bg-200" : "hover:bg-bg-200/60",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <MessageSquare className="h-3.5 w-3.5 shrink-0 text-text-400" />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-100">
                        {hit.title || hit.sessionId}
                      </span>
                      {hit.matches > 0 && (
                        <span className="shrink-0 rounded-[6px] bg-bg-300 px-1.5 py-0.5 text-[10px] tabular-nums text-text-300">
                          {t.sessionsMatches.replace("{count}", String(hit.matches))}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 pl-5 text-[11px] text-text-500">
                      <span className="inline-flex min-w-0 items-center gap-1 truncate">
                        <FolderGit2 className="h-3 w-3 shrink-0" />
                        {workspaceName(hit.workspace)}
                      </span>
                      <span className="shrink-0">· {relativeTime(hit.modifiedAt)}</span>
                    </div>
                    {hit.snippets.map((snippet, j) => {
                      const [before, match, after] = splitSnippet(snippet);
                      return (
                        <p key={j} className="mt-1 line-clamp-2 pl-5 text-[12px] leading-relaxed text-text-300">
                          <span className="mr-1 text-[10px] uppercase tracking-wide text-text-500">{snippet.role}</span>
                          {before}
                          <mark className="rounded-sm bg-accent/30 px-0.5 text-text-100">{match}</mark>
                          {after}
                        </p>
                      );
                    })}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Dialog>
  );
}
