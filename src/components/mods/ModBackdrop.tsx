import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { modHost } from "@/lib/mods/io";
import { isElement, type Backdrop, type Gradient, type RenderNode, type StandingTheme } from "@/lib/mods/types";
import { svgSource } from "@/lib/mods/svg";

/** The design system's names a still ground may color with, as Nyxs paints them. */
const NAMED: Record<string, string> = {
  "surface-0": "var(--bg-0)",
  "surface-1": "var(--bg-100)",
  "surface-2": "var(--bg-200)",
  "surface-3": "var(--bg-200)",
  "text-primary": "var(--text-100)",
  "text-secondary": "var(--text-300)",
  "text-muted": "var(--text-400)",
  "text-disabled": "var(--text-500)",
  border: "var(--bg-300)",
  "border-strong": "var(--bg-300)",
  "border-stronger": "var(--text-500)",
  "fill-primary": "var(--text-100)",
  "on-primary": "var(--bg-0)",
  "fill-accent": "var(--accent)",
  "text-accent": "var(--accent)",
  "bg-accent": "color-mix(in srgb, var(--accent) 15%, transparent)",
  "on-accent": "#ffffff",
  "fill-danger": "var(--danger)",
  "text-danger": "var(--danger)",
  "fill-success": "var(--success)",
  "text-success": "var(--success)",
  "fill-warning": "var(--warning)",
  "text-warning": "var(--warning)",
};

function groundColor(c: unknown): string | null {
  if (typeof c !== "string") return null;
  if (c in NAMED) return NAMED[c];
  if (c === "transparent" || /^#[0-9a-f]{3,8}$/i.test(c) || /^(rgb|hsl)a?\([\d\s.,%/-]+\)$/i.test(c)) return c;
  return null;
}

function gradientCss(g: Gradient): string | null {
  const stops = (g.stops ?? []).map((s) => {
    const c = groundColor(typeof s === "string" ? s : s.color);
    if (!c) return null;
    return typeof s === "string" ? c : `${c} ${Math.max(0, Math.min(1, s.at)) * 100}%`;
  });
  if (stops.length < 2 || stops.some((s) => s === null)) return null;
  return g.shape === "radial" ? `radial-gradient(ellipse at center, ${stops.join(", ")})` : `linear-gradient(${g.angle ?? 180}deg, ${stops.join(", ")})`;
}

function vectorSvg(v: NonNullable<Backdrop["vector"]>): string {
  const [w, h] = typeof v.viewBox === "number" ? [v.viewBox, v.viewBox] : v.viewBox;
  const raw = (c: unknown) => {
    const g = groundColor(c);
    // Inside a picture the app's variables don't reach: names fall back to the text's color.
    return g && !g.startsWith("var(") && !g.startsWith("color-mix") ? g : getComputedStyle(document.documentElement).getPropertyValue("--text-300").trim() || "#888";
  };
  const paths = v.paths
    .map((p) => {
      const d = typeof p === "string" ? p : p.d;
      const c = raw(typeof p === "string" ? v.color : (p.color ?? v.color));
      const sw = typeof p === "string" ? undefined : p.strokeWidth;
      const attr = (s: string) => s.replace(/[<>"&]/g, "");
      return sw ? `<path d="${attr(d)}" fill="none" stroke="${attr(c)}" stroke-width="${Number(sw)}"/>` : `<path d="${attr(d)}" fill="${attr(c)}"/>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Number(w)} ${Number(h)}" preserveAspectRatio="xMidYMid slice">${paths}</svg>`;
}

function tiling(t: { size?: [number, number]; repeat?: boolean }): CSSProperties {
  return t.size && t.repeat ? { backgroundSize: `${t.size[0]}px ${t.size[1]}px`, backgroundRepeat: "repeat" } : { backgroundSize: "cover", backgroundPosition: "center", backgroundRepeat: "no-repeat" };
}

/** A still ground's style, drawn with no hook: a color, a gradient, a drawing in paths or a picture. */
function groundStyle(t: StandingTheme): CSSProperties | null {
  const b = t.args.backdrop;
  if (!b) return null;
  if (b.color !== undefined) {
    const c = groundColor(b.color);
    return c ? { background: c } : null;
  }
  if (b.gradient) {
    const g = gradientCss(b.gradient);
    return g ? { backgroundImage: g, ...tiling(b.gradient) } : null;
  }
  if (b.vector) return { backgroundImage: `url("${svgSource(vectorSvg(b.vector))}")`, ...tiling(b.vector) };
  if (b.image?.source && /^[\w./-]+$/.test(b.image.source) && !b.image.source.split("/").includes("..")) {
    const src = convertFileSrc(`${t.root.replace(/[\\/]+$/, "")}/${b.image.source}`);
    return { backgroundImage: `url("${src}")`, ...tiling(b.image) };
  }
  return null;
}

/** The scene a theme's `Backdrop` hook draws, if it asks for one. */
function sceneOf(t: StandingTheme | null): string | null {
  const b = t?.args.backdrop;
  return b ? (b.scene ?? b.id ?? null) : null;
}

/** The Svg a Backdrop hook answered, found anywhere in its tree. */
function sceneSvg(tree: RenderNode | null): { source: string; alt: string } | null {
  if (!tree || !isElement(tree)) return null;
  if (tree.$el === "Svg" && typeof tree.props.source === "string") return { source: tree.props.source, alt: typeof tree.props.alt === "string" ? tree.props.alt : "" };
  for (const c of tree.children) {
    const found = sceneSvg(c);
    if (found) return found;
  }
  return null;
}

/**
 * What a mod's theme draws behind the whole window: a live scene its `Backdrop` hook draws, or a
 * still ground. It sits under everything (the app's root is its own stacking context) and lets
 * every click through; the panels over it are frosted by the `mod-glass` styles. `hidden` takes
 * it off the app's own pages (Scheduled, Plugins…), which a theme doesn't dress.
 */
export function ModBackdrop({ hidden = false }: { hidden?: boolean }) {
  useSyncExternalStore(modHost.subscribe, modHost.getVersion);
  const key = modHost.activeKey;
  const theme = modHost.theme(key);
  const settled = modHost.isSettled(key);
  // Switching sessions used to drop the drawing until the new session's hook answered: a blank
  // frame on every switch. The theme shown now changes only once the session's mods have loaded,
  // and a scene's picture stays until the new one is in (the same scene is the same picture).
  const [shown, setShown] = useState(theme);
  const [svg, setSvg] = useState<{ source: string; alt: string } | null>(null);
  if (settled && theme !== shown) {
    setShown(theme);
    if (!sceneOf(theme)) setSvg(null);
  }

  useEffect(() => {
    if (!settled || !key || !sceneOf(theme)) return;
    let live = true;
    void modHost.renderBackdrop(key).then((tree) => {
      if (!live) return;
      const found = sceneSvg(tree);
      setSvg(found && found.source.length <= 131_072 ? found : null);
    });
    return () => {
      live = false;
    };
  }, [key, theme, settled]);

  // Hidden on the app's own pages, with the scene kept for coming back to the session.
  if (!shown || hidden) return null;
  const scene = sceneOf(shown);
  const ground = scene ? null : groundStyle(shown);
  if (!ground && !(scene && svg)) return null;
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" style={ground ?? undefined}>
      {scene && svg && <img src={svgSource(svg.source)} alt={svg.alt} draggable={false} className="h-full w-full select-none object-cover" />}
    </div>
  );
}
