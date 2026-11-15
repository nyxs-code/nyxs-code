import { convertFileSrc } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";
import { formatFileSize } from "@/lib/fileAttachments";
import { invoke } from "@/lib/ipc";
import { NATIVE_VIDEO_MAX_BYTES, nativeVideoRejected, videoMarker } from "@/lib/toolMedia";
import type { ToolContext } from "@/tools/context";
import { VIDEO_EXT_RE } from "./format";
import { DEFAULT_FRAMES, MAX_FRAMES, extractFrames, formatTimestamp, probeVideo, type VideoFrame, type VideoProbe } from "./frames";
import { getWatchVideoDescription } from "./prompt";

interface VideoSource {
  localPath: string;
  size: number;
  mediaType: string;
}

export type WatchVideoOutput =
  | { kind: "whole"; filePath: string; path: string; mediaType: string; size: number; probe: VideoProbe | null }
  | { kind: "frames"; filePath: string; size: number; probe: VideoProbe; frames: VideoFrame[]; note?: string }
  | { kind: "error"; message: string };

function describe(filePath: string, size: number, probe: VideoProbe | null): string {
  const facts = [formatFileSize(size)];
  if (probe?.duration) facts.unshift(formatTimestamp(probe.duration));
  if (probe?.width && probe.height) facts.splice(1, 0, `${probe.width}×${probe.height}`);
  return `${filePath} (${facts.join(", ")})`;
}

export function watchVideoModelOutput(o: WatchVideoOutput, nativeToolImages: boolean) {
  if (o.kind === "error") return { type: "error-text" as const, value: o.message };
  if (o.kind === "whole") {
    // Endpoints sample a video at their own rate (one served by vLLM may take only a few frames),
    // so exact moments are worth checking against frames.
    return {
      type: "text" as const,
      value: `Watching the whole video ${describe(o.filePath, o.size, o.probe)}. ${videoMarker(o.path, o.mediaType)}\n[How densely the video is sampled is up to the model's endpoint. If the answer depends on every scene or exact moments, check them with mode "frames" (and start/end).]`,
    };
  }
  const list = o.frames.map((f, i) => `${i + 1} at ${formatTimestamp(f.time)}`).join(", ");
  const head = [
    `Video ${describe(o.filePath, o.size, o.probe)}: ${o.frames.length} frame${o.frames.length === 1 ? "" : "s"}, attached below in order (${list}).`,
    o.note,
  ]
    .filter(Boolean)
    .join("\n");
  const images = o.frames.map((f, i) =>
    nativeToolImages
      ? { type: "image-data" as const, data: f.data, mediaType: "image/jpeg" }
      : { type: "file-data" as const, data: f.data, mediaType: "image/jpeg", filename: `frame-${i + 1}.jpg` },
  );
  return { type: "content" as const, value: [{ type: "text" as const, text: head }, ...images] };
}

export function createWatchVideoTool(ctx: ToolContext) {
  const { allowImages, nativeToolImages, nativeVideo, scope, resolveRead, gateRead, workspace } = ctx;
  return tool({
    description: getWatchVideoDescription(),
    inputSchema: z.object({
      file_path: z.string().describe("Path of the video file (absolute or relative to the workspace)."),
      mode: z
        .enum(["auto", "frames"])
        .optional()
        .describe('"auto" (default): the whole video when the model takes video, frames otherwise. "frames": always frames.'),
      frames: z.number().int().min(1).max(MAX_FRAMES).optional().describe(`How many frames to take (default ${DEFAULT_FRAMES}).`),
      start: z.number().min(0).optional().describe("Take frames from this second on."),
      end: z.number().min(0).optional().describe("Take frames up to this second."),
    }),
    execute: async ({ file_path, mode, frames, start, end }): Promise<WatchVideoOutput> => {
      const abs = resolveRead(file_path);
      const denied = await gateRead(file_path, abs);
      if (denied) return { kind: "error", message: denied };
      if (!VIDEO_EXT_RE.test(abs)) {
        return { kind: "error", message: `${file_path} isn't a video file this tool opens (mp4, mov, webm, mkv, avi, ogv, 3gp, mpeg, wmv, flv).` };
      }
      if (start !== undefined && end !== undefined && end < start) {
        return { kind: "error", message: `end (${end}) is before start (${start}).` };
      }
      const native = !!nativeVideo && !nativeVideoRejected.has(nativeVideo);
      if (!allowImages && !native) {
        return { kind: "error", message: `${file_path} is a video. The current model can't see images or video; switch to a vision-capable model, or ask the user to describe it.` };
      }
      let source: VideoSource;
      try {
        source = await invoke<VideoSource>("agent_prepare_video", { path: abs, scope, workspace: workspace || null });
      } catch (e) {
        return { kind: "error", message: `Failed to open video ${file_path}: ${e instanceof Error ? e.message : String(e)}` };
      }
      const src = convertFileSrc(source.localPath);
      const wantsFrames = mode === "frames" || frames !== undefined || start !== undefined || end !== undefined;
      const fits = source.size <= NATIVE_VIDEO_MAX_BYTES;
      if (native && !wantsFrames && fits) {
        const probe = await probeVideo(src).catch(() => null);
        return { kind: "whole", filePath: file_path, path: abs, mediaType: source.mediaType, size: source.size, probe };
      }
      if (!allowImages) {
        return {
          kind: "error",
          message: `${file_path} is ${formatFileSize(source.size)}, over the ${formatFileSize(NATIVE_VIDEO_MAX_BYTES)} this model can be sent whole, and it can't see frames. Cut a shorter clip with ffmpeg through Bash and watch that.`,
        };
      }
      const note =
        native && !wantsFrames && !fits
          ? `[The video is over the ${formatFileSize(NATIVE_VIDEO_MAX_BYTES)} a model can be sent whole, so these are frames. To watch a part with motion and sound, cut it with ffmpeg and watch the clip.]`
          : undefined;
      try {
        const out = await extractFrames(src, { count: frames ?? DEFAULT_FRAMES, start, end });
        const { frames: taken, ...probe } = out;
        return { kind: "frames", filePath: file_path, size: source.size, probe, frames: taken, note };
      } catch (e) {
        return { kind: "error", message: `Failed to watch video ${file_path}: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
    toModelOutput: ({ output }) => watchVideoModelOutput(output, nativeToolImages),
  });
}
