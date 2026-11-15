import React, { useCallback, useRef } from "react";
import { resolveAnimatable } from "./schema";
import type { Effect } from "./schema";

/** CSS `filter` for the clip's effects at a frame, or undefined when there is none. */
export function cssFilter(effects: Effect[] | undefined, frame: number): string | undefined {
  if (!effects || effects.length === 0) return undefined;
  const parts: string[] = [];
  for (const e of effects) {
    switch (e.kind) {
      case "blur":
        parts.push(`blur(${resolveAnimatable(e.amount, frame)}px)`);
        break;
      case "brightness":
      case "contrast":
      case "saturate":
      case "grayscale":
      case "sepia":
      case "invert":
        parts.push(`${e.kind}(${resolveAnimatable(e.amount, frame)})`);
        break;
      case "hue-rotate":
        parts.push(`hue-rotate(${resolveAnimatable(e.degrees, frame)}deg)`);
        break;
      case "drop-shadow":
        parts.push(`drop-shadow(${e.x}px ${e.y}px ${e.blur}px ${e.color})`);
        break;
      default:
        break;
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function findEffect<K extends Effect["kind"]>(effects: Effect[] | undefined, kind: K): Extract<Effect, { kind: K }> | undefined {
  return effects?.find((e): e is Extract<Effect, { kind: K }> => e.kind === kind);
}

/** Darkened edges over the clip box. */
export const Vignette: React.FC<{ amount: number }> = ({ amount }) => {
  if (amount <= 0) return null;
  const a = Math.min(1, amount);
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        background: `radial-gradient(ellipse at center, rgba(0,0,0,0) ${Math.round(65 - a * 35)}%, rgba(0,0,0,${0.35 + a * 0.6}) 100%)`,
      }}
    />
  );
};

const colorCache = new Map<string, [number, number, number]>();

/** Any CSS color to RGB, through a 1x1 canvas so names, hex, rgb() and hsl() all work. */
function parseColor(color: string): [number, number, number] {
  const cached = colorCache.get(color);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  let rgb: [number, number, number] = [0, 255, 0];
  if (ctx) {
    ctx.fillStyle = "#00ff00";
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    rgb = [d[0], d[1], d[2]];
  }
  colorCache.set(color, rgb);
  return rgb;
}

function sourceSize(source: CanvasImageSource): [number, number] {
  if (typeof HTMLVideoElement !== "undefined" && source instanceof HTMLVideoElement) return [source.videoWidth, source.videoHeight];
  if (typeof HTMLImageElement !== "undefined" && source instanceof HTMLImageElement) return [source.naturalWidth, source.naturalHeight];
  if (typeof VideoFrame !== "undefined" && source instanceof VideoFrame) return [source.displayWidth, source.displayHeight];
  const s = source as { width?: unknown; height?: unknown };
  return [typeof s.width === "number" ? s.width : 0, typeof s.height === "number" ? s.height : 0];
}

/**
 * Draws `source` into `canvas` with pixels near `color` made transparent. `tolerance` 0..1 is
 * the RGB distance treated as the key color; a small band above it is feathered.
 */
export function drawChromaKey(source: CanvasImageSource, canvas: HTMLCanvasElement, color: string, tolerance: number): void {
  const [w, h] = sourceSize(source);
  if (w === 0 || h === 0) return;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const [kr, kg, kb] = parseColor(color);
  const max = Math.sqrt(3) * 255;
  const inner = tolerance * max;
  const outer = Math.min(max, inner + 0.08 * max);
  for (let i = 0; i < d.length; i += 4) {
    const dr = d[i] - kr;
    const dg = d[i + 1] - kg;
    const db = d[i + 2] - kb;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    if (dist <= inner) d[i + 3] = 0;
    else if (dist < outer) d[i + 3] = Math.round((d[i + 3] * (dist - inner)) / (outer - inner));
  }
  ctx.putImageData(img, 0, 0);
}

/** A canvas plus a callback that keys each frame into it. */
export function useChromaCanvas(color: string, tolerance: number) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onFrame = useCallback(
    (source: CanvasImageSource) => {
      if (canvasRef.current) drawChromaKey(source, canvasRef.current, color, tolerance);
    },
    [color, tolerance],
  );
  return { canvasRef, onFrame };
}
