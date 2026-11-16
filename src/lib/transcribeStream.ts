import { AUTH_BASE, getToken } from "./auth";
import { TranscribeError } from "./transcribe";

/**
 * Live dictation: the microphone's audio goes to the Nyxs backend as it is spoken
 * (`/api/transcribe/stream`, relayed to xAI's streaming speech-to-text) and the transcript
 * comes back while the user talks. No language is set: the model detects it, also when the
 * app is in English and the user speaks Spanish.
 */

const TARGET_RATE = 16000;
/** 100 ms of audio per frame, as xAI recommends. */
const FRAME_SAMPLES = 1600;
/** How long to wait for the backend and xAI before falling back to the recorded clip. */
const READY_TIMEOUT_MS = 4000;
/** After "stop", how long the last words may take. */
const DONE_TIMEOUT_MS = 4000;
/** Audio kept while connecting: about 10 s. */
const MAX_QUEUED_FRAMES = 100;

/** The backend has no live dictation (an older one, no key, offline): use the recorded clip. */
export class StreamUnavailable extends Error {}

export interface PartialEvent {
  text: string;
  is_final: boolean;
  speech_final: boolean;
}

/**
 * The transcript from xAI's partials. An interim partial replaces the previous one; a final
 * chunk locks its words; the utterance's last event (`speech_final`) carries the whole
 * utterance, which replaces its chunks. `transcript.done` carries no text, so this is it.
 */
export class TranscriptAssembler {
  private utterances: string[] = [];
  private chunks: string[] = [];
  private interim = "";

  push(ev: PartialEvent): void {
    const text = ev.text.trim();
    if (!ev.is_final) {
      this.interim = text;
      return;
    }
    this.interim = "";
    if (!ev.speech_final) {
      if (text) this.chunks.push(text);
      return;
    }
    // Normally the whole utterance; if it only carries the last piece, keep the chunks too.
    const chunked = this.chunks.join(" ");
    const whole = text.length >= chunked.length ? text : [chunked, text].filter(Boolean).join(" ");
    if (whole) this.utterances.push(whole);
    this.chunks = [];
  }

  get text(): string {
    return [...this.utterances, ...this.chunks, this.interim].filter(Boolean).join(" ");
  }
}

/**
 * The microphone's samples, at whatever rate the device runs, as 16 kHz 16-bit PCM in 100 ms
 * frames. Each output sample is the mean of the input samples it covers, a light low-pass
 * that keeps 48 kHz noise from folding into the voice band. Works for any input rate.
 */
export class PcmFramer {
  private ratio: number;
  private acc = 0;
  private count = 0;
  private boundary: number;
  private consumed = 0;
  private frame = new Int16Array(FRAME_SAMPLES);
  private filled = 0;
  private onFrame: (frame: ArrayBuffer) => void;

  constructor(inputRate: number, onFrame: (frame: ArrayBuffer) => void) {
    this.ratio = inputRate / TARGET_RATE;
    this.boundary = this.ratio;
    this.onFrame = onFrame;
  }

  push(input: Float32Array): void {
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i];
      this.count++;
      this.consumed++;
      if (this.consumed >= this.boundary) {
        this.emit(this.acc / this.count);
        this.acc = 0;
        this.count = 0;
        this.boundary += this.ratio;
      }
    }
  }

  /** Sends what is left of the last frame. */
  flush(): void {
    if (this.filled === 0) return;
    this.onFrame(this.frame.slice(0, this.filled).buffer);
    this.filled = 0;
  }

  private emit(sample: number): void {
    const s = Math.max(-1, Math.min(1, sample));
    this.frame[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    if (this.filled === FRAME_SAMPLES) {
      this.onFrame(this.frame.slice().buffer);
      this.filled = 0;
    }
  }
}

const streamUrl = () => `${AUTH_BASE.replace(/^http/, "ws")}/api/transcribe/stream`;

/** The server's error codes that mean the session token was rejected. */
function isAuthError(code: string): boolean {
  return /unauth|token|forbidden|expired|sign/i.test(code);
}

type ServerEvent =
  | ({ type: "partial" } & PartialEvent)
  | { type: "ready" }
  | { type: "done" }
  | { type: "error"; code?: string };

export class StreamingDictation {
  private ws: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private analyser: AnalyserNode | null = null;
  private samples: Float32Array<ArrayBuffer> | null = null;
  private framer: PcmFramer | null = null;
  private assembler = new TranscriptAssembler();
  private ready = false;
  private queue: ArrayBuffer[] = [];
  private finished: (() => void) | null = null;
  private onText: (text: string) => void;

  /** `onText` gets the whole transcript so far, each time it changes. */
  constructor(onText: (text: string) => void) {
    this.onText = onText;
  }

  /** Opens the microphone and the stream; rejects with `StreamUnavailable` when there is no
   *  live dictation, or a `TranscribeError` ("no-mic") when there is no microphone. */
  async start(deviceId?: string, keyterms: string[] = []): Promise<void> {
    const token = await getToken();
    // Without a session there is no transcription at all: say so, instead of falling back to a
    // clip that would fail the same way.
    if (!token) throw new TranscribeError("not-signed-in", "not signed in");
    const ready = this.connect(token, keyterms);
    // If the microphone fails first, nobody awaits this one.
    ready.catch(() => {});
    try {
      // The microphone opens while the stream connects, so the first words aren't lost.
      await this.openMic(deviceId);
      await ready;
    } catch (e) {
      this.cancel();
      throw e;
    }
  }

  private connect(token: string, keyterms: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(streamUrl());
      } catch (e) {
        return reject(new StreamUnavailable(String(e)));
      }
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      const timer = setTimeout(() => reject(new StreamUnavailable("timeout")), READY_TIMEOUT_MS);
      ws.onopen = () => ws.send(JSON.stringify({ type: "start", token, keyterms }));
      ws.onmessage = (m) => {
        if (typeof m.data !== "string") return;
        let ev: ServerEvent;
        try {
          ev = JSON.parse(m.data) as ServerEvent;
        } catch {
          return;
        }
        if (ev.type === "ready") {
          clearTimeout(timer);
          this.ready = true;
          for (const frame of this.queue) ws.send(frame);
          this.queue = [];
          resolve();
        } else if (ev.type === "partial") {
          this.assembler.push(ev);
          this.onText(this.assembler.text);
        } else if (ev.type === "done") {
          this.finished?.();
        } else if (ev.type === "error") {
          clearTimeout(timer);
          const code = ev.code ?? "error";
          reject(isAuthError(code) ? new TranscribeError("not-signed-in", code) : new StreamUnavailable(code));
          this.finished?.();
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new StreamUnavailable("connection failed"));
      };
      ws.onclose = () => {
        clearTimeout(timer);
        reject(new StreamUnavailable("closed"));
        this.finished?.();
      };
    });
  }

  private async openMic(deviceId?: string): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new TranscribeError("no-mic", "getUserMedia unavailable");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
    } catch {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        throw new TranscribeError("no-mic", "mic permission denied");
      }
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    const source = ctx.createMediaStreamSource(this.stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.samples = new Float32Array(this.analyser.fftSize);
    source.connect(this.analyser);
    this.framer = new PcmFramer(ctx.sampleRate, (frame) => this.sendFrame(frame));
    // ScriptProcessor rather than an AudioWorklet: it needs no module URL (which the app's
    // CSP would have to allow) and runs in every webview Nyxs ships on. 4096 samples is
    // under 100 ms at 48 kHz.
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => this.framer?.push(e.inputBuffer.getChannelData(0));
    source.connect(processor);
    // Chromium only runs the processor when it reaches the destination; its output is silence.
    processor.connect(ctx.destination);
    this.processor = processor;
    if (ctx.state === "suspended") await ctx.resume();
  }

  private sendFrame(frame: ArrayBuffer): void {
    const ws = this.ws;
    if (this.ready && ws?.readyState === WebSocket.OPEN) ws.send(frame);
    else if (this.queue.length < MAX_QUEUED_FRAMES) this.queue.push(frame);
  }

  /** Current input loudness from 0 (silence) to 1, for the listening animation. */
  level(): number {
    if (!this.analyser || !this.samples) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const s of this.samples) sum += s * s;
    return Math.min(1, Math.sqrt(sum / this.samples.length) * 5);
  }

  /** Stops listening and resolves with the final transcript (what arrived, if the stream broke). */
  async stop(): Promise<string> {
    this.framer?.flush();
    this.releaseMic();
    const ws = this.ws;
    if (ws?.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, DONE_TIMEOUT_MS);
        this.finished = () => {
          clearTimeout(timer);
          resolve();
        };
        ws.send(JSON.stringify({ type: "stop" }));
      });
    }
    this.closeSocket();
    return this.assembler.text;
  }

  /** Drops the dictation without waiting for its text. */
  cancel(): void {
    this.releaseMic();
    this.closeSocket();
  }

  private releaseMic(): void {
    if (this.processor) this.processor.onaudioprocess = null;
    this.processor?.disconnect();
    this.processor = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.analyser = null;
    this.samples = null;
  }

  private closeSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onmessage = ws.onerror = ws.onclose = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }
}
