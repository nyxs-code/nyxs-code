import React from "react";
import { loadFont } from "@remotion/google-fonts/Inter";
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

// Loads only the faces this scene uses; delayRender waits for them in renders.
const { fontFamily } = loadFont("normal", { weights: ["800"], subsets: ["latin"] });

export type LogoRevealProps = {
  /** Wordmark shown next to the mark. */
  text?: string;
  /** Optional logo image in public/, e.g. "media/logo.png". Without it a geometric mark is drawn. */
  logo?: string;
  color?: string;
  background?: string;
};

/** Expanding rings, then the mark pops in with a spring and the wordmark slides out from behind it. */
export const LogoReveal: React.FC<LogoRevealProps> = ({
  text = "nyxs",
  logo,
  color = "#FFFFFF",
  background = "#05050A",
}) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const unit = width / 1920;
  const pop = spring({ frame: frame - 10, fps, config: { damping: 10, stiffness: 120, mass: 0.8 } });
  const slide = spring({ frame: frame - 28, fps, config: { damping: 200 } });
  const markSize = 180 * unit;

  return (
    <AbsoluteFill style={{ background, alignItems: "center", justifyContent: "center", fontFamily: `${fontFamily}, system-ui, sans-serif` }}>
      {[0, 1, 2].map((i) => {
        const p = interpolate(frame - i * 6, [0, 40], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              width: markSize * (1 + p * 4),
              height: markSize * (1 + p * 4),
              borderRadius: "50%",
              border: `${2 * unit}px solid ${color}`,
              opacity: (1 - p) * 0.35,
            }}
          />
        );
      })}
      <div style={{ display: "flex", alignItems: "center", gap: 40 * unit * slide }}>
        <div style={{ width: markSize, height: markSize, transform: `scale(${pop}) rotate(${(1 - pop) * -90}deg)` }}>
          {logo ? (
            <Img src={staticFile(logo)} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
          ) : (
            <svg viewBox="0 0 100 100" width="100%" height="100%">
              <circle cx="50" cy="50" r="46" fill="none" stroke={color} strokeWidth="6" />
              <path d="M30 70 V30 L70 70 V30" fill="none" stroke={color} strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>
        <div style={{ overflow: "hidden", maxWidth: 900 * unit * slide }}>
          <div
            style={{
              color,
              fontSize: 150 * unit,
              fontWeight: 800,
              letterSpacing: -4 * unit,
              whiteSpace: "nowrap",
              transform: `translateX(${(1 - slide) * -100}%)`,
            }}
          >
            {text}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
