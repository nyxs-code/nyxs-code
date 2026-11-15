import type { CardScene } from "@/lib/updateCard";

/** How long a mascot step shows, a typed character takes, a reaction holds and a terminal line waits. */
export const STEP_MS = 1800;
export const TYPE_MS = 45;
export const REACT_HOLD_MS = 1500;
export const LINE_MS = 450;

/** How long a slide stays before the next, by what its scene has to play. */
export function sceneDuration(scene: CardScene): number {
  switch (scene.kind) {
    case "mascot":
      return scene.steps.some((s) => s.pose === "intro") ? 6800 : scene.steps.length * STEP_MS + 600;
    case "reactions":
      return scene.steps.reduce((ms, s) => ms + [...s.text["en-US"]].length * TYPE_MS + REACT_HOLD_MS + 300, 400);
    case "terminal":
      return scene.lines.length * LINE_MS + 3200;
    default:
      return 5200;
  }
}
