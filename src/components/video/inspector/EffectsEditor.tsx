import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import type { Translations } from "@/lib/i18n";
import { EFFECT_KINDS, type Animatable, type Effect, type EffectKind } from "@/lib/video/timelineSchema";
import { AnimRow } from "./AnimRow";
import { keyLabels } from "./animatable";
import { defaultEffect } from "./effects";
import { ColorInput, NumberInput, Row, Section } from "./fields";

type T = Translations["videoPanel"];

const LABEL_KEYS: Record<EffectKind, keyof T["effectKinds"]> = {
  blur: "blur",
  brightness: "brightness",
  contrast: "contrast",
  saturate: "saturate",
  grayscale: "grayscale",
  sepia: "sepia",
  invert: "invert",
  "hue-rotate": "hueRotate",
  "drop-shadow": "dropShadow",
  "chroma-key": "chromaKey",
  vignette: "vignette",
};

interface Props {
  effects: Effect[];
  onChange: (effects: Effect[], phase: "drag" | "commit") => void;
  frameInClip: number;
  onJump: (frameInClip: number) => void;
  t: T;
}

/** The clip's effects in the order they apply: add, tune, reorder, remove. */
export function EffectsEditor({ effects, onChange, frameInClip, onJump, t }: Props) {
  const labels = keyLabels(t);
  const replace = (i: number, e: Effect, phase: "drag" | "commit" = "commit") => onChange(effects.map((x, j) => (j === i ? e : x)), phase);
  const move = (i: number, d: -1 | 1) => {
    const next = [...effects];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next, "commit");
  };
  const iconBtn = "flex h-6 w-6 items-center justify-center rounded-[6px] text-text-400 hover:bg-bg-200 hover:text-text-100 disabled:opacity-30 disabled:hover:bg-transparent";

  const addMenu = (
    <label className="relative flex h-6 w-6 cursor-pointer items-center justify-center rounded-[6px] text-text-300 hover:bg-bg-200 hover:text-text-100" data-tooltip={t.addEffect}>
      <Plus className="h-3.5 w-3.5" />
      <select
        aria-label={t.addEffect}
        value=""
        onChange={(e) => {
          const kind = e.target.value as EffectKind;
          if (kind) onChange([...effects, defaultEffect(kind)], "commit");
        }}
        onKeyDown={(e) => e.stopPropagation()}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        <option value="" disabled>{t.addEffect}</option>
        {EFFECT_KINDS.map((k) => (
          <option key={k} value={k}>{t.effectKinds[LABEL_KEYS[k]]}</option>
        ))}
      </select>
    </label>
  );

  return (
    <Section title={t.effects} actions={addMenu} defaultOpen={effects.length > 0}>
      {effects.length === 0 && <p className="text-[12px] text-text-400">{t.noEffects}</p>}
      {effects.map((e, i) => {
        const anim = (label: string, value: Animatable<number>, fallback: number, set: (v: Animatable<number>) => Effect, opts: { min?: number; max?: number; step?: number; precision?: number; suffix?: string; factor?: number } = {}) => (
          <AnimRow label={label} value={value} fallback={fallback} frameInClip={frameInClip} onJump={onJump} labels={labels} onChange={(v, p) => replace(i, set(v), p)} {...opts} />
        );
        return (
          <div key={i} className="rounded-[6px] border border-bg-300/80 bg-bg-0/40 p-2">
            <div className="mb-1.5 flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text-100">{t.effectKinds[LABEL_KEYS[e.kind]]}</span>
              <button type="button" className={iconBtn} disabled={i === 0} onClick={() => move(i, -1)} aria-label={t.moveUp} data-tooltip={t.moveUp}>
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <button type="button" className={iconBtn} disabled={i === effects.length - 1} onClick={() => move(i, 1)} aria-label={t.moveDown} data-tooltip={t.moveDown}>
                <ArrowDown className="h-3.5 w-3.5" />
              </button>
              <button type="button" className={iconBtn} onClick={() => onChange(effects.filter((_, j) => j !== i), "commit")} aria-label={t.remove} data-tooltip={t.remove}>
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="space-y-1.5">
              {e.kind === "blur" && anim(t.amount, e.amount, 0, (amount) => ({ ...e, amount }), { min: 0, step: 0.5, precision: 1, suffix: "px" })}
              {(e.kind === "brightness" || e.kind === "contrast" || e.kind === "saturate") &&
                anim(t.amount, e.amount, 1, (amount) => ({ ...e, amount }), { min: 0, max: 500, factor: 100, suffix: "%" })}
              {(e.kind === "grayscale" || e.kind === "sepia" || e.kind === "invert") &&
                anim(t.amount, e.amount, 1, (amount) => ({ ...e, amount }), { min: 0, max: 100, factor: 100, suffix: "%" })}
              {e.kind === "hue-rotate" && anim(t.degrees, e.degrees, 0, (degrees) => ({ ...e, degrees }), { suffix: "°" })}
              {e.kind === "drop-shadow" && (
                <>
                  <Row label={`${t.offsetX} · ${t.offsetY}`}>
                    <NumberInput aria-label={t.offsetX} value={e.x} suffix="px" onChange={(x, p) => replace(i, { ...e, x }, p)} />
                    <NumberInput aria-label={t.offsetY} value={e.y} suffix="px" onChange={(y, p) => replace(i, { ...e, y }, p)} />
                  </Row>
                  <Row label={t.blurRadius}>
                    <NumberInput aria-label={t.blurRadius} value={e.blur} min={0} suffix="px" onChange={(blur, p) => replace(i, { ...e, blur }, p)} />
                  </Row>
                  <Row label={t.color}>
                    <ColorInput aria-label={t.color} value={e.color} onChange={(color) => color && replace(i, { ...e, color })} />
                  </Row>
                </>
              )}
              {e.kind === "chroma-key" && (
                <>
                  <Row label={t.color}>
                    <ColorInput aria-label={t.color} value={e.color} onChange={(color) => color && replace(i, { ...e, color })} />
                  </Row>
                  <Row label={t.tolerance}>
                    <NumberInput aria-label={t.tolerance} value={e.tolerance * 100} min={0} max={100} suffix="%" onChange={(v, p) => replace(i, { ...e, tolerance: v / 100 }, p)} />
                  </Row>
                </>
              )}
              {e.kind === "vignette" && (
                <Row label={t.amount}>
                  <NumberInput aria-label={t.amount} value={e.amount * 100} min={0} max={100} suffix="%" onChange={(v, p) => replace(i, { ...e, amount: v / 100 }, p)} />
                </Row>
              )}
            </div>
          </div>
        );
      })}
    </Section>
  );
}
