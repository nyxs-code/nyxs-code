import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/index.css";
import "@/index.css";
import { setLanguage } from "@/lib/i18n";
import { CHANGELOG } from "@/lib/changelog";
import { CARD_LANGS, scenePhases, type UpdateCardSpec } from "@/lib/updateCard";
import { SAMPLE_CARD } from "@/lib/updateCardSample";
import { SIDEBAR_DEFAULT, SIDEBAR_MIN } from "@/lib/sidebarWidth";
import { UpdateCard, type CardStatus } from "@/components/update/UpdateCard";
import { auditCard } from "@/components/update/cardAudit";
import type { LangCode } from "@/locales/types";

/**
 * The update card on its own, at a sidebar's width, to look at and to audit (dev only:
 * `npm run dev`, then /dev/update-card.html). Query: `card` (`sample`, `latest` or a version
 * in the changelog), `lang`, `width` (the sidebar's), `status`, and `slide` + `phase` to hold
 * one step still. `window.__updateCard.audit()` draws every card, language, width, slide, step
 * and status, and lists what doesn't fit.
 */

const STATUSES: CardStatus[] = ["available", "downloading", "ready", "error"];

/** The audit draws the narrowest sidebar this much narrower. The same font comes out up to ~5%
 *  wider on Linux and macOS than on Windows, so measured on Windows a text that only just fits
 *  would be cut there; measured on Linux (CI) it already is that wide, and only rounding is left. */
// The platform, not the user agent: the E2E device says Windows on every OS.
const AUDIT_SLACK = navigator.platform.startsWith("Win") ? 12 : 4;

const CARDS: Record<string, UpdateCardSpec> = { sample: SAMPLE_CARD };
for (const e of CHANGELOG) if (e.card) CARDS[e.version] = e.card;
const LATEST = CHANGELOG.find((e) => e.card)?.card;
if (LATEST) CARDS.latest = LATEST;

interface View {
  card: string;
  lang: LangCode;
  width: number;
  status: CardStatus;
  still?: { slide: number; phase: number };
}

const frames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

export function Harness() {
  const q = new URLSearchParams(location.search);
  const cards = CARDS;
  const slide = q.get("slide");
  const [view, setView] = useState<View>({
    card: q.get("card") ?? "sample",
    lang: (q.get("lang") as LangCode) ?? "es-ES",
    width: Number(q.get("width")) || SIDEBAR_DEFAULT,
    status: (q.get("status") as CardStatus) ?? "available",
    still: slide !== null ? { slide: Number(slide), phase: Number(q.get("phase") ?? 0) } : undefined,
  });
  const [progress, setProgress] = useState(0.47);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => setLanguage(view.lang), [view.lang]);

  useEffect(() => {
    const draw = async (v: View) => {
      setLanguage(v.lang);
      setView(v);
      await frames();
      await document.fonts.ready;
      await frames();
      const el = cardRef.current?.querySelector<HTMLElement>("[data-update-card]");
      return el ? auditCard(el) : ["the card isn't on the page"];
    };
    (window as unknown as { __updateCard: unknown }).__updateCard = {
      /** Every combination; each problem says where it was found. */
      async audit(only?: string[]) {
        const found: string[] = [];
        const names = only ?? Object.keys(cards).filter((n) => n !== "latest");
        for (const card of names) {
          const spec = cards[card];
          if (!spec) {
            found.push(`no card named ${card}`);
            continue;
          }
          for (const lang of CARD_LANGS) {
            for (const width of [SIDEBAR_MIN - AUDIT_SLACK, SIDEBAR_DEFAULT]) {
              for (const [s, sl] of spec.slides.entries()) {
                for (let phase = 0; phase < scenePhases(sl.scene); phase++) {
                  const statuses = s === 0 && phase === 0 ? STATUSES : (["available"] as CardStatus[]);
                  for (const status of statuses) {
                    const problems = await draw({ card, lang, width, status, still: { slide: s, phase } });
                    for (const p of problems) found.push(`${card} · ${lang} · ${width}px · slide ${s + 1} step ${phase + 1} · ${status}: ${p}`);
                  }
                }
              }
            }
          }
        }
        return found;
      },
    };
  }, [cards]);

  const spec = cards[view.card] ?? SAMPLE_CARD;
  return (
    <div className="h-screen flex bg-bg-0 text-text-100">
      <aside ref={cardRef} className="relative shrink-0 flex flex-col justify-end bg-bg-0 border-r border-bg-300 pb-12" style={{ width: view.width }}>
        <UpdateCard
          key={`${view.card}-${view.lang}`}
          version="0.8.53"
          slides={spec.slides}
          lang={view.lang}
          status={view.status}
          progress={progress}
          still={view.still}
          onInstall={() => {
            setView((v) => ({ ...v, status: "downloading" }));
            let p = 0;
            const id = setInterval(() => {
              p = Math.min(1, p + 0.03);
              setProgress(p);
              if (p >= 1) {
                clearInterval(id);
                setView((v) => ({ ...v, status: "ready" }));
                setTimeout(() => setView((v) => ({ ...v, status: "available" })), 2500);
              }
            }, 80);
          }}
          onDismiss={() => setView((v) => ({ ...v, status: "available" }))}
          onRetry={() => setView((v) => ({ ...v, status: "available" }))}
        />
      </aside>
      <div className="flex-1 p-6 text-[13px] text-text-300 space-y-2">
        <p>
          Card <b className="text-text-100">{view.card}</b> · {view.lang} · sidebar {view.width}px · {view.status}
        </p>
        <p className="flex flex-wrap gap-1.5">
          {CARD_LANGS.map((l) => (
            <button key={l} onClick={() => setView((v) => ({ ...v, lang: l }))} className="px-2 py-0.5 rounded-[6px] border border-bg-300 hover:bg-bg-200">
              {l}
            </button>
          ))}
        </p>
        <p className="flex flex-wrap gap-1.5">
          {[SIDEBAR_MIN, SIDEBAR_DEFAULT, 360].map((w) => (
            <button key={w} onClick={() => setView((v) => ({ ...v, width: w }))} className="px-2 py-0.5 rounded-[6px] border border-bg-300 hover:bg-bg-200">
              {w}px
            </button>
          ))}
          {STATUSES.map((s) => (
            <button key={s} onClick={() => setView((v) => ({ ...v, status: s }))} className="px-2 py-0.5 rounded-[6px] border border-bg-300 hover:bg-bg-200">
              {s}
            </button>
          ))}
        </p>
      </div>
    </div>
  );
}

// Default dark theme (the page's `class="dark"`): the app's theme setup reads account data
// through Tauri, which a plain browser tab doesn't have.
createRoot(document.getElementById("root")!).render(<Harness />);
