import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { MascotMood } from "@/lib/mascotMood";

/** Every clip, a lossless animated WebP with alpha, by file name. Lossless keeps every pixel's
 *  colour (VP9 video halves the colour resolution, which shows as steps on the edges), and WebKit
 *  plays it too. Each comes at 96 and 192 px, scaled down with lanczos beforehand: the browser's
 *  own downscale of a much bigger clip looks jagged. */
const PX = [96, 192];
const FILES = import.meta.glob<string>("/src/assets/mascot/mango-*.webp", { eager: true, import: "default" });

/** `ms` is the clip's length, to end a play-once clip: an image has no `ended`. */
type Look = { src: (px: number) => string; ms: number };

const clip = (name: string, ms = 0): Look => ({
  // The smallest that covers `px` device pixels, or the biggest there is.
  src: (px) => FILES[`/src/assets/mascot/mango-${name}-${PX.find((s) => s >= px) ?? PX[PX.length - 1]}.webp`],
  ms,
});

const LOOKS: Record<MascotMood, Look> = {
  wave: clip("hello", 3042),
  rest: clip("rest"),
  think: clip("thinking"),
  search: clip("headScratch"),
  code: clip("focus"),
  celebrate: clip("hype"),
  surprised: clip("dizzy"),
  sad: clip("sad"),
  shy: clip("peekaboo"),
  sleep: clip("nap"),
  intro: clip("dance", 3042),
};

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Clips that play once and then settle into another look, instead of looping. */
const THEN: Partial<Record<MascotMood, MascotMood>> = { wave: "rest", intro: "rest" };

/** How long a new look takes to fade in, so a change of mood isn't a cut. */
const FADE_MS = 300;
/** The old look fades out faster: half-faded, its limbs read as a dark ghost on the background. */
const FADE_OUT_MS = 160;

type LayerProps = { mood: MascotMood; size: number; hidden: boolean; onReady: () => void; onEnded: () => void };

/** One look. The WebP loops, so a play-once clip ends after its `ms`; its own query string per
 *  mount makes it start from the first frame instead of where a cached copy was. */
function Layer({ mood, size, hidden, onReady, onEnded }: LayerProps) {
  const look = LOOKS[mood];
  const once = THEN[mood] ? look.ms : 0;
  const [url] = useState(() => `${look.src(Math.round(size * (window.devicePixelRatio || 1)))}?play=${Date.now()}`);
  const [loaded, setLoaded] = useState(false);
  // Timed from the load only: `onEnded` is a new function every render.
  const endedRef = useRef(onEnded);
  useEffect(() => { endedRef.current = onEnded; });
  useEffect(() => {
    if (!loaded || !once) return;
    const t = setTimeout(() => endedRef.current(), reducedMotion() ? 0 : once);
    return () => clearTimeout(t);
  }, [loaded, once]);
  const style: CSSProperties = {
    position: "absolute",
    inset: 0,
    width: size,
    height: size,
    opacity: hidden ? 0 : 1,
    transition: reducedMotion() ? undefined : hidden ? `opacity ${FADE_OUT_MS}ms ease-out` : `opacity ${FADE_MS}ms ease-in-out`,
  };
  return <img src={url} alt="" draggable={false} style={style} onLoad={() => { setLoaded(true); onReady(); }} />;
}

/**
 * The Nyxs mascot, an orangutan. It shows `mood`; a new one loads hidden over the current one
 * and, once its first frame is ready, the two cross-fade, so a change never blinks or cuts.
 */
export function NyxsMascot({ mood, size = 72 }: { mood: MascotMood; size?: number }) {
  // A play-once clip that finished: until `mood` changes, show what it settles into.
  const [played, setPlayed] = useState<MascotMood | null>(null);
  const [lastMood, setLastMood] = useState(mood);
  if (lastMood !== mood) {
    setLastMood(mood);
    setPlayed(null);
  }
  const target = played === mood ? (THEN[mood] ?? mood) : mood;

  const [shown, setShown] = useState<MascotMood>(target);
  // The look fading out, kept mounted until its fade ends.
  const [leaving, setLeaving] = useState<MascotMood | null>(null);
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => setLeaving(null), FADE_MS);
    return () => clearTimeout(t);
  }, [leaving]);
  // Oldest first, so the newer look is on top. Same key for a layer while it waits and once it
  // shows, so it isn't loaded twice.
  const layers = [...new Set([leaving, shown, target])].filter((m): m is MascotMood => !!m);
  // Back to the look still fading out: it's loaded already (no new `onReady`), so it fades back in.
  if (target === leaving && target !== shown) {
    setLeaving(shown);
    setShown(target);
  }
  const reveal = (m: MascotMood) => {
    if (m !== target || m === shown) return;
    setLeaving(shown);
    setShown(m);
  };

  return (
    <div role="img" aria-label="Nyxs" style={{ position: "relative", width: size, height: size }}>
      {layers.map((m) => (
        <Layer
          key={m}
          mood={m}
          size={size}
          hidden={m !== shown}
          onReady={() => reveal(m)}
          onEnded={() => { if (m === mood && THEN[m]) setPlayed(m); }}
        />
      ))}
    </div>
  );
}

export default NyxsMascot;
