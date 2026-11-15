import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { AUTH_BASE, getToken } from "@/lib/auth";
import { invoke } from "@/lib/ipc";
import { encodeWavBase64, isSilenceHallucination } from "@/lib/transcribe";
import {
  newId,
  validateTimeline,
  type AudioClip,
  type Caption,
  type CaptionsClip,
  type Composition,
  type TextStyle,
  type Timeline,
  type Track,
  type VideoClip,
} from "./timelineSchema";
import { extractAudio, readTimeline, writeTimeline } from "./videoApi";

/** Auto captions for a video/audio clip, shared by the panel's "Generate captions" button and
 *  the agent's VideoCaptions tool. `/api/transcribe` (Whisper over Riva) returns only text, so
 *  word times are estimated over the voiced parts of short chunks unless the backend sends
 *  `words` with times. */

export const SAMPLE_RATE = 16000;
/** Chunks stay short so the estimated word times can't drift far, and well under the
 *  backend's ~95 s request limit. */
export const MAX_CHUNK_SECONDS = 25;
export const MIN_CHUNK_SECONDS = 8;
const FRAME_MS = 30;
const MIN_SPEECH_RMS = 0.012;
const NOISE_FLOOR_FACTOR = 3;

export interface WordTiming {
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
}

export type CaptionsMode = CaptionsClip["mode"];

export interface CaptionsResult {
  clip: CaptionsClip;
  words: number;
  /** "backend": the transcription gave word times; "estimated": spread over the speech. */
  timing: "backend" | "estimated";
}

export class CaptionsError extends Error {
  reason: "not-found" | "no-audio" | "not-signed-in" | "empty" | "failed";
  constructor(reason: CaptionsError["reason"], message: string) {
    super(message);
    this.name = "CaptionsError";
    this.reason = reason;
  }
}

/** Mono PCM samples from a WAV file (8/16/24/32-bit integer or 32-bit float; channels mixed). */
export function decodeWav(buffer: ArrayBuffer): { samples: Float32Array; sampleRate: number } {
  const view = new DataView(buffer);
  const tag = (off: number) => String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
  if (buffer.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");
  let off = 12;
  let format = 1;
  let channels = 1;
  let sampleRate = SAMPLE_RATE;
  let bits = 16;
  while (off + 8 <= buffer.byteLength) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE keeps the real format in the sub-format GUID's first two bytes.
      if (format === 0xfffe && size >= 26) format = view.getUint16(body + 24, true);
    } else if (id === "data") {
      const bytesPer = bits / 8;
      const end = Math.min(buffer.byteLength, body + size);
      const frames = Math.floor((end - body) / (bytesPer * channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let ch = 0; ch < channels; ch++) {
          const p = body + (i * channels + ch) * bytesPer;
          if (format === 3 && bits === 32) sum += view.getFloat32(p, true);
          else if (bits === 16) sum += view.getInt16(p, true) / 0x8000;
          else if (bits === 8) sum += (view.getUint8(p) - 128) / 128;
          else if (bits === 24) sum += ((view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getInt8(p + 2) << 16)) / 0x800000);
          else if (bits === 32) sum += view.getInt32(p, true) / 0x80000000;
        }
        out[i] = sum / channels;
      }
      return { samples: out, sampleRate };
    }
    off = body + size + (size % 2);
  }
  throw new Error("WAV file has no audio data");
}

function frameRms(samples: Float32Array, sampleRate: number): number[] {
  const frame = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  const rms: number[] = [];
  for (let start = 0; start < samples.length; start += frame) {
    const end = Math.min(samples.length, start + frame);
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    rms.push(Math.sqrt(sum / Math.max(1, end - start)));
  }
  return rms;
}

function speechThreshold(rms: number[]): number {
  if (rms.length === 0) return MIN_SPEECH_RMS;
  const sorted = [...rms].sort((a, b) => a - b);
  const floor = sorted[Math.floor(rms.length * 0.2)];
  // Mostly-speech audio puts the "floor" on speech itself; never ask for more than a third of
  // the loud level, or nothing would count as voiced.
  const loud = sorted[Math.floor(rms.length * 0.95)];
  return Math.max(MIN_SPEECH_RMS, Math.min(floor * NOISE_FLOOR_FACTOR, loud * 0.33));
}

/** Splits audio into chunks of at most `maxSeconds`, cutting at the quietest moment between
 *  `minSeconds` and `maxSeconds` so a cut rarely lands inside a word. Ranges are sample indexes. */
export function planChunks(
  samples: Float32Array,
  sampleRate: number,
  { maxSeconds = MAX_CHUNK_SECONDS, minSeconds = MIN_CHUNK_SECONDS } = {},
): { start: number; end: number }[] {
  const total = samples.length;
  const maxLen = Math.round(maxSeconds * sampleRate);
  if (total <= maxLen) return total > 0 ? [{ start: 0, end: total }] : [];
  const frame = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  const rms = frameRms(samples, sampleRate);
  const chunks: { start: number; end: number }[] = [];
  let start = 0;
  while (total - start > maxLen) {
    const lo = Math.floor((start + minSeconds * sampleRate) / frame);
    const hi = Math.floor((start + maxLen) / frame) - 1;
    let best = hi;
    for (let f = lo; f <= hi; f++) if (rms[f] < rms[best]) best = f;
    const cut = Math.min(total, Math.max(start + frame, best * frame + Math.floor(frame / 2)));
    chunks.push({ start, end: cut });
    start = cut;
  }
  chunks.push({ start, end: total });
  return chunks;
}

/** The voiced stretches of `samples`, in ms from its start. Short gaps (< 200 ms) are bridged
 *  so one word isn't split into several stretches. */
export function voicedRanges(samples: Float32Array, sampleRate: number): [number, number][] {
  const rms = frameRms(samples, sampleRate);
  const threshold = speechThreshold(rms);
  const ranges: [number, number][] = [];
  rms.forEach((r, i) => {
    if (r <= threshold) return;
    const s = i * FRAME_MS;
    const e = Math.min((i + 1) * FRAME_MS, (samples.length / sampleRate) * 1000);
    const last = ranges[ranges.length - 1];
    if (last && s - last[1] < 200) last[1] = e;
    else ranges.push([s, e]);
  });
  return ranges;
}

/** Spreads the words of `text` over the speech: each word gets time in proportion to its
 *  length, laid over the voiced ranges (or the whole span when nothing reads as voiced). */
export function estimateWordTimings(text: string, durationMs: number, voiced: [number, number][] = []): WordTiming[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0 || durationMs <= 0) return [];
  const spans = voiced.filter(([s, e]) => e > s).map(([s, e]) => [Math.max(0, s), Math.min(durationMs, e)] as [number, number]);
  const ranges: [number, number][] = spans.length > 0 ? spans : [[0, durationMs]];
  const speech = ranges.reduce((n, [s, e]) => n + (e - s), 0);
  const weights = words.map((w) => w.length + 1);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  // Maps a position along the concatenated speech back to a time in the chunk.
  const at = (pos: number): number => {
    let left = pos;
    for (const [s, e] of ranges) {
      if (left <= e - s) return s + left;
      left -= e - s;
    }
    return ranges[ranges.length - 1][1];
  };
  const out: WordTiming[] = [];
  let acc = 0;
  words.forEach((w, i) => {
    const startPos = (acc / totalWeight) * speech;
    acc += weights[i];
    const endPos = (acc / totalWeight) * speech;
    out.push({ text: w, startMs: Math.round(at(startPos)), endMs: Math.round(at(endPos)) });
  });
  return out;
}

/** Word times from a transcription response, if it has any: `words: [{ word|text, start, end }]`
 *  in seconds (Whisper's verbose format) or `startMs`/`endMs`. Shifted by `offsetMs`. */
export function parseBackendWords(data: unknown, offsetMs = 0): WordTiming[] | null {
  const words = (data as { words?: unknown })?.words;
  if (!Array.isArray(words) || words.length === 0) return null;
  const out: WordTiming[] = [];
  for (const w of words) {
    const o = (w ?? {}) as Record<string, unknown>;
    const text = String(o.word ?? o.text ?? "").trim();
    const ms = (sec: unknown, msVal: unknown) =>
      typeof msVal === "number" ? msVal : typeof sec === "number" ? sec * 1000 : NaN;
    const startMs = ms(o.start, o.startMs);
    const endMs = ms(o.end, o.endMs);
    if (!text || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
    const confidence = typeof o.confidence === "number" ? o.confidence : typeof o.probability === "number" ? o.probability : undefined;
    out.push({ text, startMs: Math.round(startMs + offsetMs), endMs: Math.round(Math.max(startMs, endMs) + offsetMs), confidence });
  }
  return out;
}

/** Word timings as Remotion `Caption` tokens: every token after the first starts with a space,
 *  times scaled by `timeScale` (1 / playbackRate) and kept in order without overlaps. */
export function toCaptions(words: WordTiming[], timeScale = 1): Caption[] {
  const out: Caption[] = [];
  let prevEnd = 0;
  words.forEach((w, i) => {
    const startMs = Math.max(prevEnd, Math.round(w.startMs * timeScale));
    const endMs = Math.max(startMs + 1, Math.round(w.endMs * timeScale));
    const c: Caption = { text: i === 0 ? w.text : ` ${w.text}`, startMs, endMs, timestampMs: Math.round((startMs + endMs) / 2) };
    if (w.confidence !== undefined) c.confidence = w.confidence;
    out.push(c);
    prevEnd = endMs;
  });
  return out;
}

/** A legible default caption look for the composition's size: bold sans, white with an
 *  outline, inside the lower title-safe area (higher up on vertical video, clear of app UI). */
export function defaultCaptionStyle(comp: Pick<Composition, "width" | "height">): TextStyle {
  const short = Math.min(comp.width, comp.height);
  return {
    fontFamily: "Inter",
    fontSize: Math.round(short * 0.058),
    fontWeight: 800,
    color: "#FFFFFF",
    align: "center",
    lineHeight: 1.15,
    stroke: "#000000",
    shadow: "0 4px 18px rgba(0,0,0,0.55)",
    maxWidth: Math.round(comp.width * 0.84),
  };
}

export function buildCaptionsClip(
  source: Pick<VideoClip | AudioClip, "from" | "durationInFrames" | "name">,
  comp: Pick<Composition, "width" | "height">,
  captions: Caption[],
  mode: CaptionsMode = "word-highlight",
): CaptionsClip {
  const vertical = comp.height > comp.width;
  return {
    id: newId("captions"),
    type: "captions",
    name: source.name ? `Captions · ${source.name}` : "Captions",
    from: source.from,
    durationInFrames: source.durationInFrames,
    transform: {
      x: Math.round(comp.width / 2),
      y: Math.round(comp.height * (vertical ? 0.7 : 0.84)),
      scale: 1,
      rotation: 0,
    },
    captions,
    style: defaultCaptionStyle(comp),
    mode,
    highlightColor: "#FFD43B",
  };
}

const overlaps = (a: { from: number; durationInFrames: number }, b: { from: number; durationInFrames: number }) =>
  a.from < b.from + b.durationInFrames && b.from < a.from + a.durationInFrames;

/** A copy of `timeline` with `clip` on the top-most "text" track it fits in without overlapping,
 *  or on a new "Captions" track on top. */
export function insertCaptionsClip(timeline: Timeline, compositionId: string, clip: CaptionsClip): Timeline {
  return {
    ...timeline,
    compositions: timeline.compositions.map((comp) => {
      if (comp.id !== compositionId) return comp;
      const tracks = [...comp.tracks];
      let index = -1;
      for (let i = tracks.length - 1; i >= 0; i--) {
        const t = tracks[i];
        if (t.kind === "text" && !t.locked && !t.clips.some((c) => overlaps(c, clip))) {
          index = i;
          break;
        }
      }
      if (index === -1) {
        const track: Track = { id: newId("track"), name: "Captions", kind: "text", clips: [] };
        tracks.push(track);
        index = tracks.length - 1;
      }
      const target = tracks[index];
      tracks[index] = { ...target, clips: [...target.clips, clip].sort((a, b) => a.from - b.from) };
      return { ...comp, tracks };
    }),
  };
}

export interface ChunkTranscript {
  text: string;
  words: WordTiming[] | null;
}

export type ChunkTranscriber = (wavBase64: string, language: string, signal?: AbortSignal) => Promise<ChunkTranscript>;

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** One chunk through the app's transcription backend. Asks for word timestamps; today's
 *  backend ignores that and answers `{ text }`. */
export const transcribeChunk: ChunkTranscriber = async (audio, language, signal) => {
  const token = await getToken();
  if (!token) throw new CaptionsError("not-signed-in", "Sign in to Nyxs to transcribe audio.");
  const httpFetch = isTauri ? (tauriFetch as unknown as typeof fetch) : fetch;
  const res = await httpFetch(`${AUTH_BASE}/api/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ audio, language, timestamps: "word" }),
    signal,
  });
  if (res.status === 401) throw new CaptionsError("not-signed-in", "Sign in to Nyxs to transcribe audio.");
  if (!res.ok) throw new CaptionsError("failed", `Transcription failed (HTTP ${res.status}).`);
  const data = (await res.json()) as { text?: string };
  return { text: (data.text ?? "").trim(), words: parseBackendWords(data) };
};

/** Word timings for mono samples, chunk by chunk. */
export async function transcribeSamples(
  samples: Float32Array,
  sampleRate: number,
  { language = "multi", transcribe = transcribeChunk, signal }: { language?: string; transcribe?: ChunkTranscriber; signal?: AbortSignal } = {},
): Promise<{ words: WordTiming[]; timing: CaptionsResult["timing"] }> {
  const words: WordTiming[] = [];
  let estimated = false;
  for (const { start, end } of planChunks(samples, sampleRate)) {
    signal?.throwIfAborted();
    const part = samples.subarray(start, end);
    const voiced = voicedRanges(part, sampleRate);
    if (voiced.length === 0) continue;
    const offsetMs = (start / sampleRate) * 1000;
    const res = await transcribe(encodeWavBase64(part, sampleRate), language, signal);
    const voicedMs = voiced.reduce((n, [s, e]) => n + (e - s), 0);
    if (!res.text || (voicedMs < 1000 && isSilenceHallucination(res.text))) continue;
    if (res.words && res.words.length > 0) {
      words.push(...res.words.map((w) => ({ ...w, startMs: w.startMs + offsetMs, endMs: w.endMs + offsetMs })));
    } else {
      estimated = true;
      const durationMs = (part.length / sampleRate) * 1000;
      words.push(...estimateWordTimings(res.text, durationMs, voiced).map((w) => ({ ...w, startMs: w.startMs + offsetMs, endMs: w.endMs + offsetMs })));
    }
  }
  return { words, timing: estimated ? "estimated" : "backend" };
}

/** Good enough for speech recognition, which only needs the 0–8 kHz band. */
export function resampleLinear(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to || samples.length === 0) return samples;
  const out = new Float32Array(Math.max(1, Math.round((samples.length * to) / from)));
  const step = from / to;
  for (let i = 0; i < out.length; i++) {
    const pos = i * step;
    const j = Math.floor(pos);
    const a = samples[Math.min(j, samples.length - 1)];
    const b = samples[Math.min(j + 1, samples.length - 1)];
    out[i] = a + (b - a) * (pos - j);
  }
  return out;
}

function projectFile(workspace: string, slug: string, rel: string): string {
  return `${workspace.replace(/[\\/]+$/, "")}/videos/${slug}/${rel.replace(/^[\\/]+/, "")}`;
}

/** Resamples a decoded buffer to 16 kHz mono with an offline context. */
async function toMono16k(decoded: AudioBuffer, startMs: number, endMs: number): Promise<Float32Array> {
  const from = Math.max(0, startMs / 1000);
  const to = Math.min(decoded.duration, endMs / 1000);
  const seconds = Math.max(0, to - from);
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(seconds * SAMPLE_RATE)), SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start(0, from, seconds);
  return (await offline.startRendering()).getChannelData(0);
}

/** The asset's audio between `startMs` and `endMs`, 16 kHz mono. Prefers the backend's ffmpeg
 *  extraction (any format); falls back to decoding a video file in the WebView. */
async function loadAudio(workspace: string, slug: string, assetId: string, assetSrc: string, kind: string, startMs: number, endMs: number): Promise<Float32Array> {
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  let firstError: unknown;
  try {
    const wavPath = await extractAudio(workspace, slug, assetId, Math.round(startMs), Math.round(endMs));
    const res = await fetch(convertFileSrc(wavPath));
    const { samples, sampleRate } = decodeWav(await res.arrayBuffer());
    return resampleLinear(samples, sampleRate, SAMPLE_RATE);
  } catch (e) {
    firstError = e;
  }
  if (kind !== "video") throw new CaptionsError("no-audio", `Couldn't extract the audio of ${assetSrc}: ${String(firstError)}`);
  // The WebView may only open files the asset protocol allows; agent_prepare_video allows it.
  const source = await invoke<{ localPath: string }>("agent_prepare_video", { path: projectFile(workspace, slug, assetSrc), scope: null, workspace });
  const bytes = await (await fetch(convertFileSrc(source.localPath))).arrayBuffer();
  const ctx = new AudioContext();
  try {
    return await toMono16k(await ctx.decodeAudioData(bytes), startMs, endMs);
  } catch (e) {
    throw new CaptionsError("no-audio", `Couldn't decode the audio of ${assetSrc}: ${String(e)}`);
  } finally {
    void ctx.close();
  }
}

export interface GenerateCaptionsOptions {
  workspace: string;
  slug: string;
  compositionId: string;
  /** The video or audio clip whose speech becomes captions. */
  clipId: string;
  /** Whisper language code, or "multi" to auto-detect. */
  language?: string;
  mode?: CaptionsMode;
  signal?: AbortSignal;
  transcribe?: ChunkTranscriber;
}

/** Transcribes a clip of `timeline` and builds the captions clip covering it; adding it to the
 *  document is up to the caller. */
export async function captionsClipFor(timeline: Timeline, opts: GenerateCaptionsOptions): Promise<CaptionsResult> {
  const { workspace, slug, compositionId, clipId, language = "multi", mode = "word-highlight", signal, transcribe } = opts;
  const comp = timeline.compositions.find((c) => c.id === compositionId);
  if (!comp) throw new CaptionsError("not-found", `No composition "${compositionId}" in timeline.json.`);
  const clip = comp.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
  if (!clip || (clip.type !== "video" && clip.type !== "audio")) {
    throw new CaptionsError("not-found", `No video or audio clip "${clipId}" in composition "${compositionId}".`);
  }
  const asset = timeline.assets.find((a) => a.id === clip.assetId);
  if (!asset) throw new CaptionsError("not-found", `Clip "${clipId}" uses asset "${clip.assetId}", which isn't in assets.`);
  const rate = clip.type === "video" ? clip.playbackRate ?? 1 : 1;
  // The clip plays asset time [trim, trim + duration × rate]; captions are in clip time.
  const startMs = (clip.trimStart / comp.fps) * 1000;
  const endMs = startMs + (clip.durationInFrames / comp.fps) * 1000 * rate;
  const samples = await loadAudio(workspace, slug, asset.id, asset.src, asset.kind, startMs, endMs);
  const { words, timing } = await transcribeSamples(samples, SAMPLE_RATE, { language, transcribe, signal });
  if (words.length === 0) throw new CaptionsError("empty", "No speech was found in the clip's audio.");
  signal?.throwIfAborted();
  return { clip: buildCaptionsClip(clip, comp, toCaptions(words, 1 / rate), mode), words: words.length, timing };
}

/** Transcribes a clip's audio and saves a captions clip covering it in timeline.json. */
export async function generateCaptions(opts: GenerateCaptionsOptions): Promise<CaptionsResult> {
  const { workspace, slug, compositionId } = opts;
  const parsed = validateTimeline(JSON.parse(await readTimeline(workspace, slug)));
  if (!parsed.ok) throw new CaptionsError("failed", `timeline.json is invalid, fix it first:\n${parsed.errors.join("\n")}`);
  const timeline = parsed.timeline;
  const result = await captionsClipFor(timeline, opts);
  // Re-read so an edit made while transcribing (the user, or the agent) isn't lost.
  const latest = validateTimeline(JSON.parse(await readTimeline(workspace, slug)));
  const base = latest.ok ? latest.timeline : timeline;
  await writeTimeline(workspace, slug, JSON.stringify(insertCaptionsClip(base, compositionId, result.clip), null, 2) + "\n");
  return result;
}
