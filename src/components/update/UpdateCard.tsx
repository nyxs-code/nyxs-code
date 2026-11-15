import { useEffect, useState } from "react";
import { Download, X, Loader2, RotateCw, TriangleAlert } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { pickLang, type CardSlide } from "@/lib/updateCard";
import type { LangCode } from "@/locales/types";
import { cn } from "@/lib/utils";
import { CardSceneView } from "./CardScene";
import { sceneDuration } from "./sceneTiming";

export type CardStatus = "available" | "downloading" | "ready" | "error";

interface Props {
  version: string | null;
  slides: CardSlide[];
  lang: LangCode;
  status: CardStatus;
  progress: number;
  onInstall: () => void;
  onDismiss: () => void;
  onRetry: () => void;
  /** Holds one slide and one step of its demo, without animations (the audit and the harness). */
  still?: { slide: number; phase: number };
}

/**
 * The card that offers an update: each novelty with its demo, dots to move between them, and
 * the install button that turns into the download's progress. One fixed size: the demo stage
 * and the text area never grow, so what doesn't fit is caught by the audit, not by the layout.
 */
export function UpdateCard({ version, slides, lang, status, progress, onInstall, onDismiss, onRetry, still }: Props) {
  const t = useTranslations().update;
  const [index, setIndex] = useState(0);
  const [hovering, setHovering] = useState(false);
  const current = Math.min(still?.slide ?? index, slides.length - 1);
  const slide = slides[current];
  const busy = status === "downloading" || status === "ready";
  const pct = Math.round(progress * 100);

  useEffect(() => {
    if (still || hovering || slides.length < 2) return;
    const id = setTimeout(() => setIndex((i) => (i + 1) % slides.length), sceneDuration(slides[current].scene));
    return () => clearTimeout(id);
  }, [still, hovering, current, slides]);

  return (
    <div
      data-update-card
      data-card-still={still ? "" : undefined}
      className="relative z-30 ml-2 -mr-5 mb-2 animate-fade-in"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <div className="rounded-[8px] border border-bg-300 bg-bg-100 shadow-xl overflow-hidden">
        <div
          className="relative h-[150px] border-b border-bg-300 bg-bg-0 overflow-hidden"
          style={{
            backgroundImage:
              "radial-gradient(120% 90% at 50% 100%, color-mix(in srgb, var(--accent) 14%, transparent), transparent 60%), radial-gradient(color-mix(in srgb, var(--text-100) 7%, transparent) 1px, transparent 1px)",
            backgroundSize: "auto, 14px 14px",
          }}
        >
          <div className="absolute left-3 right-2 top-2 z-10 flex items-center gap-1.5 text-[12.5px]">
            <span className="font-semibold text-text-100">Nyxs</span>
            {version && <span className="text-text-300">{version}</span>}
            <span className="px-1.5 rounded-[4px] bg-accent/15 text-accent text-[10.5px] font-semibold uppercase tracking-wide">{t.newBadge}</span>
            {!busy && (
              <button
                onClick={onDismiss}
                aria-label={t.dismiss}
                className="ml-auto w-6 h-6 flex items-center justify-center rounded-[6px] bg-black/25 text-text-300 hover:bg-black/45 hover:text-text-100 transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <div data-card-stage data-clip className="absolute inset-x-0 top-[30px] bottom-0">
            <div key={current} className="update-card-in absolute inset-0">
              <CardSceneView scene={slide.scene} lang={lang} still={still?.phase} />
            </div>
          </div>
        </div>

        <div data-fit="text area" className="px-3 pt-2.5 h-[118px] overflow-hidden">
          <div className="flex items-center gap-2 h-[22px] mb-1.5">
            <span className="flex-1 min-w-0 truncate text-[11px] font-medium uppercase tracking-wider text-text-400">{t.whatsNew}</span>
            {slides.length > 1 && (
              <div className="flex items-center" role="tablist">
                {slides.map((s, i) => (
                  <button
                    key={i}
                    role="tab"
                    aria-selected={i === current}
                    aria-label={pickLang(s.title, lang)}
                    onClick={() => setIndex(i)}
                    className="group px-[3px] py-2"
                  >
                    <span
                      className={cn(
                        "block h-1.5 rounded-[3px] transition-all duration-300",
                        i === current ? "w-[18px] bg-accent" : "w-1.5 bg-bg-300 group-hover:bg-text-500",
                      )}
                    />
                  </button>
                ))}
              </div>
            )}
          </div>
          {status === "error" ? (
            // The footer only has room for the retry button: what went wrong goes where the
            // novelty's text was.
            <>
              <p className="flex items-center gap-1.5 text-[14px] font-semibold text-red-400">
                <TriangleAlert className="w-4 h-4 shrink-0" />
                <span data-fit="error" className="min-w-0 truncate">{t.updateFailed}</span>
              </p>
              <p data-fit="retry later" className="mt-0.5 line-clamp-3 text-[12.5px] leading-[1.45] text-text-300">{t.retryLater}</p>
            </>
          ) : (
            <>
              <p data-fit="title" className="truncate text-[14px] font-semibold text-text-100">{pickLang(slide.title, lang)}</p>
              <p data-fit="description" className="mt-0.5 line-clamp-3 text-[12.5px] leading-[1.45] text-text-300">{pickLang(slide.desc, lang)}</p>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 px-3 pt-2 pb-3 h-[50px]">
          {status === "available" && (
            <>
              <button onClick={onDismiss} className="min-w-0 py-1.5 text-[13px] text-text-400 hover:text-text-100 transition-colors">
                <span data-fit="not yet" className="block truncate whitespace-nowrap">{t.notYet}</span>
              </button>
              <button
                onClick={onInstall}
                className="ml-auto min-w-0 inline-flex items-center gap-1.5 px-2.5 py-[7px] rounded-[8px] bg-accent text-white text-[13px] font-medium hover:bg-accent-hover transition-colors"
              >
                <Download className="w-3.5 h-3.5 shrink-0" />
                <span data-fit="update button" className="min-w-0 truncate whitespace-nowrap">{t.updateNow}</span>
              </button>
            </>
          )}
          {busy && (
            <div className="relative flex-1 h-[30px] rounded-[8px] bg-bg-200 overflow-hidden flex items-center justify-center px-1 text-[12px] text-text-100 tabular-nums">
              {status === "downloading" && <span className="absolute inset-y-0 left-0 bg-accent/20 transition-[width] duration-150" style={{ width: `${pct}%` }} />}
              <span className="relative min-w-0 flex items-center gap-1.5">
                {status === "ready" && <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />}
                <span data-fit={status} className="min-w-0 truncate whitespace-nowrap">
                  {status === "ready" ? t.restarting : t.downloading.replace("{pct}", String(pct))}
                </span>
              </span>
            </div>
          )}
          {status === "error" && (
            <button
              onClick={onRetry}
              className="flex-1 min-w-0 inline-flex items-center justify-center gap-1.5 py-[7px] rounded-[8px] border border-bg-300 bg-bg-200 text-[13px] text-text-100 hover:bg-bg-300 transition-colors"
            >
              <RotateCw className="w-3.5 h-3.5 shrink-0" />
              <span data-fit="retry" className="min-w-0 truncate">{t.retry}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
