import React from "react";
import { loadFont } from "@remotion/google-fonts/Inter";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

// Loads only the faces this scene uses; delayRender waits for them in renders.
const { fontFamily } = loadFont("normal", { weights: ["500", "700"], subsets: ["latin"] });

export type LowerThirdProps = {
  name?: string;
  role?: string;
  accent?: string;
  /** "left" or "right" side of the frame. */
  side?: "left" | "right";
};

/** Name + role strap in the lower third, with a reveal mask in and a slide out. */
export const LowerThird: React.FC<LowerThirdProps> = ({
  name = "Alex Rivera",
  role = "Head of Product",
  accent = "#22C55E",
  side = "left",
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const unit = width / 1920;
  const enter = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 20 });
  const textIn = spring({ frame: frame - 8, fps, config: { damping: 200 }, durationInFrames: 20 });
  const leave = interpolate(frame, [durationInFrames - 14, durationInFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const dir = side === "left" ? -1 : 1;

  return (
    <AbsoluteFill style={{ fontFamily: `${fontFamily}, system-ui, sans-serif` }}>
      <div
        style={{
          position: "absolute",
          bottom: height * 0.12,
          [side]: width * 0.06,
          display: "flex",
          alignItems: "stretch",
          flexDirection: side === "left" ? "row" : "row-reverse",
          transform: `translateX(${dir * leave * 120 * unit}px)`,
          opacity: 1 - leave,
        }}
      >
        <div style={{ width: 10 * unit, background: accent, transform: `scaleY(${enter})`, transformOrigin: "bottom" }} />
        <div
          style={{
            background: "rgba(10, 10, 14, 0.82)",
            padding: `${22 * unit}px ${34 * unit}px`,
            clipPath: `inset(0 ${side === "left" ? (1 - enter) * 100 : 0}% 0 ${side === "right" ? (1 - enter) * 100 : 0}%)`,
            textAlign: side,
          }}
        >
          <div
            style={{
              color: "#FFFFFF",
              fontSize: 54 * unit,
              fontWeight: 700,
              opacity: textIn,
              transform: `translateY(${(1 - textIn) * 16 * unit}px)`,
            }}
          >
            {name}
          </div>
          <div
            style={{
              color: accent,
              fontSize: 30 * unit,
              fontWeight: 500,
              marginTop: 6 * unit,
              textTransform: "uppercase",
              letterSpacing: 3 * unit,
              opacity: textIn,
            }}
          >
            {role}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
