import { useLayoutEffect, useState, type RefObject } from "react";

/** Space kept between a menu and the window's edge. */
const MARGIN = 4;

/**
 * Where a menu opened from a button goes so it stays in the window: at `below` (just under the
 * button) when it fits, else ending at `above` (just over it), as for the last rows of a list.
 * Measured before the menu paints, so it never shows cut off first. Null while `below` is null
 * (the menu is closed).
 */
export function useMenuTop(ref: RefObject<HTMLElement | null>, below: number | null, above: number): number | null {
  const [fit, setFit] = useState<{ below: number; above: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (below == null) return;
    const height = ref.current?.getBoundingClientRect().height ?? 0;
    const top = below + height <= window.innerHeight - MARGIN ? below : Math.max(MARGIN, above - height);
    setFit((f) => (f && f.below === below && f.above === above && f.top === top ? f : { below, above, top }));
  }, [ref, below, above]);
  if (below == null) return null;
  return fit && fit.below === below && fit.above === above ? fit.top : below;
}
