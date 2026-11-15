import React from "react";
import { AbsoluteFill } from "remotion";
import type { TransitionPresentation, TransitionPresentationComponentProps } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { wipe } from "@remotion/transitions/wipe";
import { flip } from "@remotion/transitions/flip";
import { clockWipe } from "@remotion/transitions/clock-wipe";
import { applyEasing } from "./schema";
import type { Transition } from "./schema";

type AnyPresentation = TransitionPresentation<Record<string, unknown>>;

// Own iris instead of @remotion/transitions/iris, which only exists in newer Remotion releases
// (adopted projects may be older): the entering clip grows from a circle in the center.
const IrisPresentation: React.FC<TransitionPresentationComponentProps<{ width: number; height: number }>> = ({
  children,
  presentationDirection,
  presentationProgress,
  passedProps,
}) => {
  if (presentationDirection === "exiting") return <AbsoluteFill>{children}</AbsoluteFill>;
  const radius = Math.hypot(passedProps.width, passedProps.height) / 2;
  const r = presentationProgress >= 1 ? radius * 1.01 : radius * presentationProgress;
  return <AbsoluteFill style={{ clipPath: `circle(${r}px at 50% 50%)` }}>{children}</AbsoluteFill>;
};

const iris = (props: { width: number; height: number }) => ({ component: IrisPresentation, props });

function presentationFor(t: Transition, width: number, height: number): AnyPresentation | null {
  const direction = t.direction;
  switch (t.kind) {
    case "fade":
      return fade() as unknown as AnyPresentation;
    case "slide":
      return slide(direction ? { direction } : {}) as unknown as AnyPresentation;
    case "wipe":
      return wipe(direction ? { direction } : {}) as unknown as AnyPresentation;
    case "flip":
      return flip(direction ? { direction } : {}) as unknown as AnyPresentation;
    case "clock-wipe":
      return clockWipe({ width, height }) as unknown as AnyPresentation;
    case "iris":
      return iris({ width, height }) as unknown as AnyPresentation;
    default:
      return null;
  }
}

const noop = () => undefined;

/** True when the transition actually animates something. */
export function isActiveTransition(t: Transition | undefined): t is Transition {
  return !!t && t.kind !== "none" && t.durationInFrames > 0;
}

/**
 * Wraps a clip in a @remotion/transitions presentation, driven by our own frame math so clips
 * keep their absolute `from`. It is always rendered (also at progress 0/1, where presentations
 * are the identity) so the subtree never remounts when the transition starts or ends.
 */
export const TransitionWrap: React.FC<{
  transition: Transition;
  direction: "entering" | "exiting";
  /** Frames since the transition started (may be negative or past the end). */
  frame: number;
  width: number;
  height: number;
  children: React.ReactNode;
}> = ({ transition, direction, frame, width, height, children }) => {
  const presentation = presentationFor(transition, width, height);
  if (!presentation) return <>{children}</>;
  const linear = Math.min(1, Math.max(0, frame / transition.durationInFrames));
  const progress = applyEasing("ease-in-out", linear);
  const Component = presentation.component as React.ComponentType<TransitionPresentationComponentProps<Record<string, unknown>>>;
  return (
    <Component
      presentationProgress={progress}
      presentationDirection={direction}
      passedProps={presentation.props}
      presentationDurationInFrames={transition.durationInFrames}
      onElementImage={noop}
      onUnmount={noop}
      bothEnteringAndExiting={false}
    >
      {children}
    </Component>
  );
};
