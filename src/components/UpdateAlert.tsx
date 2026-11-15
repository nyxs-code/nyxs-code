import { useEffect, useRef, useState } from "react";
import { Download, X, Loader2, RotateCw, TriangleAlert } from "lucide-react";
import { useUpdater } from "@/lib/updater";
import { getLanguage, useTranslations } from "@/lib/i18n";
import { cardComment, cardFromNotes } from "@/lib/updateCard";
import { SAMPLE_CARD } from "@/lib/updateCardSample";
import { slidesFromNotes } from "@/lib/updateNotes";
import { UpdateCard } from "@/components/update/UpdateCard";

const DEV_SAMPLE_NOTES = `## What's New
- A new crochet raccoon mascot sits on the message box in every session.

${cardComment(SAMPLE_CARD)}`;

/** In a dev build, `VITE_DEV_UPDATE_CARD=1` when starting it (or this localStorage key set to
 *  "1") shows the card with the sample card and a simulated install, so it can be checked
 *  without a real release. */
const DEV_CARD_FLAG = "nyxs:dev-update-card";

function useDevCard(real: ReturnType<typeof useUpdater>): ReturnType<typeof useUpdater> {
  const [fake, setFake] = useState({ status: "available" as typeof real.status, progress: 0, hidden: false });
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  const on = import.meta.env.VITE_DEV_UPDATE_CARD === "1" || localStorage.getItem(DEV_CARD_FLAG) === "1";
  if (!import.meta.env.DEV || !on) return real;
  return {
    ...real,
    status: fake.status,
    progress: fake.progress,
    version: "0.8.53",
    notes: DEV_SAMPLE_NOTES,
    visible: !fake.hidden,
    dismiss: () => setFake((f) => ({ ...f, hidden: true })),
    install: async () => {
      let p = 0;
      setFake((f) => ({ ...f, status: "downloading", progress: 0 }));
      timer.current = setInterval(() => {
        p = Math.min(1, p + 0.03);
        setFake((f) => ({ ...f, progress: p }));
        if (p < 1) return;
        if (timer.current) clearInterval(timer.current);
        setFake((f) => ({ ...f, status: "ready" }));
        setTimeout(() => setFake({ status: "available", progress: 0, hidden: false }), 2000);
      }, 60);
    },
  };
}

export function UpdateAlert() {
  const u = useDevCard(useUpdater());
  const tr = useTranslations();
  const t = tr.update;
  if (!u.visible || u.status === "idle") return null;

  const slides = cardFromNotes(u.notes)?.slides ?? slidesFromNotes(u.notes, tr);
  if (slides.length > 0) {
    return (
      <UpdateCard
        version={u.version}
        slides={slides}
        lang={getLanguage()}
        status={u.status}
        progress={u.progress}
        onInstall={() => void u.install()}
        onDismiss={u.dismiss}
        onRetry={() => void u.recheck()}
      />
    );
  }

  // No notes at all: a failed install with nothing pending, or a release published without them.
  const downloading = u.status === "downloading";
  const ready = u.status === "ready";
  const error = u.status === "error";
  const pct = Math.round(u.progress * 100);
  const statusLine = error
    ? t.retryLater
    : ready
      ? t.restarting
      : downloading
        ? t.downloading.replace("{pct}", String(pct))
        : t.newVersionAvailable.replace("{version}", u.version ? ` (${u.version})` : "");

  return (
    <div className="relative z-30 ml-2 -mr-5 mb-2 rounded-[8px] border border-bg-300 bg-bg-200 shadow-lg overflow-hidden animate-fade-in">
      <div className="p-3">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 shrink-0 w-7 h-7 rounded-[6px] bg-accent/15 flex items-center justify-center">
            {error ? (
              <TriangleAlert className="w-4 h-4 text-yellow-400" />
            ) : downloading || ready ? (
              <Loader2 className="w-4 h-4 text-accent animate-spin" />
            ) : (
              <Download className="w-4 h-4 text-accent" />
            )}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-semibold text-text-100 leading-tight">
              {error ? t.updateFailed : t.updateAvailable}
            </p>
            <p className="mt-0.5 text-[12px] text-text-300 leading-snug">{statusLine}</p>
          </div>
          {!downloading && !ready && (
            <button
              onClick={u.dismiss}
              aria-label={t.dismiss}
              className="shrink-0 p-1 -m-1 rounded-[6px] text-text-400 hover:text-text-100 hover:bg-bg-300 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {downloading && (
          <div className="mt-2.5 h-1 rounded-[2px] bg-bg-300 overflow-hidden">
            <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />
          </div>
        )}
        {!downloading && !ready && (
          <div className="mt-2.5 flex items-center gap-2">
            {error ? (
              <button
                onClick={() => void u.recheck()}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[6px] text-[12px] font-medium bg-accent text-bg-0 hover:bg-accent-hover transition-colors"
              >
                <RotateCw className="w-3.5 h-3.5" /> {t.retry}
              </button>
            ) : (
              <button
                onClick={() => void u.install()}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[6px] text-[12px] font-semibold bg-accent text-bg-0 hover:bg-accent-hover transition-colors"
              >
                {t.installAndRestart}
              </button>
            )}
            <button
              onClick={u.dismiss}
              className="px-2 py-1 rounded-[6px] text-[12px] text-text-400 hover:text-text-200 transition-colors"
            >
              {t.notYet}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
