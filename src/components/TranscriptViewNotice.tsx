import { useEffect, useState } from "react";
import { useTranslations } from "@/lib/i18n";
import { useTranscriptView, useTranscriptViewChangedAt } from "@/lib/transcriptView";

const SHOWN_MS = 1600;

/** Names the transcript view for a moment after Ctrl+O switches it. */
export function TranscriptViewNotice() {
  const t = useTranslations().transcriptView;
  const view = useTranscriptView();
  const changedAt = useTranscriptViewChangedAt();
  const [hiddenAt, setHiddenAt] = useState(0);

  useEffect(() => {
    if (!changedAt) return;
    const timer = setTimeout(() => setHiddenAt(changedAt), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [changedAt]);

  if (!changedAt || hiddenAt === changedAt) return null;
  const name = view === "thinking" ? t.thinking : view === "verbose" ? t.verbose : t.normal;
  return (
    <div
      role="status"
      data-webview-hole
      className="pointer-events-none fixed bottom-24 left-1/2 z-[80] -translate-x-1/2 rounded-[6px] border border-bg-300 bg-bg-100 px-3 py-1.5 text-[12.5px] text-text-100 shadow-lg animate-fade-in"
    >
      {t.notice.replace("{view}", name)}
    </div>
  );
}
