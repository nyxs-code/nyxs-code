import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { AUTH_BASE, getToken } from "./auth";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const httpFetch = isTauri ? (tauriFetch as unknown as typeof fetch) : fetch;

const TARGET_SAMPLE_RATE = 16000;
/** Audio past this point is dropped before transcription, so dictation stops itself here. */
export const MAX_SECONDS = 60;

export type TranscribeErrorReason = "no-mic" | "not-signed-in" | "empty" | "failed";

export class TranscribeError extends Error {
  reason: TranscribeErrorReason;
  constructor(reason: TranscribeErrorReason, message?: string) {
    super(message ?? reason);
    this.name = "TranscribeError";
    this.reason = reason;
  }
}

export interface MicDevice {
  deviceId: string;
  label: string;
}

export async function listMicrophones(): Promise<MicDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === "audioinput")
    .map((d) => ({ deviceId: d.deviceId, label: d.label }));
}

export async function ensureMicPermission(): Promise<boolean> {
  if (!navigator.mediaDevices?.getUserMedia) return false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

function pickMimeType(): string | undefined {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  const supported = typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported;
  if (!supported) return undefined;
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return undefined;
}

export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private meterCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private samples: Float32Array<ArrayBuffer> | null = null;

  async start(deviceId?: string): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new TranscribeError("no-mic", "getUserMedia unavailable");
    try {
      const constraints: MediaStreamConstraints = {
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      };
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        throw new TranscribeError("no-mic", "mic permission denied");
      }
    }
    const mimeType = pickMimeType();
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start();
    try {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(this.stream).connect(analyser);
      this.meterCtx = ctx;
      this.analyser = analyser;
      this.samples = new Float32Array(analyser.fftSize);
    } catch {
      // The level meter is cosmetic; recording works without it.
    }
  }

  /** Current input loudness from 0 (silence) to 1, for the listening animation. */
  level(): number {
    if (!this.analyser || !this.samples) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const s of this.samples) sum += s * s;
    return Math.min(1, Math.sqrt(sum / this.samples.length) * 5);
  }

  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const rec = this.recorder;
      if (!rec) {
        this.release();
        return reject(new TranscribeError("failed", "not recording"));
      }
      rec.onstop = () => {
        const type = rec.mimeType || this.chunks[0]?.type || "audio/webm";
        const blob = new Blob(this.chunks, { type });
        this.release();
        resolve(blob);
      };
      try {
        rec.stop();
      } catch (e) {
        this.release();
        reject(new TranscribeError("failed", String(e)));
      }
    });
  }

  cancel(): void {
    try {
      if (this.recorder && this.recorder.state !== "inactive") {
        this.recorder.onstop = null;
        this.recorder.stop();
      }
    } catch {
      /* ignore */
    }
    this.release();
  }

  private release(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    void this.meterCtx?.close().catch(() => {});
    this.meterCtx = null;
    this.analyser = null;
    this.samples = null;
  }
}

async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const decodeCtx = new Ctor();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer);
  } finally {
    void decodeCtx.close();
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  const pcm = rendered.getChannelData(0);
  const maxFrames = MAX_SECONDS * TARGET_SAMPLE_RATE;
  return pcm.length > maxFrames ? pcm.subarray(0, maxFrames) : pcm;
}

export function encodeWavBase64(samples: Float32Array, sampleRate: number): string {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

const FRAME_SECONDS = 0.03;
const MIN_SPEECH_RMS = 0.012;
const NOISE_FLOOR_FACTOR = 3;
const MIN_SPEECH_SECONDS = 0.25;
const CONFIDENT_SPEECH_SECONDS = 1;

export function speechSeconds(samples: Float32Array, sampleRate: number): number {
  const frame = Math.max(1, Math.round(sampleRate * FRAME_SECONDS));
  const rms: number[] = [];
  for (let start = 0; start + frame <= samples.length; start += frame) {
    let sum = 0;
    for (let i = start; i < start + frame; i++) sum += samples[i] * samples[i];
    rms.push(Math.sqrt(sum / frame));
  }
  if (rms.length === 0) return 0;
  const floor = [...rms].sort((a, b) => a - b)[Math.floor(rms.length * 0.2)];
  const threshold = Math.max(MIN_SPEECH_RMS, floor * NOISE_FLOOR_FACTOR);
  return rms.filter((r) => r > threshold).length * FRAME_SECONDS;
}

const SILENCE_HALLUCINATIONS = new Set([
  "you",
  "thank you",
  "thanks",
  "thanks for watching",
  "thank you for watching",
  "thank you so much for watching",
  "please subscribe",
  "bye",
  "bye bye",
  "gracias",
  "muchas gracias",
  "gracias por ver",
  "gracias por ver el video",
  "suscribete",
  "suscribete al canal",
  "subtitulos realizados por la comunidad de amaraorg",
  "subtitles by the amaraorg community",
  "sous-titres realises par la communaute damaraorg",
  "untertitel der amaraorg-community",
  "amaraorg",
]);

export function isSilenceHallucination(text: string): boolean {
  const key = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return key === "" || SILENCE_HALLUCINATIONS.has(key);
}

export async function transcribeBlob(blob: Blob, language: string = "multi"): Promise<string> {
  if (!blob || blob.size === 0) throw new TranscribeError("empty", "no audio captured");
  const token = await getToken();
  if (!token) throw new TranscribeError("not-signed-in", "no session token");

  const samples = await decodeToMono16k(blob);
  if (samples.length < TARGET_SAMPLE_RATE * 0.2) throw new TranscribeError("empty", "clip too short");
  const voiced = speechSeconds(samples, TARGET_SAMPLE_RATE);
  if (voiced < MIN_SPEECH_SECONDS) throw new TranscribeError("empty", "no speech detected");
  const audio = encodeWavBase64(samples, TARGET_SAMPLE_RATE);

  let res: Response;
  try {
    res = await httpFetch(`${AUTH_BASE}/api/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ audio, language }),
    });
  } catch (e) {
    throw new TranscribeError("failed", String(e));
  }
  if (res.status === 401) throw new TranscribeError("not-signed-in", "unauthorized");
  if (!res.ok) throw new TranscribeError("failed", `http ${res.status}`);
  const data = (await res.json()) as { text?: string };
  const text = (data.text ?? "").trim();
  if (voiced < CONFIDENT_SPEECH_SECONDS && isSilenceHallucination(text)) return "";
  return text;
}
