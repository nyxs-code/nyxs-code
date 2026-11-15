import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import {
  Sparkles, Terminal, PanelRight, Bot, Mic, Palette, FolderOpen, Search, RefreshCw, MessageSquare, Gauge, Layers,
  Image, FileText, MousePointer2, Globe, GitBranch, Bell, Keyboard, Shield, Zap, Wrench, Plus, Lock, ArrowRight,
} from "lucide-react";
import { NyxsMascot } from "@/components/NyxsMascot";
import { useTranslations } from "@/lib/i18n";
import { pickLang, type CardIcon, type CardScene, type CardTag } from "@/lib/updateCard";
import type { LangCode } from "@/locales/types";
import { cn } from "@/lib/utils";
import { LINE_MS, REACT_HOLD_MS, STEP_MS, TYPE_MS } from "./sceneTiming";

const CARD_ICON: Record<CardIcon, ComponentType<{ className?: string }>> = {
  sparkles: Sparkles, terminal: Terminal, panel: PanelRight, bot: Bot, mic: Mic, palette: Palette, folder: FolderOpen,
  search: Search, refresh: RefreshCw, message: MessageSquare, gauge: Gauge, layers: Layers, image: Image, file: FileText,
  pointer: MousePointer2, globe: Globe, git: GitBranch, bell: Bell, keyboard: Keyboard, shield: Shield, zap: Zap, wrench: Wrench,
};

const MASCOT = 76;

/** The step a scene is on: its own timer, or the one given (the audit draws each step still). */
function usePhase(count: number, ms: number, still: number | undefined): number {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (still !== undefined || count < 2) return;
    const t = setTimeout(() => setI((n) => (n + 1) % count), ms);
    return () => clearTimeout(t);
  }, [i, count, ms, still]);
  return still ?? i;
}

/** A small message box, as the demos' stage. `data-fit` marks what the audit measures. */
function MiniBox({ children, mascot, fit }: { children: ReactNode; mascot?: ReactNode; fit: string }) {
  return (
    <div data-box={fit} className="relative w-[min(206px,calc(100%-24px))] h-8 shrink-0 rounded-[8px] border border-bg-300 bg-bg-100">
      <div data-fit={fit} className="h-full flex items-center gap-1.5 px-2 overflow-hidden text-[11.5px] text-text-400 whitespace-nowrap">
        {children}
      </div>
      {mascot && <div className="absolute right-0.5 bottom-6" style={{ width: MASCOT, height: MASCOT }}>{mascot}</div>}
    </div>
  );
}

function MascotScene({ scene, lang, still }: { scene: Extract<CardScene, { kind: "mascot" }>; lang: LangCode; still?: number }) {
  const placeholder = useTranslations().chatInput.slashCommandsPlaceholder;
  const i = usePhase(scene.steps.length, STEP_MS, still);
  const step = scene.steps[i];
  return (
    <div className="absolute inset-0 flex items-end justify-center pb-3.5">
      {step.label && (
        // Clear of the mascot, which sits on the right of the box.
        <div data-box="status" className="absolute left-3.5 top-1 flex items-center gap-1.5 text-[11.5px] text-text-300" style={{ right: MASCOT + 6 }}>
          <span className="w-1.5 h-1.5 shrink-0 rounded-full bg-accent animate-pulse" />
          <span data-fit={`step ${i + 1} label`} className="min-w-0 truncate">{pickLang(step.label, lang)}</span>
        </div>
      )}
      <MiniBox fit="placeholder" mascot={<NyxsMascot mood={step.pose} size={MASCOT} />}>
        <Plus className="w-3 h-3 shrink-0" />
        <span data-fit="placeholder" className="min-w-0 truncate">{scene.placeholder ? pickLang(scene.placeholder, lang) : placeholder}</span>
      </MiniBox>
    </div>
  );
}

function ReactionsScene({ scene, lang, still }: { scene: Extract<CardScene, { kind: "reactions" }>; lang: LangCode; still?: number }) {
  const [step, setStep] = useState(0);
  const [typed, setTyped] = useState(0);
  const [reacting, setReacting] = useState(false);
  const shown = still ?? step;
  const text = [...pickLang(scene.steps[shown].text, lang)];

  useEffect(() => {
    if (still !== undefined) return;
    if (typed < text.length && !reacting) {
      const t = setTimeout(() => setTyped((n) => n + 1), TYPE_MS);
      return () => clearTimeout(t);
    }
    if (!reacting) {
      const t = setTimeout(() => setReacting(true), 120);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => {
      setReacting(false);
      setTyped(0);
      setStep((s) => (s + 1) % scene.steps.length);
    }, REACT_HOLD_MS);
    return () => clearTimeout(t);
  }, [still, typed, reacting, text.length, scene.steps.length]);

  const full = still !== undefined;
  const mood = full || reacting ? scene.steps[shown].pose : "rest";
  return (
    <div className="absolute inset-0 flex items-end justify-center pb-3.5">
      <MiniBox fit={`reaction ${shown + 1}`} mascot={<NyxsMascot mood={mood} size={MASCOT} />}>
        <span className="text-text-100">{(full ? text : text.slice(0, typed)).join("")}</span>
        <span className="update-card-caret -ml-1 w-px h-3 shrink-0 bg-text-100" />
      </MiniBox>
    </div>
  );
}

function ReplyScene({ scene, lang, still }: { scene: Extract<CardScene, { kind: "reply" }>; lang: LangCode; still?: number }) {
  const [attached, setAttached] = useState(false);
  useEffect(() => {
    if (still !== undefined) return;
    const t = setTimeout(() => setAttached(true), 1400);
    return () => clearTimeout(t);
  }, [still]);
  const showChips = still !== undefined || attached;
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-end pb-3.5">
      <div className="w-[min(206px,calc(100%-24px))]">
        <div data-box="quote" className="mb-2 border-l-2 border-accent/50 pl-2 text-[11.5px] text-text-300">
          <p data-fit="quote" className="truncate">{pickLang(scene.quote, lang)}</p>
        </div>
      </div>
      <MiniBox fit="reply box">
        <Plus className="w-3 h-3 shrink-0" />
        <span className="flex-1 min-w-0 flex items-center gap-0.5 h-4 overflow-hidden">
          {scene.voice &&
            Array.from({ length: 16 }, (_, i) => (
              <i
                key={i}
                className="w-0.5 shrink-0 rounded-[1px] bg-accent"
                style={{ height: 6, animation: `update-card-wave ${(0.6 + ((i * 37) % 5) / 10).toFixed(1)}s ease-in-out ${((i * 0.09) % 0.8).toFixed(2)}s infinite` }}
              />
            ))}
        </span>
        {showChips &&
          scene.attach?.map((a, i) => {
            const Icon = CARD_ICON[a.icon];
            return (
              <span key={i} className="update-card-pop shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[6px] border border-bg-300 bg-bg-200 text-[11px] text-text-200">
                <Icon className="w-3 h-3" />
                {a.label}
              </span>
            );
          })}
        {scene.voice && <Mic className="w-3.5 h-3.5 shrink-0 text-accent" />}
      </MiniBox>
    </div>
  );
}

function BrowserScene({ scene, lang }: { scene: Extract<CardScene, { kind: "browser" }>; lang: LangCode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div data-box="browser" data-clip className="w-[min(212px,calc(100%-24px))] rounded-[8px] border border-bg-300 bg-bg-100 overflow-hidden">
        <div className="h-[22px] flex items-center gap-1 px-2 border-b border-bg-300 text-[10.5px] text-text-400">
          <Lock className="w-2.5 h-2.5 shrink-0" />
          <span data-fit="url" className="min-w-0 truncate">{scene.url}</span>
        </div>
        <div className="px-3 pt-2.5 pb-3">
          <div className="h-1.5 w-[70%] rounded-[3px] bg-bg-200" />
          <span className="update-card-pick relative inline-block mt-[26px] px-2.5 py-1 rounded-[6px] bg-accent text-white text-[11px] whitespace-nowrap">
            <span data-box="element">{pickLang(scene.element, lang)}</span>
            <span data-box="selector" className="absolute left-[-6px] bottom-[calc(100%+9px)] px-1.5 rounded-[4px] bg-accent text-white font-mono text-[10px] whitespace-nowrap">
              {scene.selector}
            </span>
          </span>
        </div>
      </div>
      <span className="update-card-fly absolute right-3 bottom-2.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[6px] border border-bg-300 bg-bg-200 text-text-200">
        <MousePointer2 className="w-3 h-3" />
        <ArrowRight className="w-3 h-3 text-text-400" />
        <MessageSquare className="w-3 h-3" />
      </span>
    </div>
  );
}

function TerminalScene({ scene, still }: { scene: Extract<CardScene, { kind: "terminal" }>; still?: number }) {
  const [count, setCount] = useState(1);
  useEffect(() => {
    if (still !== undefined || count >= scene.lines.length) return;
    const t = setTimeout(() => setCount((n) => n + 1), LINE_MS);
    return () => clearTimeout(t);
  }, [still, count, scene.lines.length]);
  const lines = still !== undefined ? scene.lines : scene.lines.slice(0, count);
  const mark = { cmd: "$", ok: "✓", add: "+", out: " " } as const;
  const tone = { cmd: "text-text-400", ok: "text-green-500", add: "text-accent", out: "text-text-400" } as const;
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div data-box="terminal" className="w-[calc(100%-24px)] rounded-[8px] border border-bg-300 bg-bg-100 px-2.5 py-2 font-mono text-[11px] leading-[17px]">
        {lines.map((l, i) => (
          <div key={i} className="update-card-pop flex gap-1.5">
            <span className={cn("shrink-0", tone[l.kind])}>{mark[l.kind]}</span>
            <span data-fit={`line ${i + 1}`} className={cn("min-w-0 truncate", l.kind === "out" ? "text-text-300" : "text-text-100")}>{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ListScene({ scene, lang }: { scene: Extract<CardScene, { kind: "list" }>; lang: LangCode }) {
  const t = useTranslations().changelog;
  const label: Record<CardTag, string> = { new: t.new, improved: t.improved, fixed: t.fixed };
  const tone: Record<CardTag, string> = { new: "bg-accent/15 text-accent", improved: "bg-green-500/15 text-green-500", fixed: "bg-amber-500/15 text-amber-500" };
  return (
    // Tag above the text, so the text gets the stage's whole width.
    <div className="absolute inset-0 flex flex-col justify-center gap-2.5 px-3.5">
      {scene.items.map((it, i) => (
        <div key={i} data-box={`item ${i + 1}`} className="flex flex-col items-start gap-1 text-[11.5px] leading-snug text-text-200">
          <span className={cn("px-1.5 rounded-[4px] text-[10px] font-semibold uppercase tracking-wide", tone[it.tag])}>{label[it.tag]}</span>
          <span data-fit={`item ${i + 1}`} className="w-full line-clamp-2">{pickLang(it.text, lang)}</span>
        </div>
      ))}
    </div>
  );
}

/** A slide's demo, drawn in the card's stage (about 236×120 px at the narrowest sidebar). */
export function CardSceneView({ scene, lang, still }: { scene: CardScene; lang: LangCode; still?: number }) {
  switch (scene.kind) {
    case "mascot":
      return <MascotScene scene={scene} lang={lang} still={still} />;
    case "reactions":
      return <ReactionsScene scene={scene} lang={lang} still={still} />;
    case "reply":
      return <ReplyScene scene={scene} lang={lang} still={still} />;
    case "browser":
      return <BrowserScene scene={scene} lang={lang} />;
    case "terminal":
      return <TerminalScene scene={scene} still={still} />;
    case "list":
      return <ListScene scene={scene} lang={lang} />;
    case "icon": {
      const Icon = CARD_ICON[scene.icon];
      return (
        <div className="absolute inset-0 flex items-center justify-center">
          <span data-box="icon" className="w-14 h-14 rounded-[8px] bg-accent/15 flex items-center justify-center">
            <Icon className="w-7 h-7 text-accent" />
          </span>
        </div>
      );
    }
  }
}
