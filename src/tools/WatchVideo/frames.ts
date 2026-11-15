export const DEFAULT_FRAMES = 8;
export const MAX_FRAMES = 24;

/** The longest side of a frame. Enough to read on-screen text in a recording, at about the
 *  tokens of a small screenshot each. */
const FRAME_MAX_SIDE = 1024;
const FRAME_QUALITY = 0.8;
const LOAD_TIMEOUT_MS = 20_000;
const SEEK_TIMEOUT_MS = 10_000;

export interface VideoFrame {
  /** Seconds from the start of the video. */
  time: number;
  /** JPEG, base64 without the data URL prefix. */
  data: string;
}

export interface VideoFrames {
  duration: number;
  width: number;
  height: number;
  frames: VideoFrame[];
}

export interface VideoProbe {
  duration: number;
  width: number;
  height: number;
}

/** `count` moments spread evenly over [start, end], each in the middle of its slice: the first
 *  and last frames of a clip are often black or a fade. A single frame is the middle one. */
export function frameTimes(duration: number, count: number, start = 0, end = duration): number[] {
  const from = Math.max(0, Math.min(start, duration));
  const to = Math.max(from, Math.min(end, duration));
  const n = Math.max(1, Math.min(MAX_FRAMES, Math.round(count)));
  const span = to - from;
  if (span <= 0) return [from];
  const step = span / n;
  return Array.from({ length: n }, (_, i) => Math.round((from + step * (i + 0.5)) * 1000) / 1000);
}

/** `83.4` → `1:23.4`; hours when the video has them. */
export function formatTimestamp(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = (s % 60).toFixed(1).padStart(4, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
}

function once(video: HTMLVideoElement, event: string, timeoutMs: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      video.removeEventListener(event, ok);
      video.removeEventListener("error", fail);
    };
    const ok = () => {
      done();
      resolve();
    };
    const fail = () => {
      done();
      reject(new Error(decodeError(video)));
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error(`timed out ${what}`));
    }, timeoutMs);
    video.addEventListener(event, ok);
    video.addEventListener("error", fail);
  });
}

function decodeError(video: HTMLVideoElement): string {
  const code = video.error?.code;
  // MEDIA_ERR_DECODE (3) and MEDIA_ERR_SRC_NOT_SUPPORTED (4): the WebView has no decoder for it.
  if (code === 3 || code === 4) {
    return "this video's format or codec can't be decoded here. Convert it to H.264 MP4 (for example `ffmpeg -i in.ext -c:v libx264 -an out.mp4`) and watch that";
  }
  return video.error?.message || "the video couldn't be opened";
}

async function openVideo(src: string): Promise<HTMLVideoElement> {
  if (typeof document === "undefined") throw new Error("videos can only be watched in the Nyxs window");
  const video = document.createElement("video");
  // The asset protocol answers with the app's origin, so frames drawn from it don't taint the canvas.
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  const loaded = once(video, "loadeddata", LOAD_TIMEOUT_MS, "opening the video");
  video.src = src;
  await loaded;
  if (!Number.isFinite(video.duration)) {
    // Recordings without a duration in their header (MediaRecorder WebM) report Infinity until
    // the end has been seen.
    const seeked = once(video, "durationchange", SEEK_TIMEOUT_MS, "measuring the video");
    video.currentTime = 1e9;
    await seeked.catch(() => undefined);
  }
  return video;
}

function closeVideo(video: HTMLVideoElement): void {
  video.removeAttribute("src");
  video.load();
}

function probeOf(video: HTMLVideoElement): VideoProbe {
  return {
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    width: video.videoWidth,
    height: video.videoHeight,
  };
}

/** The video's length and size, for a model that is sent the whole file. */
export async function probeVideo(src: string): Promise<VideoProbe> {
  const video = await openVideo(src);
  try {
    return probeOf(video);
  } finally {
    closeVideo(video);
  }
}

async function seek(video: HTMLVideoElement, time: number): Promise<void> {
  if (Math.abs(video.currentTime - time) < 0.001 && video.readyState >= 2) return;
  const seeked = once(video, "seeked", SEEK_TIMEOUT_MS, `seeking to ${formatTimestamp(time)}`);
  video.currentTime = time;
  await seeked;
}

/** Frames of the video at `src` (an asset URL), taken in the WebView: it decodes what Edge or
 *  WebKit can play (H.264/HEVC MP4, WebM, ...), so no ffmpeg is needed. */
export async function extractFrames(src: string, opts: { count: number; start?: number; end?: number }): Promise<VideoFrames> {
  const video = await openVideo(src);
  try {
    const probe = probeOf(video);
    if (!probe.width || !probe.height) throw new Error("the file has no video track");
    const times = frameTimes(probe.duration, opts.count, opts.start ?? 0, opts.end ?? probe.duration);
    const scale = Math.min(1, FRAME_MAX_SIDE / Math.max(probe.width, probe.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(probe.width * scale));
    canvas.height = Math.max(1, Math.round(probe.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("couldn't draw the frames");
    const frames: VideoFrame[] = [];
    for (const time of times) {
      // The last instant of a video often has no frame to show; step back a little from the end.
      await seek(video, probe.duration > 0 ? Math.min(time, Math.max(0, probe.duration - 0.05)) : time);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL("image/jpeg", FRAME_QUALITY);
      frames.push({ time, data: url.slice(url.indexOf(",") + 1) });
    }
    return { ...probe, frames };
  } finally {
    closeVideo(video);
  }
}
