import React from "react";
import { loadFont } from "@remotion/google-fonts/Inter";
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from "remotion";

const { fontFamily } = loadFont("normal", { weights: ["800"], subsets: ["latin"] });

/** A project-local scene (examples/demo/scenes/): a pill badge that pops in at the top right. */
export const Badge: React.FC<{ label?: string; color?: string }> = ({ label = "NEW", color = "#22C55E" }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const unit = width / 1920;
  const pop = spring({ frame, fps, config: { damping: 12 } });
  return (
    <AbsoluteFill style={{ alignItems: "flex-end", padding: 60 * unit }}>
      <div
        style={{
          background: color,
          color: "#06140B",
          fontFamily: `${fontFamily}, system-ui, sans-serif`,
          fontWeight: 800,
          fontSize: 40 * unit,
          letterSpacing: 2 * unit,
          padding: `${12 * unit}px ${28 * unit}px`,
          borderRadius: 999,
          transform: `scale(${pop})`,
          transformOrigin: "right center",
        }}
      >
        {label}
      </div>
    </AbsoluteFill>
  );
};
