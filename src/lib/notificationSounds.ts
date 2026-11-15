/** One synthesized note: a frequency (Hz) that starts `at` seconds in and fades out over `dur`. */
interface Note {
  f: number;
  at?: number;
  dur: number;
  type?: OscillatorType;
  peak?: number;
  attack?: number;
  /** Glides the pitch here over the first part of the note. */
  to?: number;
}

/** A partial above a note's fundamental, for bells and keys: frequency ratio, peak, duration. */
const partials = (base: Note, list: [ratio: number, peak: number, dur: number][]): Note[] =>
  list.map(([ratio, peak, dur]) => ({ ...base, f: base.f * ratio, peak, dur }));

const SOUNDS = {
  classic: [
    { f: 880, dur: 0.28, attack: 0.02 },
    { f: 1174.7, at: 0.13, dur: 0.28, attack: 0.02 },
  ],
  drop: [{ f: 1500, to: 520, dur: 0.22, attack: 0.004, peak: 0.22 }],
  bell: partials({ f: 1046.5, dur: 1.2, attack: 0.004 }, [[1, 0.16, 1.2], [2.76, 0.06, 0.8], [5.4, 0.03, 0.45]]),
  arpeggio: [
    { f: 1046.5, dur: 0.3, type: "triangle", attack: 0.006, peak: 0.12 },
    { f: 1318.5, at: 0.07, dur: 0.3, type: "triangle", attack: 0.006, peak: 0.12 },
    { f: 1568, at: 0.14, dur: 0.6, type: "triangle", attack: 0.006, peak: 0.12 },
  ],
  marimba: [659.3, 987.8].flatMap((f, i): Note[] => [
    { f, at: i * 0.12, dur: 0.35, type: "triangle", attack: 0.003, peak: 0.2 },
    { f: f * 4, at: i * 0.12, dur: 0.08, attack: 0.002, peak: 0.05 },
  ]),
  crystal: [2093, 2637].flatMap((f, i): Note[] => [
    { f, at: i * 0.1, dur: 1, attack: 0.005, peak: 0.08 },
    // A copy a few cents off makes the shimmer.
    { f: f * 1.004, at: i * 0.1, dur: 1, attack: 0.005, peak: 0.05 },
  ]),
  gentle: [
    { f: 784, dur: 0.45, attack: 0.03, peak: 0.16 },
    { f: 587.3, at: 0.16, dur: 0.55, attack: 0.03, peak: 0.16 },
  ],
  bubble: [
    { f: 420, to: 1250, dur: 0.16, attack: 0.004, peak: 0.18 },
    { f: 620, to: 1600, at: 0.09, dur: 0.14, attack: 0.004, peak: 0.1 },
  ],
  ping: [
    { f: 1318.5, dur: 0.6, attack: 0.003, peak: 0.16 },
    { f: 2637, dur: 0.25, attack: 0.003, peak: 0.03 },
  ],
  harp: [523.3, 659.3, 784, 1046.5].map((f, i): Note => ({
    f, at: i * 0.055, dur: i === 3 ? 0.9 : 0.5, type: "triangle", attack: 0.004, peak: 0.11,
  })),
  keys: [587.3, 880].flatMap((f, i) =>
    partials({ f, at: i * 0.14, dur: 0.7, attack: 0.006 }, [[1, 0.14, 0.7], [2, 0.04, 0.35], [3, 0.015, 0.2]]),
  ),
  tap: [
    { f: 1800, dur: 0.05, type: "triangle", attack: 0.002, peak: 0.2 },
    { f: 2200, at: 0.1, dur: 0.05, type: "triangle", attack: 0.002, peak: 0.2 },
  ],
  chord: [523.3, 659.3, 784].map((f, i): Note => ({ f, at: i * 0.012, dur: 0.9, attack: 0.02, peak: 0.08 })),
  retro: [
    { f: 987.8, dur: 0.09, type: "square", attack: 0.002, peak: 0.05 },
    { f: 1318.5, at: 0.08, dur: 0.35, type: "square", attack: 0.002, peak: 0.05 },
  ],
} satisfies Record<string, Note[]>;

export type NotificationSoundId = keyof typeof SOUNDS | "none";

export const DEFAULT_NOTIFICATION_SOUND: NotificationSoundId = "classic";

/** In the order Settings lists them; "none" last. */
export const NOTIFICATION_SOUND_IDS = [...Object.keys(SOUNDS), "none"] as NotificationSoundId[];

export function isNotificationSoundId(id: unknown): id is NotificationSoundId {
  return typeof id === "string" && (NOTIFICATION_SOUND_IDS as string[]).includes(id);
}

let audioCtx: AudioContext | null = null;

/** Plays a sound from the catalog, synthesized on the spot (no audio files to ship). */
export function playNotificationSound(id: NotificationSoundId): void {
  if (id === "none") return;
  const notes: Note[] = SOUNDS[id] ?? SOUNDS.classic;
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audioCtx = audioCtx ?? new Ctor();
    const ctx = audioCtx;
    if (ctx.state === "suspended") void ctx.resume();
    const start = ctx.currentTime + 0.01;
    for (const n of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = start + (n.at ?? 0);
      const attack = n.attack ?? 0.01;
      osc.type = n.type ?? "sine";
      osc.frequency.setValueAtTime(n.f, t);
      if (n.to) osc.frequency.exponentialRampToValueAtTime(n.to, t + n.dur * 0.6);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(n.peak ?? 0.18, t + attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + n.dur + 0.02);
    }
  } catch {
    // Audio is best-effort.
  }
}
