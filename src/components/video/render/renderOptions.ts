import type { RenderOptions } from "@/lib/video/videoApi";

export type RenderFormat = "h264" | "h265" | "webm" | "prores" | "gif" | "png";
export type Quality = "high" | "medium" | "low";
export type RangeKind = "all" | "inout" | "markers";

export const FORMATS: RenderFormat[] = ["h264", "h265", "webm", "prores", "gif", "png"];
export const EXT: Record<RenderFormat, string> = { h264: "mp4", h265: "mp4", webm: "webm", prores: "mov", gif: "gif", png: "png" };

/** CRF per format and quality (lower = better). ProRes, GIF and PNG don't take one. */
export const CRF: Partial<Record<RenderFormat, Record<Quality, number>>> = {
  h264: { high: 16, medium: 20, low: 28 },
  h265: { high: 20, medium: 25, low: 31 },
  webm: { high: 24, medium: 32, low: 40 },
};

export const SCALES = [2, 1, 0.75, 0.5, 0.25];

/** What a render dialog's choices turn into for the backend (pure, tested). */
export function buildRenderOptions(p: {
  format: Exclude<RenderFormat, "png">;
  quality: Quality;
  scale: number;
  range: [number, number] | null;
  includeAudio: boolean;
  compositionId: string;
  outputName: string;
  gifFps?: number;
}): RenderOptions {
  const codec = p.format === "webm" ? "vp9" : p.format;
  const crf = CRF[p.format]?.[p.quality];
  const silent = p.format === "gif" || !p.includeAudio;
  return {
    compositionId: p.compositionId,
    codec,
    ...(crf !== undefined ? { crf } : {}),
    ...(p.scale !== 1 ? { scale: p.scale } : {}),
    ...(p.range ? { frameRange: p.range } : {}),
    ...(p.format === "gif" && p.gifFps ? { fps: p.gifFps } : {}),
    ...(silent ? { muted: true } : {}),
    outputName: p.outputName,
  };
}
