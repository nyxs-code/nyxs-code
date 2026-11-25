/** A background ambience while you work (Settings › Appearance › Theme sound), like Claude's theme
 *  sound. Made with Web Audio from noise and tones, so there are no audio files to ship. */
export type AmbientKind = "rain" | "campfire" | "ambience";
export type AmbientVolume = "low" | "medium" | "high";

const LEVEL: Record<AmbientVolume, number> = { low: 0.12, medium: 0.25, high: 0.45 };
const FADE_S = 1.2;

interface Playing {
  ctx: AudioContext;
  master: GainNode;
  kind: AmbientKind;
  stop: () => void;
}

let playing: Playing | null = null;

function noiseBuffer(ctx: AudioContext, seconds: number, brown = false): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1;
    if (brown) {
      // Integrated white noise: the deep rumble of a fire.
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    } else data[i] = white;
  }
  return buf;
}

/** A looping source of `buffer`, not yet connected or started. */
function loop(ctx: AudioContext, buffer: AudioBuffer): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  return src;
}

function filter(ctx: AudioContext, type: BiquadFilterType, frequency: number, q = 0.7): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  f.Q.value = q;
  return f;
}

/** Short random sounds over the bed: drops for the rain, crackles for the fire. */
function sprinkle(ctx: AudioContext, every: [number, number], make: (at: number) => void): () => void {
  let timer = 0;
  const next = () => {
    make(ctx.currentTime + 0.02);
    timer = window.setTimeout(next, every[0] + Math.random() * (every[1] - every[0]));
  };
  next();
  return () => window.clearTimeout(timer);
}

function burst(ctx: AudioContext, noise: AudioBuffer, to: AudioNode, at: number, freq: number, length: number, level: number): void {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const band = filter(ctx, "bandpass", freq, 4);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(level, at + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, at + length);
  src.connect(band).connect(g).connect(to);
  src.start(at, Math.random() * (noise.duration - length - 0.05));
  src.stop(at + length + 0.05);
}

function build(ctx: AudioContext, kind: AmbientKind, out: AudioNode): () => void {
  const white = noiseBuffer(ctx, 3);
  const stops: (() => void)[] = [];
  if (kind === "rain") {
    const bed = ctx.createGain();
    bed.gain.value = 0.55;
    const src = loop(ctx, white);
    src.connect(filter(ctx, "highpass", 500)).connect(filter(ctx, "lowpass", 5000)).connect(bed).connect(out);
    src.start();
    stops.push(() => src.stop());
    stops.push(sprinkle(ctx, [25, 110], (at) => burst(ctx, white, out, at, 1800 + Math.random() * 3500, 0.03 + Math.random() * 0.04, 0.25 + Math.random() * 0.35)));
  } else if (kind === "campfire") {
    const brown = noiseBuffer(ctx, 4, true);
    const bed = ctx.createGain();
    bed.gain.value = 0.9;
    const src = loop(ctx, brown);
    src.connect(filter(ctx, "lowpass", 700)).connect(bed).connect(out);
    src.start();
    stops.push(() => src.stop());
    stops.push(sprinkle(ctx, [60, 420], (at) => burst(ctx, white, out, at, 2500 + Math.random() * 4000, 0.008 + Math.random() * 0.02, 0.4 + Math.random() * 0.5)));
  } else {
    // A soft drone: two close tones that beat slowly, over a whisper of air.
    for (const [hz, level] of [[110, 0.18], [110.6, 0.18], [164.8, 0.06]] as const) {
      const osc = ctx.createOscillator();
      osc.frequency.value = hz;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(out);
      osc.start();
      stops.push(() => osc.stop());
    }
    const air = ctx.createGain();
    air.gain.value = 0.05;
    const src = loop(ctx, white);
    src.connect(filter(ctx, "lowpass", 900)).connect(air).connect(out);
    src.start();
    stops.push(() => src.stop());
  }
  return () => stops.forEach((s) => {
    try {
      s();
    } catch {
      // Already stopped.
    }
  });
}

type AudioContextCtor = new () => AudioContext;
const audioContext = (): AudioContextCtor | undefined =>
  (globalThis as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor }).AudioContext ??
  (globalThis as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;

/** Plays this ambience (fading in), or changes the volume when it already plays. */
export function startAmbient(kind: AmbientKind, volume: AmbientVolume): void {
  if (playing?.kind === kind) {
    playing.master.gain.setTargetAtTime(LEVEL[volume], playing.ctx.currentTime, 0.3);
    return;
  }
  stopAmbient();
  const Ctor = audioContext();
  if (!Ctor) return;
  const ctx = new Ctor();
  const master = ctx.createGain();
  master.gain.setValueAtTime(0, ctx.currentTime);
  master.gain.linearRampToValueAtTime(LEVEL[volume], ctx.currentTime + FADE_S);
  master.connect(ctx.destination);
  const stop = build(ctx, kind, master);
  playing = { ctx, master, kind, stop };
  // Some webviews start an AudioContext suspended until the user does something.
  if (ctx.state === "suspended") {
    const resume = () => void ctx.resume();
    window.addEventListener("pointerdown", resume, { once: true });
    window.addEventListener("keydown", resume, { once: true });
  }
}

/** Fades the ambience out and frees the audio. */
export function stopAmbient(): void {
  const p = playing;
  if (!p) return;
  playing = null;
  const now = p.ctx.currentTime;
  p.master.gain.cancelScheduledValues(now);
  p.master.gain.setValueAtTime(p.master.gain.value, now);
  p.master.gain.linearRampToValueAtTime(0, now + 0.4);
  window.setTimeout(() => {
    p.stop();
    void p.ctx.close();
  }, 500);
}

/** Quiet while the window is hidden or minimized, back when it shows. */
export function setAmbientPaused(paused: boolean): void {
  if (!playing) return;
  void (paused ? playing.ctx.suspend() : playing.ctx.resume());
}
