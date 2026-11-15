// The sound side of the music generator, in plain JS with nothing to install: instruments that
// write notes into stereo buses, and the effects and mastering that make them sit together.
export const SR = 48000;
const TAU = Math.PI * 2;

export const midiHz = (n) => 440 * 2 ** ((n - 69) / 12);

/** A small seeded generator (mulberry32): the same seed always gives the same piece. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Bus {
  constructor(samples) {
    this.l = new Float32Array(samples);
    this.r = new Float32Array(samples);
    this.length = samples;
  }

  /** Adds a mono voice at `at` seconds. `pan` runs -1..1, with equal power. */
  add(voice, at, gain = 1, pan = 0) {
    const start = Math.round(at * SR);
    const angle = ((pan + 1) * Math.PI) / 4;
    const gl = gain * Math.cos(angle);
    const gr = gain * Math.sin(angle);
    const n = Math.min(voice.length, this.length - start);
    for (let i = Math.max(0, -start); i < n; i++) {
      this.l[start + i] += voice[i] * gl;
      this.r[start + i] += voice[i] * gr;
    }
  }

  mixInto(target, gain = 1) {
    for (let i = 0; i < this.length; i++) {
      target.l[i] += this.l[i] * gain;
      target.r[i] += this.r[i] * gain;
    }
  }
}

/** A state-variable lowpass with a fixed or per-sample cutoff, in place. */
function lowpass(buf, cutoff, q = 0.7) {
  let ic1 = 0;
  let ic2 = 0;
  const fixed = typeof cutoff === "number";
  let g = fixed ? Math.tan((Math.PI * Math.min(cutoff, SR * 0.45)) / SR) : 0;
  const k = 1 / q;
  for (let i = 0; i < buf.length; i++) {
    if (!fixed) g = Math.tan((Math.PI * Math.min(cutoff(i), SR * 0.45)) / SR);
    const a1 = 1 / (1 + g * (g + k));
    const v3 = buf[i] - ic2;
    const v1 = a1 * ic1 + g * a1 * v3;
    const v2 = ic2 + g * v1;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    buf[i] = v2;
  }
  return buf;
}

function highpass(buf, cutoff) {
  const a = Math.exp((-TAU * cutoff) / SR);
  let lp = 0;
  for (let i = 0; i < buf.length; i++) {
    lp = (1 - a) * buf[i] + a * lp;
    buf[i] -= lp;
  }
  return buf;
}

/** A band-limited saw (polyBLEP), added into `out`. */
function addSaw(out, hz, gain, phase, drift = 0) {
  let t = phase;
  const inc = hz / SR;
  for (let i = 0; i < out.length; i++) {
    const dt = inc * (1 + drift * Math.sin((TAU * 0.13 * i) / SR));
    t += dt;
    if (t >= 1) t -= 1;
    let v = 2 * t - 1;
    if (t < dt) {
      const x = t / dt;
      v -= x + x - x * x - 1;
    } else if (t > 1 - dt) {
      const x = (t - 1) / dt;
      v -= x * x + x + x + 1;
    }
    out[i] += v * gain;
  }
}

/** A decaying sine by rotating a vector: two multiplications a sample, no Math.sin. */
function addPartial(out, hz, gain, decayPerSec, offset = 0) {
  if (hz >= SR * 0.45) return;
  const w = (TAU * hz) / SR;
  const cr = Math.cos(w);
  const ci = Math.sin(w);
  const fall = Math.exp(-decayPerSec / SR);
  let re = gain;
  let im = 0;
  for (let i = offset; i < out.length; i++) {
    out[i] += im;
    const nr = re * cr - im * ci;
    im = re * ci + im * cr;
    re = nr * fall;
    im *= fall;
  }
}

function fadeEdges(buf, attackSecs, releaseSecs) {
  const a = Math.min(buf.length, Math.round(attackSecs * SR));
  for (let i = 0; i < a; i++) buf[i] *= i / a;
  const r = Math.min(buf.length, Math.round(releaseSecs * SR));
  for (let i = 0; i < r; i++) buf[buf.length - 1 - i] *= i / r;
  return buf;
}

export function makeInstruments(random) {
  const noise = (n) => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = random() * 2 - 1;
    return out;
  };
  const samples = (secs) => Math.max(1, Math.round(secs * SR));

  /** One note of a warm pad: detuned saws under a slowly breathing filter. */
  function padVoice(midi, secs, brightness) {
    const out = new Float32Array(samples(secs));
    const hz = midiHz(midi);
    for (const detune of [-0.006, -0.002, 0.002, 0.006]) {
      addSaw(out, hz * (1 + detune), 0.16, random(), 0.0006);
    }
    addPartial(out, hz, 0.22, 0);
    const base = 340 + 3000 * brightness;
    const rate = 0.1 + random() * 0.1;
    const off = random() * TAU;
    lowpass(out, (i) => base * (1 + 0.25 * Math.sin((TAU * rate * i) / SR + off)));
    return fadeEdges(out, Math.min(0.8, secs * 0.3), Math.min(0.9, secs * 0.35));
  }

  /** A soft felted piano: inharmonic partials that die faster the higher they are, on two
   *  slightly detuned strings, with a little hammer noise. */
  function piano(midi, velocity = 0.8) {
    const hz = midiHz(midi);
    const out = new Float32Array(samples(Math.min(4.5, 2.4 + 90 / hz)));
    const partials = Math.min(10, Math.floor(9000 / hz));
    const inharmonic = 0.00035;
    for (let k = 1; k <= partials; k++) {
      const f = k * hz * Math.sqrt(1 + inharmonic * k * k);
      const amp = (velocity * (1 + velocity)) / k ** (2.1 - velocity * 0.7);
      const decay = 1.1 + k * k * 0.16 + hz / 500;
      addPartial(out, f * 0.9995, amp * 0.5, decay);
      addPartial(out, f * 1.0005, amp * 0.5, decay * 1.05);
    }
    const hammer = lowpass(noise(samples(0.03)), 1800);
    for (let i = 0; i < hammer.length; i++) out[i] += hammer[i] * 0.035 * velocity * (1 - i / hammer.length);
    return fadeEdges(out, 0.003, 0.08);
  }

  /** A plucked string (Karplus-Strong): a burst of noise circulating in a tuned, damped loop. */
  function pluck(midi, secs = 0.9, damp = 0.5) {
    const hz = midiHz(midi);
    const out = new Float32Array(samples(secs));
    const period = Math.max(2, Math.round(SR / hz));
    const line = lowpass(noise(period), 1400 + 5000 * damp);
    let idx = 0;
    let prev = 0;
    const loss = 0.992 + 0.0065 * damp;
    for (let i = 0; i < out.length; i++) {
      const cur = line[idx];
      const next = loss * (0.5 * cur + 0.5 * prev);
      prev = cur;
      line[idx] = next;
      idx = (idx + 1) % period;
      out[i] = cur;
    }
    return fadeEdges(out, 0.002, 0.05);
  }

  /** A woody mallet: a short pair of FM-like partials. */
  function mallet(midi) {
    const hz = midiHz(midi);
    const out = new Float32Array(samples(0.7));
    addPartial(out, hz, 0.8, 7);
    addPartial(out, hz * 4, 0.3, 26);
    addPartial(out, hz * 10, 0.08, 60);
    return fadeEdges(out, 0.001, 0.05);
  }

  /** A round electric bass: sine and triangle-ish harmonics, gently saturated. */
  function bass(midi, secs) {
    const hz = midiHz(midi);
    const out = new Float32Array(samples(secs));
    addPartial(out, hz, 0.8, 1.5);
    addPartial(out, hz * 2, 0.3, 5);
    addPartial(out, hz * 3, 0.1, 9);
    for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i] * 1.5);
    return fadeEdges(out, 0.004, 0.03);
  }

  function kick() {
    const n = samples(0.38);
    const out = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      ph += (TAU * (48 + 115 * Math.exp(-t * 36))) / SR;
      out[i] = Math.tanh(1.6 * Math.sin(ph) * Math.exp(-t * 8) + 0.2 * Math.exp(-t * 700));
    }
    return out;
  }

  function snare() {
    const n = samples(0.24);
    const out = highpass(noise(n), 900);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      out[i] = out[i] * 0.42 * Math.exp(-t * 17) + 0.34 * Math.sin(TAU * 188 * t) * Math.exp(-t * 28);
    }
    return lowpass(out, 8500);
  }

  function clap() {
    const n = samples(0.22);
    const out = lowpass(highpass(noise(n), 800), 6000);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const bursts = Math.max(...[0, 0.011, 0.022].map((d) => (t >= d ? Math.exp(-(t - d) * 180) : 0)));
      out[i] *= 0.6 * Math.max(bursts, 0.5 * Math.exp(-t * 18));
    }
    return out;
  }

  function hat(open = false) {
    const n = samples(open ? 0.24 : 0.05);
    const out = highpass(highpass(noise(n), 6000), 6000);
    const fall = open ? 14 : 80;
    for (let i = 0; i < n; i++) out[i] *= 0.2 * Math.exp((-i / SR) * fall);
    return out;
  }

  function shaker() {
    const n = samples(0.08);
    const out = lowpass(highpass(noise(n), 4000), 11000);
    for (let i = 0; i < n; i++) out[i] *= 0.1 * Math.sin((Math.PI * i) / n);
    return out;
  }

  function tom(hz = 72) {
    const n = samples(0.8);
    const out = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      ph += (TAU * (hz + 46 * Math.exp(-t * 22))) / SR;
      out[i] = Math.tanh(1.5 * Math.sin(ph) * Math.exp(-t * 5.5));
    }
    const skin = lowpass(noise(samples(0.05)), 1500);
    for (let i = 0; i < skin.length; i++) out[i] += skin[i] * 0.2 * Math.exp((-i / SR) * 60);
    return out;
  }

  /** A low hit under a section change. */
  function impact(secs = 1.6) {
    const n = samples(secs);
    const out = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      ph += (TAU * (38 + 55 * Math.exp(-t * 18))) / SR;
      out[i] = Math.tanh(1.8 * Math.sin(ph) * Math.exp(-t * (3 / secs)));
    }
    const air = lowpass(noise(samples(0.5)), 2600);
    for (let i = 0; i < air.length; i++) out[i] += air[i] * 0.16 * Math.exp((-i / SR) * 9);
    return fadeEdges(out, 0.001, 0.2);
  }

  /** Filtered noise rising into a hit: it ends exactly where it should land. */
  function riser(secs) {
    const n = samples(secs);
    const out = lowpass(noise(n), (i) => 300 + 7000 * (i / n) ** 2.4, 1.1);
    for (let i = 0; i < n; i++) out[i] *= 0.3 * (i / n) ** 2.6;
    return fadeEdges(out, 0.01, 0.004);
  }

  return { padVoice, piano, pluck, mallet, bass, kick, snare, clap, hat, shaker, tom, impact, riser };
}

/** An eight-line feedback delay network with damping: a smooth stereo room without metallic ring. */
export function reverb(send, decaySecs = 2.2, damping = 5200) {
  const lengths = [1693, 1933, 2179, 2437, 2719, 3001, 3299, 3607];
  const lines = lengths.map((n) => new Float32Array(n));
  const pos = new Int32Array(8);
  const lp = new Float32Array(8);
  const feedback = lengths.map((n) => 10 ** ((-3 * n) / (SR * decaySecs)));
  const a = Math.exp((-TAU * damping) / SR);
  const tap = new Float64Array(8);
  const out = new Bus(send.length);
  const pre = Math.round(0.024 * SR);
  for (let i = 0; i < send.length; i++) {
    const inL = i >= pre ? send.l[i - pre] : 0;
    const inR = i >= pre ? send.r[i - pre] : 0;
    let sum = 0;
    for (let k = 0; k < 8; k++) {
      tap[k] = lines[k][pos[k]];
      sum += tap[k];
    }
    sum *= 0.25; // Householder feedback matrix: lossless and fully mixing.
    for (let k = 0; k < 8; k++) {
      lp[k] = (1 - a) * (tap[k] - sum) * feedback[k] + a * lp[k];
      lines[k][pos[k]] = lp[k] + (k % 2 ? inR : inL) * 0.5;
      pos[k] = (pos[k] + 1) % lengths[k];
    }
    out.l[i] = tap[0] + tap[2] + tap[4] + tap[6];
    out.r[i] = tap[1] + tap[3] + tap[5] + tap[7];
  }
  return out;
}

/** A ping-pong echo, added onto the bus itself and to `send` so the echoes sit in the room. */
export function pingPong(bus, delaySecs, feedback = 0.38, mix = 0.28) {
  const d = Math.max(1, Math.round(delaySecs * SR));
  const dl = new Float32Array(d);
  const dr = new Float32Array(d);
  let p = 0;
  let lp = 0;
  for (let i = 0; i < bus.length; i++) {
    const wetL = dl[p];
    const wetR = dr[p];
    lp = 0.75 * lp + 0.25 * (bus.l[i] + bus.r[i]) * 0.5;
    dl[p] = wetR * feedback + lp;
    dr[p] = wetL * feedback;
    p = (p + 1) % d;
    bus.l[i] += wetL * mix;
    bus.r[i] += wetR * mix;
  }
}

/** Pulls `bus` down after each kick, which lets the kick and bass through without more level. */
export function sidechain(bus, kickTimes, depth = 0.4, recoverSecs = 0.11) {
  const gain = new Float32Array(bus.length).fill(1);
  const attack = Math.round(0.004 * SR);
  const len = Math.round(recoverSecs * 3.5 * SR);
  for (const t of kickTimes) {
    const start = Math.round(t * SR);
    for (let i = 0; i < len && start + i < bus.length; i++) {
      if (start + i < 0) continue;
      const shape = i < attack ? i / attack : Math.exp(-(i - attack) / (recoverSecs * SR));
      gain[start + i] = Math.min(gain[start + i], 1 - depth * shape);
    }
  }
  for (let i = 0; i < bus.length; i++) {
    bus.l[i] *= gain[i];
    bus.r[i] *= gain[i];
  }
}

/** Mid/side width: `amount` above 1 widens, below 1 narrows; the low end stays centered anyway. */
export function setWidth(bus, amount) {
  for (let i = 0; i < bus.length; i++) {
    const m = (bus.l[i] + bus.r[i]) * 0.5;
    const s = (bus.l[i] - bus.r[i]) * 0.5 * amount;
    bus.l[i] = m + s;
    bus.r[i] = m - s;
  }
}

/** The glue of a mix: slow stereo-linked compression, about 2:1 over the threshold. */
function compress(bus, thresholdDb = -16, ratio = 2, attackSecs = 0.03, releaseSecs = 0.25) {
  const atk = Math.exp(-1 / (attackSecs * SR));
  const rel = Math.exp(-1 / (releaseSecs * SR));
  let env = 0;
  for (let i = 0; i < bus.length; i++) {
    const level = Math.max(Math.abs(bus.l[i]), Math.abs(bus.r[i]));
    env = level > env ? atk * env + (1 - atk) * level : rel * env + (1 - rel) * level;
    const db = 20 * Math.log10(env + 1e-9);
    const over = Math.max(0, db - thresholdDb);
    const gain = 10 ** ((-over * (1 - 1 / ratio)) / 20);
    bus.l[i] *= gain;
    bus.r[i] *= gain;
  }
}

/** A lookahead limiter: gain drops before a peak arrives, so nothing clips and nothing distorts. */
function limit(bus, ceiling) {
  const look = Math.round(0.003 * SR);
  const rel = Math.exp(-1 / (0.09 * SR));
  const n = bus.length;
  const needed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = Math.max(Math.abs(bus.l[i]), Math.abs(bus.r[i]));
    needed[i] = p > ceiling ? ceiling / p : 1;
  }
  // The smallest gain anywhere in the next `look` samples, in one pass (monotonic queue).
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  let g = 1;
  for (let i = n - 1; i >= 0; i--) {
    while (tail > head && queue[tail - 1] > i && needed[queue[tail - 1]] >= needed[i]) tail--;
    queue[tail++] = i;
    while (queue[head] > i + look) head++;
    const min = needed[queue[head]];
    // Runs backwards here so the gain eases down ahead of the peak; the forward pass below
    // gives the release its natural shape.
    g = min < g ? min : rel * g + (1 - rel) * min;
    needed[i] = g;
  }
  g = needed[0];
  for (let i = 0; i < n; i++) {
    g = needed[i] < g ? needed[i] : rel * g + (1 - rel) * needed[i];
    bus.l[i] *= g;
    bus.r[i] *= g;
  }
}

/** The K-weighting filters of ITU-R BS.1770 at 48 kHz, in place. */
function kWeight(x) {
  const biquad = (b0, b1, b2, a1, a2) => {
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = v;
      y2 = y1;
      y1 = y;
      x[i] = y;
    }
  };
  biquad(1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585);
  biquad(1, -2, 1, -1.99004745483398, 0.99007225036621);
  return x;
}

/** Integrated loudness in LUFS (BS.1770-4, with both gates) and the loudness range's raw blocks. */
export function measureLufs(bus) {
  const l = kWeight(Float64Array.from(bus.l));
  const r = kWeight(Float64Array.from(bus.r));
  const block = Math.round(0.4 * SR);
  const hop = Math.round(0.1 * SR);
  const energies = [];
  for (let s = 0; s + block <= bus.length; s += hop) {
    let e = 0;
    for (let i = s; i < s + block; i++) e += l[i] * l[i] + r[i] * r[i];
    energies.push(e / block);
  }
  const lufs = (e) => -0.691 + 10 * Math.log10(e + 1e-12);
  const above = energies.filter((e) => lufs(e) > -70);
  if (!above.length) return -70;
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const relative = lufs(mean(above)) - 10;
  const gated = above.filter((e) => lufs(e) > relative);
  return lufs(mean(gated.length ? gated : above));
}

/** Makes a mix a finished master: cleans the extremes, glues it, sets the loudness, stops peaks. */
export function master(bus, { targetLufs = -16, ceilingDb = -1.5 } = {}) {
  for (const ch of [bus.l, bus.r]) {
    highpass(ch, 28);
    lowpass(ch, 13500, 0.6);
  }
  const toTarget = () => {
    const gain = 10 ** ((targetLufs - measureLufs(bus)) / 20);
    for (let i = 0; i < bus.length; i++) {
      bus.l[i] *= gain;
      bus.r[i] *= gain;
    }
  };
  // Leveled first: over a fixed threshold, a hot mix would be squashed into one flat loudness and
  // lose the quiet intro and break that give it a shape.
  toTarget();
  compress(bus, targetLufs + 4);
  const ceiling = 10 ** (ceilingDb / 20);
  // The limiter takes a little level off, so aim, measure and correct once.
  for (let pass = 0; pass < 2; pass++) {
    toTarget();
    limit(bus, ceiling);
  }
}

/** Objective numbers about a master: they catch mistakes; they can't say whether it sounds good. */
export function analyze(bus) {
  let peak = 0;
  let clipped = 0;
  let dc = 0;
  let sumLL = 0;
  let sumRR = 0;
  let sumLR = 0;
  // Three bands split by one-pole filters: rough, but enough to spot a lopsided mix.
  let lo = 0;
  let mid = 0;
  const aLo = Math.exp((-TAU * 200) / SR);
  const aMid = Math.exp((-TAU * 2500) / SR);
  let eLo = 0;
  let eMid = 0;
  let eHi = 0;
  for (let i = 0; i < bus.length; i++) {
    const a = bus.l[i];
    const b = bus.r[i];
    peak = Math.max(peak, Math.abs(a), Math.abs(b));
    if (Math.abs(a) >= 0.999 || Math.abs(b) >= 0.999) clipped++;
    dc += a + b;
    sumLL += a * a;
    sumRR += b * b;
    sumLR += a * b;
    const m = (a + b) * 0.5;
    lo = (1 - aLo) * m + aLo * lo;
    mid = (1 - aMid) * m + aMid * mid;
    eLo += lo * lo;
    eMid += (mid - lo) * (mid - lo);
    eHi += (m - mid) * (m - mid);
  }
  const total = eLo + eMid + eHi + 1e-12;
  const db = (x) => Math.round(20 * Math.log10(x + 1e-9) * 10) / 10;
  const rms = Math.sqrt((sumLL + sumRR) / (2 * bus.length));
  const pct = (x) => Math.round((x / total) * 1000) / 10;
  return {
    lufs: Math.round(measureLufs(bus) * 10) / 10,
    peakDb: db(peak),
    rmsDb: db(rms),
    crestDb: Math.round((db(peak) - db(rms)) * 10) / 10,
    clippedSamples: clipped,
    dcOffset: Math.round((dc / (2 * bus.length)) * 1e5) / 1e5,
    stereoCorrelation: Math.round((sumLR / Math.sqrt(sumLL * sumRR + 1e-12)) * 100) / 100,
    energyShare: { lowPct: pct(eLo), midPct: pct(eMid), highPct: pct(eHi) },
  };
}

/** Plain warnings for numbers outside what a usable bed has. */
export function qualityWarnings(s) {
  const out = [];
  if (s.clippedSamples > 0) out.push(`${s.clippedSamples} samples are clipping.`);
  if (Math.abs(s.dcOffset) > 0.002) out.push(`DC offset of ${s.dcOffset}.`);
  if (s.stereoCorrelation < 0.1) out.push(`The channels nearly cancel in mono (correlation ${s.stereoCorrelation}).`);
  if (s.energyShare.lowPct > 85) out.push(`Very bass-heavy (${s.energyShare.lowPct}% of the energy below 200 Hz).`);
  if (s.energyShare.highPct > 25) out.push(`Very bright (${s.energyShare.highPct}% of the energy above 2.5 kHz).`);
  if (s.crestDb < 6) out.push(`Over-compressed (crest factor ${s.crestDb} dB).`);
  return out;
}

/** Stereo 16-bit WAV with triangular dither. */
export function wavBytes(bus) {
  const n = bus.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 4, 40);
  const random = seededRandom(1);
  const sample = (v) => {
    const dithered = v * 32767 + random() - random();
    return Math.max(-32768, Math.min(32767, Math.round(dithered)));
  };
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(sample(bus.l[i]), 44 + i * 4);
    buf.writeInt16LE(sample(bus.r[i]), 46 + i * 4);
  }
  return buf;
}
