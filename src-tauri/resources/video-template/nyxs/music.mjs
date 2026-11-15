// Writes an original music bed: nothing sampled, nothing licensed, every sound synthesized here.
// Takes a mood, a tempo, a length and the video's cut points, and reports where the music actually
// lands, its loudness numbers and a volume curve for ducking under a voice.
//
//   node <runtime>/nyxs/music.mjs <options.json>
//
// Options are written by the app (src-tauri/src/video/tools.rs). Events as in render.mjs:
// {"type":"progress"|"done"|"error", ...}.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { emit, readRequest, runTask } from "./lib/common.mjs";
import { MOODS, arrange, beatGrid, chordNotes, duckingCurve } from "./lib/musicScore.mjs";
import {
  Bus, SR, analyze, makeInstruments, master, pingPong, qualityWarnings, reverb, seededRandom, setWidth, sidechain, wavBytes,
} from "./lib/synth.mjs";

const BEATS_PER_BAR = 4;

/** A melody that moves over the chords: two bars of rhythm, repeated, with chord tones on the
 *  strong beats so it can't clash, and a neighbor tone or two between them. */
function makeMotif(random) {
  const rhythms = [
    [[0, 1.5], [1.5, 0.5], [2, 1], [3, 1], [4, 1.5], [5.5, 0.5], [6, 2]],
    [[0, 1], [1, 0.5], [1.5, 1.5], [3, 1], [4, 2], [6, 1], [7, 1]],
    [[0.5, 0.5], [1, 1], [2, 1.5], [3.5, 0.5], [4, 1], [5, 1], [6, 2]],
  ];
  const rhythm = rhythms[Math.floor(random() * rhythms.length)];
  // Steps through the chord's notes (0 = root), so the shape survives the chord under it.
  let step = 2;
  const steps = rhythm.map(() => {
    step = Math.max(0, Math.min(4, step + [-1, -1, 0, 1, 1, 2][Math.floor(random() * 6)]));
    return step;
  });
  return rhythm.map(([beat, len], i) => ({ beat, len, step: steps[i] }));
}

function compose(opts, inst, buses, random) {
  const mood = MOODS[opts.mood];
  const duration = opts.durationSecs;
  const bpm = opts.bpm ?? mood.bpm;
  const { beats, markers } = beatGrid(bpm, duration, opts.cuts ?? []);
  const at = (beat) => {
    const i = Math.floor(beat);
    const a = beats[Math.min(i, beats.length - 1)];
    const b = beats[Math.min(i + 1, beats.length - 1)];
    return a + (b - a) * (beat - i);
  };
  const beatSecs = 60 / bpm;
  const barSecs = beatSecs * BEATS_PER_BAR;
  // The last chord rings under the end: at least one full bar, and never less than 3 s.
  const tail = Math.max(3, barSecs);
  let totalBars = 0;
  while (at((totalBars + 1) * BEATS_PER_BAR) <= duration - tail) totalBars++;
  totalBars = Math.max(1, totalBars);
  const sections = arrange(totalBars);
  const chords = mood.chords;
  const motif = makeMotif(random);
  const human = (amount = 0.006) => (random() - 0.5) * 2 * amount;
  const kicks = [];
  const { pad, keys, arp, bass, drums, fx } = buses;

  const sectionOf = (bar) => sections.find((s) => bar >= s.startBar && bar < s.startBar + s.bars) ?? sections.at(-1);

  for (let bar = 0; bar < totalBars; bar++) {
    const section = sectionOf(bar);
    const e = section.energy;
    const t0 = bar * BEATS_PER_BAR;
    const chordDef = chords[bar % chords.length];
    const notes = chordNotes(mood.root, chordDef);
    const rootMidi = mood.root + chordDef[0];
    const barLen = at(t0 + BEATS_PER_BAR) - at(t0);
    // Voicing around the middle of the keyboard, whatever the chord's root.
    const voiced = notes.map((n) => {
      let v = n + 24;
      while (v > 72) v -= 12;
      return v;
    });

    voiced.forEach((n, i) => {
      const voice = inst.padVoice(n, barLen + 1.1, 0.22 + e * 0.7);
      // Quieter in the sparse parts: the arc has to be heard in level, not just in what's playing.
      pad.add(voice, at(t0), 0.12 + 0.24 * e, (i / Math.max(1, voiced.length - 1) - 0.5) * 0.7);
    });
    if (e <= 0.25) {
      pad.add(inst.padVoice(rootMidi + 12, barLen + 1.1, 0.1), at(t0), 0.24, 0);
    }

    // The moving part, thinner the less energy there is.
    const stepsPerBar = e >= 0.75 ? 8 : e >= 0.4 ? 8 : 4;
    const pattern = [0, 2, 1, 2, 3, 2, 1, 2];
    const octave = e >= 0.4 ? 12 : 0;
    if (mood.lead !== "none" || mood.kit === "toms") {
      for (let i = 0; i < stepsPerBar; i++) {
        const v = voiced[pattern[i % pattern.length] % voiced.length] + octave;
        const when = at(t0 + (i * BEATS_PER_BAR) / stepsPerBar) + human(0.004);
        const strong = i % (stepsPerBar / 4) === 0;
        const vel = (strong ? 0.75 : 0.5) + random() * 0.1;
        const side = Math.sin(i * 1.7) * 0.45;
        if (mood.lead === "piano") arp.add(inst.piano(v, vel * 0.85), when, 0.3 + e * 0.15, side);
        else if (mood.lead === "mallet") arp.add(inst.mallet(v), when, 0.22 + e * 0.14, side);
        else arp.add(inst.pluck(v, 0.7, 0.45 + e * 0.35), when, (0.34 + e * 0.2) * vel, side);
      }
    }

    if (e >= 0.4 && mood.kit !== "none") {
      for (let i = 0; i < 8; i++) {
        if (e < 0.75 && i % 2) continue;
        const note = rootMidi + (i === 3 || i === 6 ? 12 : 0);
        const span = (at(t0 + (i + 1) / 2) - at(t0 + i / 2)) * (e < 0.75 ? 1.8 : 0.9);
        bass.add(inst.bass(note, span), at(t0 + i / 2), 0.27);
      }
    } else if (e >= 0.2) {
      bass.add(inst.bass(rootMidi, barLen * 0.9), at(t0), 0.2);
    }

    if (mood.kit === "four" || mood.kit === "pop") {
      if (e >= 0.75) {
        for (let i = 0; i < 4; i++) {
          kicks.push(at(t0 + i));
          drums.add(inst.kick(), at(t0 + i), 0.46);
        }
        for (const b of [1, 3]) {
          const hit = mood.kit === "pop" ? inst.clap() : inst.snare();
          drums.add(hit, at(t0 + b) + human(), 0.62, 0.05);
        }
        for (let i = 0; i < 16; i++) {
          drums.add(inst.hat(), at(t0 + i / 4) + human(0.003), (i % 2 ? 0.75 : 0.42) + random() * 0.08, -0.15);
        }
        drums.add(inst.hat(true), at(t0 + 3.5), 0.42, 0.2);
      } else if (e >= 0.4) {
        for (const b of [0, 2]) {
          kicks.push(at(t0 + b));
          drums.add(inst.kick(), at(t0 + b), 0.42);
        }
        for (let i = 0; i < 8; i++) drums.add(inst.shaker(), at(t0 + i / 2) + human(), i % 2 ? 0.5 : 0.28, 0.2);
      }
    } else if (mood.kit === "toms" && e >= 0.4) {
      const hits = e >= 0.75 ? [0, 1.5, 2, 3, 3.5] : [0, 2.5];
      hits.forEach((b, i) => {
        kicks.push(at(t0 + b));
        drums.add(inst.tom(i % 2 ? 110 : 82), at(t0 + b) + human(), 0.42, i % 2 ? 0.22 : -0.22);
      });
    }

    if (e >= 0.75 && mood.lead !== "none") {
      // Two bars of motif, every other pair silent: a bed mustn't compete with the voice over it.
      const phrase = Math.floor((bar - section.startBar) / 2);
      if (phrase % 2 === 0) {
        const inPhrase = (bar - section.startBar) % 2;
        for (const n of motif) {
          const local = n.beat - inPhrase * BEATS_PER_BAR;
          if (local < 0 || local >= BEATS_PER_BAR) continue;
          const pitch = voiced[n.step % voiced.length] + (n.step >= voiced.length ? 24 : 12);
          const when = at(t0 + local) + human();
          if (mood.lead === "piano") keys.add(inst.piano(pitch, 0.72), when, 0.34, 0.08);
          else if (mood.lead === "mallet") keys.add(inst.mallet(pitch), when, 0.3, 0.08);
          else keys.add(inst.pluck(pitch, Math.max(0.5, n.len * beatSecs + 0.4), 0.6), when, 0.34, 0.08);
        }
      }
    }
    emit({ type: "progress", stage: "rendering", progress: (0.6 * (bar + 1)) / totalBars, renderedFrames: bar + 1, totalFrames: totalBars });
  }

  // Section changes are announced by a rise and land on a hit.
  for (const s of sections.slice(1)) {
    if (s.energy < 0.6) continue;
    const when = at(s.startBar * BEATS_PER_BAR);
    const rise = Math.min(barSecs, 3);
    fx.add(inst.riser(rise), when - rise, 0.55, 0);
    fx.add(inst.impact(), when, 0.34, 0);
  }
  // The final chord rings out on the tonic, whatever the chord pattern was doing.
  const finalAt = at(totalBars * BEATS_PER_BAR);
  const tonic = chordNotes(mood.root, chords[0]);
  const ringSecs = Math.max(0.5, duration - finalAt + 1);
  for (const [i, n] of tonic.entries()) {
    pad.add(inst.padVoice(n + 24, ringSecs, 0.28), finalAt, 0.32, (i / tonic.length - 0.5) * 0.7);
  }
  bass.add(inst.bass(mood.root + 12, Math.min(ringSecs, 2.2)), finalAt, 0.32);
  for (const [i, n] of [tonic[0] + 36, tonic[2] + 36, tonic[0] + 48].entries()) {
    keys.add(inst.piano(n, 0.55), finalAt + i * 0.09, 0.26, (i - 1) * 0.3);
  }
  if (sections.at(-2)?.energy > 0.5 || totalBars > 4) fx.add(inst.impact(2.6), finalAt, 0.3, 0);

  // Video cuts get a light accent, spaced out so a fast edit doesn't turn into a drum solo.
  let lastAccent = -Infinity;
  for (const m of markers) {
    if (m.t < barSecs || m.t > finalAt - beatSecs || m.t - lastAccent < barSecs) {
      m.kind = "cut";
      continue;
    }
    m.kind = "accent";
    lastAccent = m.t;
    fx.add(inst.riser(beatSecs * 2), m.t - beatSecs * 2, 0.28, 0);
    fx.add(inst.impact(1.1), m.t, 0.16, 0);
  }

  const round3 = (n) => Math.round(n * 1000) / 1000;
  return {
    bpm,
    kicks,
    markers,
    finalAt: round3(finalAt),
    beatSecs,
    sections: sections.map((s) => ({
      name: s.name,
      startSecs: round3(at(s.startBar * BEATS_PER_BAR)),
      endSecs: round3(at((s.startBar + s.bars) * BEATS_PER_BAR)),
      energy: s.energy,
    })),
    barTimes: Array.from({ length: totalBars + 1 }, (_, i) => round3(at(i * BEATS_PER_BAR))),
  };
}

function mix(buses, score, durationSecs) {
  const { pad, keys, arp, bass, drums, fx } = buses;
  pingPong(arp, score.beatSecs * 0.75, 0.34, 0.22);
  pingPong(keys, score.beatSecs * 0.75, 0.36, 0.3);
  setWidth(pad, 1.25);
  sidechain(pad, score.kicks, 0.4);
  sidechain(arp, score.kicks, 0.3);
  sidechain(bass, score.kicks, 0.5, 0.07);

  const send = new Bus(pad.length);
  pad.mixInto(send, 0.28);
  keys.mixInto(send, 0.4);
  arp.mixInto(send, 0.26);
  fx.mixInto(send, 0.45);
  drums.mixInto(send, 0.05);
  const room = reverb(send, 2.4);

  const out = new Bus(pad.length);
  pad.mixInto(out, 1);
  keys.mixInto(out, 1);
  arp.mixInto(out, 1);
  bass.mixInto(out, 1);
  drums.mixInto(out, 0.9);
  fx.mixInto(out, 0.9);
  room.mixInto(out, 0.34);

  const n = Math.round(durationSecs * SR);
  const fadeIn = Math.round(0.35 * SR);
  for (let i = 0; i < fadeIn && i < n; i++) {
    out.l[i] *= i / fadeIn;
    out.r[i] *= i / fadeIn;
  }
  const fadeOut = Math.min(n, Math.round(1.6 * SR));
  for (let i = 0; i < fadeOut; i++) {
    const g = ((fadeOut - i) / fadeOut) ** 2;
    out.l[n - fadeOut + i] *= g;
    out.r[n - fadeOut + i] *= g;
  }
  const trimmed = new Bus(n);
  trimmed.l.set(out.l.subarray(0, n));
  trimmed.r.set(out.r.subarray(0, n));
  return trimmed;
}

/** Renders the bed to `opts.output` and describes it. */
export function renderMusic(opts) {
  if (!MOODS[opts.mood]) {
    throw new Error(`Unknown mood "${opts.mood}". Use one of: ${Object.keys(MOODS).join(", ")}.`);
  }
  const durationSecs = Number(opts.durationSecs);
  if (!(durationSecs >= 4 && durationSecs <= 900)) {
    throw new Error("durationSecs must be between 4 and 900.");
  }
  if (opts.bpm !== undefined && !(opts.bpm >= 40 && opts.bpm <= 200)) {
    throw new Error("bpm must be between 40 and 200.");
  }
  const seed = opts.seed ?? 1;
  const random = seededRandom(seed);
  const inst = makeInstruments(random);
  // Past the end by a bar, so a note that rings over the end isn't cut mid-buffer.
  const samples = Math.round((durationSecs + 4) * SR);
  const buses = Object.fromEntries(["pad", "keys", "arp", "bass", "drums", "fx"].map((k) => [k, new Bus(samples)]));
  const score = compose({ ...opts, durationSecs }, inst, buses, random);
  emit({ type: "progress", stage: "encoding", progress: 0.65 });
  const final = mix(buses, score, durationSecs);
  master(final, { targetLufs: opts.targetLufs ?? -16 });
  const stats = analyze(final);
  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  fs.writeFileSync(opts.output, wavBytes(final));
  return {
    output: opts.output,
    mood: opts.mood,
    seed,
    bpm: score.bpm,
    durationSecs,
    sections: score.sections,
    barTimes: score.barTimes,
    finalChordSecs: score.finalAt,
    markers: score.markers.map((m) => ({ requested: m.requested, t: m.t, offsetSecs: m.offsetSecs, kind: m.kind })),
    ducking: duckingCurve(opts.voiceRanges, { durationSecs, duckTo: opts.duckTo }),
    stats,
    warnings: qualityWarnings(stats),
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runTask(async () => {
    const { opts } = readRequest();
    if (!opts.output) throw new Error("Missing output.");
    const started = Date.now();
    const result = renderMusic(opts);
    emit({ type: "done", ...result, elapsedMs: Date.now() - started });
  });
}
