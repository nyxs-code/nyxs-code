import { staticFile } from "remotion";
import type { Asset } from "./schema";

/** URL for an asset: http(s) URLs pass through, anything else is a file in public/. */
export function assetUrl(asset: Pick<Asset, "src">): string {
  return /^https?:\/\//i.test(asset.src) ? asset.src : staticFile(asset.src);
}

export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
