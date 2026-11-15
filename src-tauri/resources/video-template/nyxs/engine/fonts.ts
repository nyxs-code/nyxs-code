import { useEffect, useRef, useState } from "react";
import { continueRender, delayRender } from "remotion";
import { assetUrl } from "./assets";
import type { Asset, Composition, Timeline } from "./schema";

const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "inherit",
  "initial",
]);

// Fonts every OS ships; never look them up on Google Fonts.
const SYSTEM_FAMILIES = new Set([
  "arial",
  "helvetica",
  "helvetica neue",
  "times",
  "times new roman",
  "georgia",
  "verdana",
  "tahoma",
  "trebuchet ms",
  "courier",
  "courier new",
  "segoe ui",
  "-apple-system",
  "blinkmacsystemfont",
  "impact",
]);

/** First family of a CSS font stack, without quotes. */
export function primaryFamily(stack: string): string {
  return stack.split(",")[0].trim().replace(/^["']|["']$/g, "");
}

/** CSS font-family for a TextStyle.fontFamily: quotes a bare family and adds a fallback. */
export function cssFontFamily(family: string): string {
  if (family.includes(",")) return family;
  const name = family.trim().replace(/^["']|["']$/g, "");
  if (GENERIC_FAMILIES.has(name.toLowerCase())) return name;
  return `"${name}", sans-serif`;
}

const loaded = new Map<string, Promise<void>>();

function once(key: string, load: () => Promise<void>): Promise<void> {
  let p = loaded.get(key);
  if (!p) {
    p = load().catch((err: unknown) => {
      loaded.delete(key);
      throw err;
    });
    loaded.set(key, p);
  }
  return p;
}

function loadAssetFont(asset: Asset): Promise<void> {
  return once(`asset:${asset.name}:${asset.src}`, async () => {
    if (typeof FontFace === "undefined") return;
    const face = new FontFace(asset.name, `url("${assetUrl(asset)}")`);
    await face.load();
    document.fonts.add(face);
  });
}

function loadStylesheet(href: string): Promise<boolean> {
  return new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.crossOrigin = "anonymous";
    link.onload = () => resolve(true);
    link.onerror = () => {
      link.remove();
      resolve(false);
    };
    document.head.appendChild(link);
  });
}

function googleCssUrl(family: string, weight: number | null): string {
  const name = encodeURIComponent(family).replace(/%20/g, "+");
  return `https://fonts.googleapis.com/css2?family=${name}${weight ? `:wght@${weight}` : ""}&display=block`;
}

/**
 * Google Fonts through their CSS API rather than @remotion/google-fonts' catalog: importing the
 * catalog adds ~1,850 font modules to every bundle (slow player rebuilds and renders). Unknown
 * families or weights get a 400 from the API, and then the text uses the fallback font.
 */
function loadGoogleFont(family: string, weight: number, text: string): Promise<void> {
  // The API only serves whole hundreds.
  const w = Math.min(900, Math.max(100, Math.round(weight / 100) * 100));
  return once(`google:${family.toLowerCase()}:${w}:${text}`, async () => {
    if (typeof document === "undefined" || typeof FontFace === "undefined") return;
    const ok = (await loadStylesheet(googleCssUrl(family, w))) || (await loadStylesheet(googleCssUrl(family, null)));
    if (!ok) return;
    // Fetch the faces (and unicode-range subsets) this text needs before the frame is captured.
    await document.fonts.load(`${w} 16px "${family}"`, text || "A");
  });
}

type FontRequest = { family: string; weight: number; text: string };

/** The distinct characters of a text (capped), enough to pick the unicode-range subsets. */
function uniqueChars(text: string): string {
  return Array.from(new Set(Array.from(text.replace(/\s+/g, "")))).slice(0, 400).join("");
}

function fontRequests(timeline: Timeline, composition: Composition): { assets: Asset[]; google: FontRequest[] } {
  const assets = timeline.assets.filter((a) => a.kind === "font");
  const assetNames = new Set(assets.map((a) => a.name.toLowerCase()));
  const seen = new Set<string>();
  const google: FontRequest[] = [];
  for (const track of composition.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.type !== "text" && clip.type !== "captions") continue;
      const family = primaryFamily(clip.style.fontFamily);
      const lower = family.toLowerCase();
      if (assetNames.has(lower) || GENERIC_FAMILIES.has(lower) || SYSTEM_FAMILIES.has(lower)) continue;
      const key = `${lower}:${clip.style.fontWeight}`;
      const text = clip.type === "text" ? clip.text : clip.captions.map((c) => c.text).join(" ");
      if (!seen.has(key)) {
        seen.add(key);
        google.push({ family, weight: clip.style.fontWeight, text: "" });
      }
      const req = google.find((g) => `${g.family.toLowerCase()}:${g.weight}` === key);
      if (req) req.text = uniqueChars(req.text + text);
    }
  }
  return { assets, google };
}

/**
 * Loads the font assets and the Google Fonts used by text and captions clips, holding the
 * render (delayRender) until they are ready. Failures are logged, never fatal: the text then
 * renders with the fallback font.
 */
export function useTimelineFonts(timeline: Timeline, composition: Composition): void {
  const { assets, google } = fontRequests(timeline, composition);
  const key = JSON.stringify([assets.map((a) => [a.name, a.src]), google]);
  const [initialHandle] = useState(() => delayRender("Loading fonts", { timeoutInMilliseconds: 60_000 }));
  const initialUsed = useRef(false);

  useEffect(() => {
    const handle = initialUsed.current ? delayRender("Loading fonts", { timeoutInMilliseconds: 60_000 }) : initialHandle;
    initialUsed.current = true;
    const jobs = [
      ...assets.map((a) => loadAssetFont(a).catch((e: unknown) => console.warn(`[nyxs-video] font asset "${a.name}" failed to load`, e))),
      ...google.map((g) => loadGoogleFont(g.family, g.weight, g.text).catch((e: unknown) => console.warn(`[nyxs-video] Google font "${g.family}" failed to load`, e))),
    ];
    Promise.all(jobs).finally(() => continueRender(handle));
    // `key` already encodes `assets` and `google`, which are new arrays on every render.
  }, [key, initialHandle]);
}
