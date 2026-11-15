import { useState } from "react";
import { AlignCenter, AlignLeft, AlignRight, Captions, Loader2 } from "lucide-react";
import { useTranslations, type Translations } from "@/lib/i18n";
import {
  defaultTransform,
  type Animatable,
  type Clip,
  type Composition,
  type TextAnimation,
  type TextAnimationKind,
  type TextStyle,
  type Timeline,
  type Transform,
  type Transition,
  type TransitionKind,
} from "@/lib/video/timelineSchema";
import { CaptionsError, generateCaptions } from "@/lib/video/captions";
import { checkExternalChange, flushSave, setPlayhead, timelineActions } from "@/lib/video/timelineStore";
import { Button } from "@/components/ui/button";
import { AnimRow } from "./AnimRow";
import { EffectsEditor } from "./EffectsEditor";
import { FontPicker } from "./FontPicker";
import { FootageSection } from "./FootageSection";
import { PropsForm } from "./PropsForm";
import { ColorInput, NumberInput, Row, Section, Segmented, Select, TextInput, Toggle } from "./fields";
import { ClipIcon } from "../ClipIcon";
import { keyLabels } from "./animatable";

type T = Translations["videoPanel"];

export interface ClipEditor {
  clip: Clip;
  comp: Composition;
  /** Merges a patch into the clip. `phase: "drag"` edits coalesce into one undo step. */
  edit: (patch: Partial<Clip>, key: string, phase?: "drag" | "commit") => void;
  frameInClip: number;
  jump: (frameInClip: number) => void;
}

/** Everything about one selected clip. */
export function ClipInspector({ clip, comp, timeline, playhead, workspace, slug }: { clip: Clip; comp: Composition; timeline: Timeline; playhead: number; workspace: string; slug: string }) {
  const t = useTranslations().videoPanel;
  const frameInClip = Math.min(Math.max(0, playhead - clip.from), Math.max(0, clip.durationInFrames - 1));
  const ed: ClipEditor = {
    clip,
    comp,
    frameInClip,
    // Drags and the commit that ends them share a key, so a scrub is one undo step.
    edit: (patch, key) => void timelineActions.updateClip(clip.id, patch, `inspector:${clip.id}:${key}`),
    jump: (f) => setPlayhead(clip.from + f),
  };
  const visual = clip.type !== "audio";
  const projectFonts = timeline.assets.filter((a) => a.kind === "font").map((a) => a.name);

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-bg-300/70 px-3 py-2">
        <ClipIcon type={clip.type} className="h-4 w-4 shrink-0 text-text-300" />
        <TextInput
          aria-label={t.clipName}
          value={clip.name ?? ""}
          placeholder={t.clipTypes[clip.type]}
          onCommit={(name) => ed.edit({ name: name.trim() || undefined }, "name")}
          className="h-7 border-transparent bg-transparent text-[13px] font-medium hover:border-bg-300"
        />
      </div>
      <TimingSection ed={ed} t={t} />
      {visual && <TransformSection ed={ed} t={t} />}
      {clip.type === "text" && <TextSection ed={ed} t={t} projectFonts={projectFonts} />}
      {clip.type === "captions" && <CaptionsSection ed={ed} t={t} projectFonts={projectFonts} />}
      {clip.type === "shape" && <ShapeSection ed={ed} t={t} />}
      {(clip.type === "video" || clip.type === "image") && <FitSection ed={ed} t={t} />}
      {clip.type === "scene" && (
        <Section title={t.scene}>
          <Row label={t.sceneFile}>
            <span className="truncate font-mono text-[11.5px] text-text-200">{clip.file} · {clip.exportName}</span>
          </Row>
          <PropsForm props={clip.props ?? {}} onChange={(props) => ed.edit({ props }, "props")} t={t} />
        </Section>
      )}
      {(clip.type === "video" || clip.type === "audio") && <AudioSection ed={ed} t={t} workspace={workspace} slug={slug} />}
      {(clip.type === "video" || clip.type === "audio") && (
        <FootageSection clip={clip} comp={comp} timeline={timeline} playhead={playhead} workspace={workspace} slug={slug} t={t} />
      )}
      {visual && <TransitionSection ed={ed} t={t} />}
      {visual && (
        <EffectsEditor
          effects={clip.effects ?? []}
          onChange={(effects, phase) => ed.edit({ effects: effects.length ? effects : undefined }, "effects", phase)}
          frameInClip={frameInClip}
          onJump={ed.jump}
          t={t}
        />
      )}
    </div>
  );
}

function TimingSection({ ed, t }: { ed: ClipEditor; t: T }) {
  const { clip } = ed;
  return (
    <Section title={t.timing}>
      <Row label={t.start}>
        <NumberInput aria-label={t.start} value={clip.from} min={0} suffix="f" onChange={(v, p) => ed.edit({ from: v }, "from", p)} />
      </Row>
      <Row label={t.length}>
        <NumberInput aria-label={t.length} value={clip.durationInFrames} min={1} suffix="f" onChange={(v, p) => ed.edit({ durationInFrames: v }, "duration", p)} />
      </Row>
      {(clip.type === "video" || clip.type === "audio") && (
        <Row label={t.trimStart}>
          <NumberInput aria-label={t.trimStart} value={clip.trimStart} min={0} suffix="f" onChange={(v, p) => ed.edit({ trimStart: v }, "trim", p)} />
        </Row>
      )}
      {clip.type === "video" && (
        <Row label={t.speed}>
          <NumberInput aria-label={t.speed} value={clip.playbackRate ?? 1} min={0.25} max={4} step={0.05} precision={2} suffix="×" onChange={(v, p) => ed.edit({ playbackRate: v === 1 ? undefined : v }, "rate", p)} />
        </Row>
      )}
    </Section>
  );
}

function TransformSection({ ed, t }: { ed: ClipEditor; t: T }) {
  const { clip, comp, frameInClip } = ed;
  const tr: Transform = clip.transform ?? defaultTransform(comp);
  const set = (field: keyof Transform) => (v: Animatable<number>, phase: "drag" | "commit") =>
    ed.edit({ transform: { ...tr, [field]: v } }, `transform.${field}`, phase);
  const common = { frameInClip, onJump: ed.jump, labels: keyLabels(t) };
  return (
    <Section title={t.transform}>
      <AnimRow label={t.posX} value={tr.x} fallback={comp.width / 2} onChange={set("x")} suffix="px" {...common} />
      <AnimRow label={t.posY} value={tr.y} fallback={comp.height / 2} onChange={set("y")} suffix="px" {...common} />
      <AnimRow label={t.scale} value={tr.scale} fallback={1} factor={100} min={0} suffix="%" onChange={set("scale")} {...common} />
      <AnimRow label={t.rotation} value={tr.rotation} fallback={0} suffix="°" onChange={set("rotation")} {...common} />
      <AnimRow
        label={t.opacity}
        value={clip.opacity}
        fallback={1}
        factor={100}
        min={0}
        max={100}
        suffix="%"
        onChange={(v, phase) => ed.edit({ opacity: v === 1 ? undefined : v }, "opacity", phase)}
        {...common}
      />
      <Row label={t.anchor}>
        <Segmented
          value={tr.anchor ?? "center"}
          options={[{ value: "center", label: t.anchorCenter }, { value: "top-left", label: t.anchorTopLeft }]}
          onChange={(anchor) => ed.edit({ transform: { ...tr, anchor: anchor === "center" ? undefined : anchor } }, "transform.anchor")}
        />
      </Row>
    </Section>
  );
}

function FitSection({ ed, t }: { ed: ClipEditor; t: T }) {
  const { clip } = ed;
  if (clip.type !== "video" && clip.type !== "image") return null;
  const kb = clip.type === "image" ? clip.kenBurns : undefined;
  const setKb = (patch: Partial<NonNullable<typeof kb>>, phase: "drag" | "commit") =>
    kb && ed.edit({ kenBurns: { ...kb, ...patch } } as Partial<Clip>, "kenBurns", phase);
  return (
    <Section title={t.fit}>
      <Row label={t.fit}>
        <Segmented
          value={clip.fit ?? "cover"}
          options={[{ value: "cover", label: t.fitCover }, { value: "contain", label: t.fitContain }, { value: "fill", label: t.fitFill }]}
          onChange={(fit) => ed.edit({ fit: fit === "cover" ? undefined : fit }, "fit")}
        />
      </Row>
      {clip.type === "image" && (
        <>
          <Row label={t.kenBurns}>
            <Toggle
              on={!!kb}
              label={t.kenBurns}
              onChange={(on) =>
                ed.edit({ kenBurns: on ? { fromScale: 1, toScale: 1.15, fromX: 0, toX: 0, fromY: 0, toY: 0 } : undefined } as Partial<Clip>, "kenBurns")
              }
            />
          </Row>
          {kb && (
            <>
              <Row label={`${t.scale} · ${t.kenBurnsFrom}`}>
                <NumberInput value={kb.fromScale * 100} min={10} suffix="%" onChange={(v, p) => setKb({ fromScale: v / 100 }, p)} />
                <NumberInput value={kb.toScale * 100} min={10} suffix="%" aria-label={`${t.scale} · ${t.kenBurnsTo}`} onChange={(v, p) => setKb({ toScale: v / 100 }, p)} />
              </Row>
              <Row label={`${t.posX} · ${t.kenBurnsFrom}`}>
                <NumberInput value={kb.fromX} suffix="px" onChange={(v, p) => setKb({ fromX: v }, p)} />
                <NumberInput value={kb.toX} suffix="px" aria-label={`${t.posX} · ${t.kenBurnsTo}`} onChange={(v, p) => setKb({ toX: v }, p)} />
              </Row>
              <Row label={`${t.posY} · ${t.kenBurnsFrom}`}>
                <NumberInput value={kb.fromY} suffix="px" onChange={(v, p) => setKb({ fromY: v }, p)} />
                <NumberInput value={kb.toY} suffix="px" aria-label={`${t.posY} · ${t.kenBurnsTo}`} onChange={(v, p) => setKb({ toY: v }, p)} />
              </Row>
            </>
          )}
        </>
      )}
    </Section>
  );
}

const ANIM_LABEL_KEYS: Record<TextAnimationKind, keyof T["animations"]> = {
  fade: "fade",
  "slide-up": "slideUp",
  "slide-down": "slideDown",
  "slide-left": "slideLeft",
  "slide-right": "slideRight",
  scale: "scale",
  blur: "blur",
  typewriter: "typewriter",
  words: "words",
};

function TextSection({ ed, t, projectFonts }: { ed: ClipEditor; t: T; projectFonts: string[] }) {
  const { clip } = ed;
  if (clip.type !== "text") return null;
  const anim = clip.animation ?? {};
  const animOptions = [{ value: "none", label: t.none }, ...Object.entries(ANIM_LABEL_KEYS).map(([value, key]) => ({ value, label: t.animations[key] }))];
  const setAnim = (side: "in" | "out", next: TextAnimation | undefined) => {
    const merged = { ...anim, [side]: next };
    if (!merged.in) delete merged.in;
    if (!merged.out) delete merged.out;
    ed.edit({ animation: merged.in || merged.out ? merged : undefined } as Partial<Clip>, `animation.${side}`);
  };
  const animRow = (side: "in" | "out", label: string) => {
    const cur = anim[side];
    return (
      <Row label={label}>
        <Select
          aria-label={`${t.animation} · ${label}`}
          value={cur?.kind ?? "none"}
          options={animOptions}
          onChange={(kind) => setAnim(side, kind === "none" ? undefined : { kind: kind as TextAnimationKind, durationInFrames: cur?.durationInFrames ?? Math.round(ed.comp.fps / 2) })}
        />
        {cur && (
          <NumberInput
            className="max-w-[64px] flex-none"
            aria-label={t.length}
            value={cur.durationInFrames}
            min={1}
            suffix="f"
            onChange={(v) => setAnim(side, { ...cur, durationInFrames: v })}
          />
        )}
      </Row>
    );
  };
  return (
    <>
      <Section title={t.text}>
        <TextInput multiline aria-label={t.text} value={clip.text} placeholder={t.textPlaceholder} onCommit={(text) => ed.edit({ text } as Partial<Clip>, "text")} />
        <TextStyleRows style={clip.style} onChange={(style, phase) => ed.edit({ style } as Partial<Clip>, "style", phase)} t={t} projectFonts={projectFonts} />
      </Section>
      <Section title={t.animation}>
        {animRow("in", t.animationIn)}
        {animRow("out", t.animationOut)}
      </Section>
    </>
  );
}

const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];

/** The full TextStyle, shared by text and captions clips. */
function TextStyleRows({ style, onChange, t, projectFonts }: { style: TextStyle; onChange: (s: TextStyle, phase: "drag" | "commit") => void; t: T; projectFonts: string[] }) {
  const set = <K extends keyof TextStyle>(key: K, value: TextStyle[K], phase: "drag" | "commit" = "commit") => {
    const next = { ...style, [key]: value };
    if (value === undefined) delete next[key];
    onChange(next, phase);
  };
  return (
    <>
      <Row label={t.font}>
        <FontPicker value={style.fontFamily} onChange={(f) => set("fontFamily", f)} projectFonts={projectFonts} label={t.font} searchLabel={t.fontSearch} />
      </Row>
      <Row label={t.fontSize}>
        <NumberInput aria-label={t.fontSize} value={style.fontSize} min={1} suffix="px" onChange={(v, p) => set("fontSize", v, p)} />
        <Select
          aria-label={t.fontWeight}
          className="max-w-[72px]"
          value={String(style.fontWeight)}
          options={WEIGHTS.map((w) => ({ value: String(w), label: String(w) }))}
          onChange={(w) => set("fontWeight", Number(w))}
        />
      </Row>
      <Row label={t.color}>
        <ColorInput aria-label={t.color} value={style.color} onChange={(c) => c && set("color", c)} />
      </Row>
      <Row label={t.align}>
        <Segmented
          value={style.align}
          options={[
            { value: "left", label: t.alignLeft, icon: <AlignLeft className="h-3.5 w-3.5" /> },
            { value: "center", label: t.alignCenter, icon: <AlignCenter className="h-3.5 w-3.5" /> },
            { value: "right", label: t.alignRight, icon: <AlignRight className="h-3.5 w-3.5" /> },
          ]}
          onChange={(a) => set("align", a)}
        />
      </Row>
      <Row label={t.lineHeight}>
        <NumberInput aria-label={t.lineHeight} value={style.lineHeight ?? 1.2} min={0.5} max={4} step={0.05} precision={2} onChange={(v, p) => set("lineHeight", v, p)} />
      </Row>
      <Row label={t.letterSpacing}>
        <NumberInput aria-label={t.letterSpacing} value={style.letterSpacing ?? 0} step={0.5} precision={1} suffix="px" onChange={(v, p) => set("letterSpacing", v || undefined, p)} />
      </Row>
      <Row label={t.maxWidth}>
        <NumberInput aria-label={t.maxWidth} value={style.maxWidth ?? 0} min={0} suffix="px" onChange={(v, p) => set("maxWidth", v || undefined, p)} />
      </Row>
      <Row label={t.textBackground}>
        <ColorInput aria-label={t.textBackground} allowEmpty value={style.background} onChange={(c) => set("background", c)} />
      </Row>
      {style.background && (
        <Row label={`${t.padding} · ${t.radius}`}>
          <NumberInput aria-label={t.padding} value={style.padding ?? 0} min={0} suffix="px" onChange={(v, p) => set("padding", v || undefined, p)} />
          <NumberInput aria-label={t.radius} value={style.radius ?? 0} min={0} suffix="px" onChange={(v, p) => set("radius", v || undefined, p)} />
        </Row>
      )}
      <Row label={t.stroke}>
        <ColorInput aria-label={t.stroke} allowEmpty value={style.stroke} onChange={(c) => set("stroke", c)} />
      </Row>
      <Row label={t.shadow}>
        <TextInput aria-label={t.shadow} value={style.shadow ?? ""} placeholder="0 4px 24px rgba(0,0,0,.5)" onCommit={(s) => set("shadow", s.trim() || undefined)} />
      </Row>
    </>
  );
}

function CaptionsSection({ ed, t, projectFonts }: { ed: ClipEditor; t: T; projectFonts: string[] }) {
  const { clip } = ed;
  if (clip.type !== "captions") return null;
  return (
    <Section title={t.captions}>
      <div className="text-[11.5px] text-text-400">{t.captionsCount.replace("{n}", String(clip.captions.length))}</div>
      <Row label={t.captionsMode}>
        <Select
          aria-label={t.captionsMode}
          value={clip.mode}
          options={[
            { value: "line", label: t.captionsModes.line },
            { value: "word-highlight", label: t.captionsModes.wordHighlight },
            { value: "karaoke", label: t.captionsModes.karaoke },
          ]}
          onChange={(mode) => ed.edit({ mode } as Partial<Clip>, "mode")}
        />
      </Row>
      {clip.mode !== "line" && (
        <Row label={t.highlightColor}>
          <ColorInput aria-label={t.highlightColor} allowEmpty value={clip.highlightColor} onChange={(c) => ed.edit({ highlightColor: c } as Partial<Clip>, "highlight")} />
        </Row>
      )}
      <TextStyleRows style={clip.style} onChange={(style, phase) => ed.edit({ style } as Partial<Clip>, "style", phase)} t={t} projectFonts={projectFonts} />
    </Section>
  );
}

function ShapeSection({ ed, t }: { ed: ClipEditor; t: T }) {
  const { clip } = ed;
  if (clip.type !== "shape") return null;
  const set = (patch: Partial<typeof clip>, key: string, phase: "drag" | "commit" = "commit") => ed.edit(patch as Partial<Clip>, key, phase);
  return (
    <Section title={t.shape}>
      <Row label={t.shape}>
        <Segmented
          value={clip.shape}
          options={[{ value: "rect", label: t.shapeRect }, { value: "circle", label: t.shapeCircle }, { value: "line", label: t.shapeLine }]}
          onChange={(shape) => set({ shape }, "shape")}
        />
      </Row>
      <Row label={`${t.width} · ${t.height}`}>
        <NumberInput aria-label={t.width} value={clip.width} min={1} suffix="px" onChange={(v, p) => set({ width: v }, "width", p)} />
        <NumberInput aria-label={t.height} value={clip.height} min={1} suffix="px" onChange={(v, p) => set({ height: v }, "height", p)} />
      </Row>
      <Row label={t.fill}>
        <ColorInput aria-label={t.fill} value={clip.fill} onChange={(c) => set({ fill: c ?? "transparent" }, "fill")} />
      </Row>
      <Row label={t.stroke}>
        <ColorInput aria-label={t.stroke} allowEmpty value={clip.stroke} onChange={(c) => set({ stroke: c }, "stroke")} />
      </Row>
      {clip.stroke && (
        <Row label={t.strokeWidth}>
          <NumberInput aria-label={t.strokeWidth} value={clip.strokeWidth ?? 2} min={0} suffix="px" onChange={(v, p) => set({ strokeWidth: v }, "strokeWidth", p)} />
        </Row>
      )}
      {clip.shape === "rect" && (
        <Row label={t.radius}>
          <NumberInput aria-label={t.radius} value={clip.radius ?? 0} min={0} suffix="px" onChange={(v, p) => set({ radius: v || undefined }, "radius", p)} />
        </Row>
      )}
    </Section>
  );
}

function AudioSection({ ed, t, workspace, slug }: { ed: ClipEditor; t: T; workspace: string; slug: string }) {
  const { clip, comp, frameInClip } = ed;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const tAgent = useTranslations().videoAgent;
  if (clip.type !== "video" && clip.type !== "audio") return null;
  const caption = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      // generateCaptions reads and writes timeline.json itself: save pending edits first, and
      // load its result right after instead of waiting for the file watcher.
      await flushSave();
      const r = await generateCaptions({ workspace, slug, compositionId: comp.id, clipId: clip.id });
      await checkExternalChange();
      setResult(tAgent.captionsAdded.replace("{words}", String(r.words)) + (r.timing === "estimated" ? ` · ${tAgent.captionsEstimated}` : ""));
    } catch (e) {
      const reason = e instanceof CaptionsError ? e.reason : "failed";
      const text = e instanceof Error ? e.message : String(e);
      setError(
        reason === "not-signed-in" ? tAgent.captionsNotSignedIn
        : reason === "empty" ? tAgent.captionsNoSpeech
        : reason === "no-audio" ? tAgent.captionsNoAudio
        : tAgent.captionsFailed.replace("{error}", text),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t.audio}>
      <AnimRow
        label={t.volume}
        value={clip.volume}
        fallback={1}
        factor={100}
        min={0}
        max={200}
        suffix="%"
        frameInClip={frameInClip}
        onJump={ed.jump}
        labels={keyLabels(t)}
        onChange={(v, phase) => ed.edit({ volume: v === 1 ? undefined : v } as Partial<Clip>, "volume", phase)}
      />
      {clip.type === "audio" && (
        <Row label={`${t.fadeIn} · ${t.fadeOut}`}>
          <NumberInput aria-label={t.fadeIn} value={clip.fadeIn ?? 0} min={0} suffix="f" onChange={(v, p) => ed.edit({ fadeIn: v || undefined } as Partial<Clip>, "fadeIn", p)} />
          <NumberInput aria-label={t.fadeOut} value={clip.fadeOut ?? 0} min={0} suffix="f" onChange={(v, p) => ed.edit({ fadeOut: v || undefined } as Partial<Clip>, "fadeOut", p)} />
        </Row>
      )}
      <Button variant="secondary" className="mt-1 h-7 w-full text-[12px]" disabled={busy} onClick={() => void caption()}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Captions className="h-3.5 w-3.5" />}
        {t.generateCaptions}
      </Button>
      {error && <p className="text-[11.5px] leading-snug text-red-600 dark:text-red-400">{error}</p>}
      {result && <p className="text-[11.5px] leading-snug text-text-300">{result}</p>}
    </Section>
  );
}

const TRANSITION_LABEL_KEYS: Record<Exclude<TransitionKind, "none">, keyof T["transitions"]> = {
  fade: "fade",
  slide: "slide",
  wipe: "wipe",
  flip: "flip",
  "clock-wipe": "clockWipe",
  iris: "iris",
};

const DIRECTIONS = ["from-left", "from-right", "from-top", "from-bottom"] as const;
const DIRECTION_KEYS: Record<(typeof DIRECTIONS)[number], keyof T["directions"]> = {
  "from-left": "fromLeft",
  "from-right": "fromRight",
  "from-top": "fromTop",
  "from-bottom": "fromBottom",
};

function TransitionSection({ ed, t }: { ed: ClipEditor; t: T }) {
  const { clip, comp } = ed;
  const tr = clip.transitionIn && clip.transitionIn.kind !== "none" ? clip.transitionIn : undefined;
  const apply = (next: Transition | null) =>
    timelineActions.setTransition(clip.id, next, `inspector:${clip.id}:transition`);
  const directional = tr && (tr.kind === "slide" || tr.kind === "wipe" || tr.kind === "flip");
  return (
    <Section title={t.transitionIn} defaultOpen={!!tr}>
      <Row label={t.transitionIn}>
        <Select
          aria-label={t.transitionIn}
          value={tr?.kind ?? "none"}
          options={[{ value: "none", label: t.none }, ...Object.entries(TRANSITION_LABEL_KEYS).map(([value, key]) => ({ value, label: t.transitions[key] }))]}
          onChange={(kind) =>
            apply(kind === "none" ? null : { ...tr, kind: kind as TransitionKind, durationInFrames: tr?.durationInFrames ?? Math.round(comp.fps / 2) })
          }
        />
      </Row>
      {tr && (
        <Row label={t.length}>
          <NumberInput aria-label={t.length} value={tr.durationInFrames} min={1} suffix="f" onChange={(v) => apply({ ...tr, durationInFrames: v })} />
        </Row>
      )}
      {directional && (
        <Row label={t.direction}>
          <Select
            aria-label={t.direction}
            value={tr.direction ?? "from-left"}
            options={DIRECTIONS.map((d) => ({ value: d, label: t.directions[DIRECTION_KEYS[d]] }))}
            onChange={(direction) => apply({ ...tr, direction })}
          />
        </Row>
      )}
    </Section>
  );
}
