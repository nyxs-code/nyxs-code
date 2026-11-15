import React from "react";
import { loadFont } from "@remotion/google-fonts/Inter";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

// Loads only the faces this scene uses; delayRender waits for them in renders.
const { fontFamily } = loadFont("normal", { weights: ["400", "800"], subsets: ["latin"] });

export type TitleCardProps = {
  title?: string;
  subtitle?: string;
  accent?: string;
  background?: string;
  color?: string;
};

/** Full-frame title: an accent bar sweeps in, the title rises word by word, the subtitle fades up. */
export const TitleCard: React.FC<TitleCardProps> = ({
  title = "Your title here",
  subtitle = "A short subtitle",
  accent = "#7C5CFF",
  background = "#0B0B12",
  color = "#FFFFFF",
}) => {
  const frame = useCurrentFrame();
  const { fps, width, durationInFrames } = useVideoConfig();
  const unit = width / 1920;
  const bar = spring({ frame, fps, config: { damping: 200 } });
  const words = title.split(" ");
  const subtitleIn = interpolate(frame, [words.length * 4 + 10, words.length * 4 + 30], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const exit = interpolate(frame, [durationInFrames - 15, durationInFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(circle at 30% 20%, ${accent}33, transparent 55%), ${background}`,
        alignItems: "center",
        justifyContent: "center",
        opacity: exit,
        fontFamily: `${fontFamily}, system-ui, sans-serif`,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 28 * unit }}>
        <div style={{ height: 8 * unit, width: 240 * unit * bar, background: accent, borderRadius: 4 * unit }} />
        <div style={{ display: "flex", gap: 22 * unit, flexWrap: "wrap", justifyContent: "center", maxWidth: 1500 * unit }}>
          {words.map((word, i) => {
            const p = spring({ frame: frame - 6 - i * 4, fps, config: { damping: 14, stiffness: 120 } });
            return (
              <span
                key={i}
                style={{
                  color,
                  fontSize: 120 * unit,
                  fontWeight: 800,
                  letterSpacing: -2 * unit,
                  display: "inline-block",
                  opacity: Math.min(1, p),
                  transform: `translateY(${(1 - p) * 60 * unit}px)`,
                }}
              >
                {word}
              </span>
            );
          })}
        </div>
        <div
          style={{
            color,
            opacity: subtitleIn * 0.75,
            fontSize: 44 * unit,
            fontWeight: 400,
            transform: `translateY(${(1 - subtitleIn) * 20 * unit}px)`,
          }}
        >
          {subtitle}
        </div>
      </div>
    </AbsoluteFill>
  );
};
