import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/** The classic terminal spinner (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏) drawn as dots, so it reads the same on every
 *  system and takes the text color. Dots that go out fade over TRAIL_MS instead of vanishing,
 *  leaving a short wake behind the turn. */
const FRAMES = [..."⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"].map((c) => (c.codePointAt(0) ?? 0x2800) - 0x2800);
/** Braille bits by cell position, row by row (left, right): dots 1/4, 2/5, 3/6. */
const BITS = [0x01, 0x08, 0x02, 0x10, 0x04, 0x20];
const STEP_MS = 80;
const TRAIL_MS = 260;
const REST = 0.12;

export function BrailleSpinner({ className, label }: { className?: string; label?: string }) {
  const dotsRef = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    const dots = dotsRef.current;
    const litAt = BITS.map(() => -Infinity);
    const paint = (now: number) => {
      const bits = FRAMES[Math.floor(now / STEP_MS) % FRAMES.length];
      BITS.forEach((bit, i) => {
        const el = dots[i];
        if (!el) return;
        if (bits & bit) {
          litAt[i] = now;
          el.style.opacity = "1";
          return;
        }
        const age = now - litAt[i];
        el.style.opacity = String(age < TRAIL_MS ? Math.max(REST, 0.7 * (1 - age / TRAIL_MS)) : REST);
      });
    };
    // With reduced motion it holds its first frame.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      paint(0);
      return;
    }
    let raf = requestAnimationFrame(function frame(now) {
      paint(now);
      raf = requestAnimationFrame(frame);
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("inline-grid grid-cols-2 gap-[1.5px]", className)}
    >
      {BITS.map((bit, i) => (
        <span
          key={bit}
          ref={(el) => {
            dotsRef.current[i] = el;
          }}
          className="block h-[3px] w-[3px] rounded-full bg-current"
          style={{ opacity: REST }}
        />
      ))}
    </span>
  );
}

export default BrailleSpinner;
