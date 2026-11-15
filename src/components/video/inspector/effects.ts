import type { Effect, EffectKind } from "@/lib/video/timelineSchema";

/** A new effect with a value that visibly does something. */
export function defaultEffect(kind: EffectKind): Effect {
  switch (kind) {
    case "blur":
      return { kind, amount: 6 };
    case "brightness":
    case "contrast":
    case "saturate":
      return { kind, amount: 1.2 };
    case "grayscale":
    case "sepia":
    case "invert":
      return { kind, amount: 1 };
    case "hue-rotate":
      return { kind, degrees: 90 };
    case "drop-shadow":
      return { kind, x: 0, y: 8, blur: 24, color: "rgba(0,0,0,0.5)" };
    case "chroma-key":
      return { kind, color: "#00ff00", tolerance: 0.3 };
    case "vignette":
      return { kind, amount: 0.5 };
  }
}
