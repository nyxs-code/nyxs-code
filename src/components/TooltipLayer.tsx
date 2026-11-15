import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface Tip {
  text: string;
  kbd: string | null;
  desc: string | null;
  left: number;
  top: number;
  below: boolean;
  right: boolean;
}

/**
 * `data-tooltip-clipped` shows the tooltip only when the anchor's `[data-tooltip-clip-target]`
 * text is not fully visible, so a title that can be read whole gets no tooltip repeating it.
 * The text counts as cut off when it runs past its box or under a `[data-tooltip-clip-cover]`
 * element (a hover button drawn over the end of the row).
 */
function isClipped(el: HTMLElement): boolean {
  if (!el.hasAttribute("data-tooltip-clipped")) return true;
  const target = (el.querySelector("[data-tooltip-clip-target]") as HTMLElement | null) ?? el;
  // The box is wider than its text when the text fits, so the text's own width comes from a range.
  const range = document.createRange();
  range.selectNodeContents(target);
  const textRight = range.getBoundingClientRect().right;
  let visibleRight = target.getBoundingClientRect().right;
  const cover = el.querySelector("[data-tooltip-clip-cover]") as HTMLElement | null;
  if (cover) visibleRight = Math.min(visibleRight, cover.getBoundingClientRect().left);
  return textRight > visibleRight + 0.5;
}

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const clear = () => {
      anchorRef.current = null;
      setTip(null);
    };
    const show = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.("[data-tooltip]") as HTMLElement | null;
      const text = el?.getAttribute("data-tooltip");
      if (!el || !text) return;
      if (!isClipped(el)) {
        anchorRef.current = null;
        setTip(null);
        return;
      }
      const r = el.getBoundingClientRect();
      const kbd = el.getAttribute("data-tooltip-kbd");
      const desc = el.getAttribute("data-tooltip-desc");
      anchorRef.current = el;
      if (el.getAttribute("data-tooltip-side") === "right") {
        setTip({ text, kbd, desc, left: r.right + 8, top: r.top + r.height / 2, below: false, right: true });
        return;
      }
      const below = r.top < 48;
      setTip({ text, kbd, desc, left: r.left + r.width / 2, top: below ? r.bottom + 8 : r.top - 8, below, right: false });
    };
    const hide = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.("[data-tooltip]")) clear();
    };

    document.addEventListener("mouseover", show);
    document.addEventListener("mouseout", hide);
    document.addEventListener("mousedown", clear);
    window.addEventListener("scroll", clear, true);
    window.addEventListener("blur", clear);
    return () => {
      document.removeEventListener("mouseover", show);
      document.removeEventListener("mouseout", hide);
      document.removeEventListener("mousedown", clear);
      window.removeEventListener("scroll", clear, true);
      window.removeEventListener("blur", clear);
    };
  }, []);

  useEffect(() => {
    if (!tip) return;
    const id = window.setInterval(() => {
      if (anchorRef.current && !anchorRef.current.isConnected) {
        anchorRef.current = null;
        setTip(null);
      }
    }, 200);
    return () => window.clearInterval(id);
  }, [tip]);

  // Kept inside the window: measured once drawn, at its full width, then shifted off the edge.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!tip || !box) return;
    const half = box.offsetWidth / 2;
    const left = tip.right
      ? Math.max(4, Math.min(tip.left, window.innerWidth - box.offsetWidth - 4))
      : Math.min(Math.max(tip.left, half + 4), window.innerWidth - half - 4);
    if (Math.abs(left - tip.left) > 0.5) setTip({ ...tip, left });
  }, [tip]);

  if (!tip) return null;
  // `data-webview-hole`: the browser panel's native webview draws over the whole app, so a
  // tooltip reaching over the page would be hidden behind it; the page cuts a hole for it.
  return createPortal(
    <div
      ref={boxRef}
      role="tooltip"
      data-webview-hole
      className={
        tip.desc
          ? "app-tooltip pointer-events-none fixed z-[9999] w-max max-w-[240px] px-2.5 py-1.5 leading-snug shadow-xl text-left"
          : "app-tooltip pointer-events-none fixed z-[9999] w-max max-w-[280px] px-2 py-1 text-[11px] leading-snug shadow-xl text-center"
      }
      style={{
        left: tip.left,
        top: tip.top,
        transform: tip.right ? "translate(0, -50%)" : tip.below ? "translate(-50%, 0)" : "translate(-50%, -100%)",
        overflowWrap: "anywhere",
      }}
    >
      {tip.desc ? (
        <>
          <span className="block text-[12px] font-semibold">{tip.text}</span>
          <span className="block text-[11px] app-tooltip-muted">{tip.desc}</span>
        </>
      ) : tip.kbd ? (
        <span className="inline-flex items-center gap-2 whitespace-nowrap">
          <span className="font-semibold">{tip.text}</span>
          <span className="app-tooltip-muted">{tip.kbd}</span>
        </span>
      ) : (
        tip.text
      )}
    </div>,
    document.body,
  );
}

export default TooltipLayer;
