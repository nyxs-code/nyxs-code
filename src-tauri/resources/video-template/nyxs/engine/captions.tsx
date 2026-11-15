import React, { useMemo } from "react";
import { createTikTokStyleCaptions } from "@remotion/captions";
import type { Caption as RemotionCaption, TikTokPage } from "@remotion/captions";
import type { CaptionsClip } from "./schema";
import { textStyleCss } from "./text";

const DEFAULT_HIGHLIGHT = "#FFD60A";

/**
 * Word-level captions (one word per caption, as transcription returns them) are joined into
 * pages. TikTok-style tokens expect a leading space before every word but the first.
 */
function toPages(clip: CaptionsClip): TikTokPage[] {
  const captions: RemotionCaption[] = [...clip.captions]
    .sort((a, b) => a.startMs - b.startMs)
    .map((c, i) => ({
      text: i === 0 || /^\s/.test(c.text) ? c.text : ` ${c.text}`,
      startMs: c.startMs,
      endMs: c.endMs,
      timestampMs: c.timestampMs ?? null,
      confidence: c.confidence ?? null,
    }));
  const combine = clip.mode === "line" ? 2400 : 1200;
  return createTikTokStyleCaptions({ captions, combineTokensWithinMilliseconds: combine }).pages;
}

export const CaptionsContent: React.FC<{ clip: CaptionsClip; frame: number; fps: number }> = ({ clip, frame, fps }) => {
  const pages = useMemo(() => toPages(clip), [clip]);
  const ms = (frame / fps) * 1000;
  const page = pages.find((p) => ms >= p.startMs && ms < p.startMs + p.durationMs);
  const highlight = clip.highlightColor ?? DEFAULT_HIGHLIGHT;
  const base = textStyleCss(clip.style);

  // Keep the box in place between pages so the clip stays selectable on the canvas.
  if (!page) return <div style={{ ...base, width: "100%", visibility: "hidden" }}>&nbsp;</div>;

  if (clip.mode === "line") {
    return <div style={{ ...base, width: "100%" }}>{page.text.trim()}</div>;
  }

  return (
    <div style={{ ...base, width: "100%" }}>
      {page.tokens.map((token, i) => {
        const text = i === 0 ? token.text.trimStart() : token.text;
        const active = ms >= token.fromMs && ms < token.toMs;
        if (clip.mode === "word-highlight") {
          return (
            <span key={i} style={{ color: active ? highlight : undefined, whiteSpace: "pre" }}>
              {text}
            </span>
          );
        }
        // Karaoke: words already sung are filled, the current one fills left to right. A clipped
        // copy on top (instead of background-clip: text) keeps text strokes intact.
        const p = ms >= token.toMs ? 1 : ms <= token.fromMs ? 0 : (ms - token.fromMs) / Math.max(1, token.toMs - token.fromMs);
        const rest = Math.round((1 - p) * 1000) / 10;
        return (
          <span key={i} style={{ position: "relative", whiteSpace: "pre" }}>
            {text}
            {p > 0 ? (
              <span
                aria-hidden
                style={{ position: "absolute", left: 0, top: 0, color: highlight, clipPath: `inset(-20% ${rest}% -20% 0)` }}
              >
                {text}
              </span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
};
