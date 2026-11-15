import React from "react";
import { applyEasing } from "./schema";
import type { TextAnimation, TextClip, TextStyle } from "./schema";
import { clamp01 } from "./assets";
import { cssFontFamily } from "./fonts";

/** CSS for a TextStyle (the box that holds the text). */
export function textStyleCss(style: TextStyle): React.CSSProperties {
  const strokeWidth = Math.max(1, Math.round(style.fontSize / 28));
  return {
    fontFamily: cssFontFamily(style.fontFamily),
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    color: style.color,
    textAlign: style.align,
    lineHeight: style.lineHeight ?? 1.2,
    letterSpacing: style.letterSpacing !== undefined ? `${style.letterSpacing}px` : undefined,
    background: style.background,
    padding: style.padding,
    borderRadius: style.radius,
    textShadow: style.shadow,
    WebkitTextStroke: style.stroke ? `${strokeWidth * 2}px ${style.stroke}` : undefined,
    paintOrder: style.stroke ? "stroke fill" : undefined,
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    maxWidth: style.maxWidth,
    boxSizing: "border-box",
  };
}

/** Progress of the in (0→1) and out (0→1) animations at a frame of the clip. */
export function animationProgress(
  animation: { in?: TextAnimation; out?: TextAnimation } | undefined,
  frame: number,
  durationInFrames: number,
): { inP: number; outP: number } {
  const inA = animation?.in;
  const outA = animation?.out;
  const inP = inA ? clamp01(frame / inA.durationInFrames) : 1;
  const outP = outA ? clamp01((frame - (durationInFrames - outA.durationInFrames)) / outA.durationInFrames) : 0;
  return { inP, outP };
}

/** Whole-block style for the non per-character animations. */
function blockAnimationStyle(kind: TextAnimation["kind"] | undefined, p: number, entering: boolean): React.CSSProperties {
  if (!kind || kind === "typewriter" || kind === "words") return {};
  // p: 0 = hidden, 1 = fully shown.
  const e = entering ? applyEasing("ease-out", p) : 1 - applyEasing("ease-in", 1 - p);
  const away = 1 - e;
  const sign = entering ? 1 : -1;
  switch (kind) {
    case "fade":
      return { opacity: e };
    case "slide-up":
      return { opacity: e, transform: `translateY(${sign * away * 60}px)` };
    case "slide-down":
      return { opacity: e, transform: `translateY(${-sign * away * 60}px)` };
    case "slide-left":
      return { opacity: e, transform: `translateX(${sign * away * 80}px)` };
    case "slide-right":
      return { opacity: e, transform: `translateX(${-sign * away * 80}px)` };
    case "scale":
      return { opacity: e, transform: `scale(${0.6 + 0.4 * e})` };
    case "blur":
      return { opacity: e, filter: `blur(${away * 24}px)` };
    default:
      return {};
  }
}

function mergeStyles(a: React.CSSProperties, b: React.CSSProperties): React.CSSProperties {
  const transform = [a.transform, b.transform].filter(Boolean).join(" ") || undefined;
  const filter = [a.filter, b.filter].filter(Boolean).join(" ") || undefined;
  const opacity = (a.opacity === undefined ? 1 : Number(a.opacity)) * (b.opacity === undefined ? 1 : Number(b.opacity));
  return { ...a, ...b, transform, filter, opacity };
}

export const TextContent: React.FC<{ clip: TextClip; frame: number }> = ({ clip, frame }) => {
  const { inP, outP } = animationProgress(clip.animation, frame, clip.durationInFrames);
  const inKind = clip.animation?.in?.kind;
  const outKind = clip.animation?.out?.kind;
  const block = mergeStyles(blockAnimationStyle(inKind, inP, true), blockAnimationStyle(outKind, 1 - outP, false));
  const text = clip.text;

  let body: React.ReactNode = text;
  if (inKind === "typewriter" || outKind === "typewriter") {
    const chars = Array.from(text);
    let visible = chars.length;
    if (inKind === "typewriter") visible = Math.min(visible, Math.floor(chars.length * inP));
    if (outKind === "typewriter") visible = Math.min(visible, Math.ceil(chars.length * (1 - outP)));
    // The hidden rest keeps its space, so the box does not grow while typing.
    body = (
      <>
        {chars.slice(0, visible).join("")}
        <span style={{ visibility: "hidden" }}>{chars.slice(visible).join("")}</span>
      </>
    );
  } else if (inKind === "words" || outKind === "words") {
    const parts = text.split(/(\s+)/);
    const words = parts.filter((p) => p.trim() !== "").length;
    let wi = 0;
    body = parts.map((part, i) => {
      if (part.trim() === "") return part;
      const idx = wi++;
      const stagger = words > 1 ? (idx / (words - 1)) * 0.6 : 0;
      const wIn = inKind === "words" ? clamp01((inP - stagger) / 0.4) : 1;
      const wOut = outKind === "words" ? clamp01((outP - stagger) / 0.4) : 0;
      const shown = applyEasing("ease-out", wIn) * (1 - applyEasing("ease-in", wOut));
      return (
        <span
          key={i}
          style={{
            display: "inline-block",
            whiteSpace: "pre",
            opacity: shown,
            transform: `translateY(${(1 - shown) * 0.4}em)`,
          }}
        >
          {part}
        </span>
      );
    });
  }

  return (
    <div style={{ ...textStyleCss(clip.style), width: "max-content" }}>
      <div style={block}>{body}</div>
    </div>
  );
};
