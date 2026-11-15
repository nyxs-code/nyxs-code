// The score of a generated music bed, as plain data: the beat grid, the sections and the ducking
// keyframes. No audio here, so all of it can be tested without rendering anything.

/** How far a stretch of music may leave the tempo to land a cut exactly on a beat. Beyond this the
 *  change is audible, so the cut snaps to the nearest beat and reports how far off it is. */
const MAX_TEMPO_DRIFT = 0.03;
/** Cuts closer than this to the previous one are accents on the same beat: the grid can't follow. */
const MIN_ANCHOR_BEATS = 4;

export const MOODS = {
  confident: { bpm: 110, root: 38, minor: true, chords: [[0, "m"], [8, "M"], [3, "M"], [10, "M"]], kit: "four", lead: "pluck" },
  uplifting: { bpm: 118, root: 36, minor: false, chords: [[0, "M"], [7, "M"], [9, "m"], [5, "M"]], kit: "pop", lead: "piano" },
  calm: { bpm: 76, root: 41, minor: false, chords: [[0, "M7"], [9, "m7"], [5, "M7"], [7, "sus"]], kit: "none", lead: "piano" },
  tense: { bpm: 92, root: 38, minor: true, chords: [[0, "m"], [0, "m"], [8, "M"], [7, "sus"]], kit: "toms", lead: "none" },
  playful: { bpm: 124, root: 43, minor: false, chords: [[0, "M"], [5, "M"], [9, "m"], [7, "M"]], kit: "pop", lead: "mallet" },
  ambient: { bpm: 64, root: 40, minor: false, chords: [[0, "M7"], [5, "M7"], [9, "m7"], [4, "m7"]], kit: "none", lead: "none" },
};

const QUALITY = { M: [0, 4, 7], m: [0, 3, 7], M7: [0, 4, 7, 11], m7: [0, 3, 7, 10], sus: [0, 5, 7] };

/** The notes of a chord as MIDI numbers, built from a mood's root. */
export function chordNotes(root, [offset, quality]) {
  return QUALITY[quality].map((i) => root + offset + i);
}

/**
 * Beat times from the tempo and the cuts: between two anchored cuts the tempo bends just enough for
 * a whole number of beats to fit. Returns the grid and what happened to every cut.
 */
export function beatGrid(bpm, durationSecs, cuts = []) {
  const beat = 60 / bpm;
  const sorted = [...new Set(cuts)].filter((c) => c > 0 && c < durationSecs).sort((a, b) => a - b);
  const anchors = [{ t: 0 }];
  const markers = [];
  for (const requested of sorted) {
    const prev = anchors.at(-1).t;
    const span = requested - prev;
    const beats = Math.round(span / beat);
    const drift = beats > 0 ? Math.abs(span / beats / beat - 1) : Infinity;
    if (beats >= MIN_ANCHOR_BEATS && drift <= MAX_TEMPO_DRIFT) {
      anchors.push({ t: requested, beats });
    }
    markers.push({ requested });
  }
  const beats = [];
  for (let a = 1; a < anchors.length; a++) {
    const { t, beats: n } = anchors[a];
    const from = anchors[a - 1].t;
    for (let i = 0; i < n; i++) beats.push(from + ((t - from) * i) / n);
  }
  // A little past the end, so a pattern never asks for a beat that isn't there.
  for (let t = anchors.at(-1).t; t < durationSecs + beat * 8; t += beat) beats.push(t);
  for (const m of markers) {
    const i = nearestIndex(beats, m.requested);
    m.t = round3(beats[i]);
    m.beat = i;
    m.offsetSecs = round3(m.t - m.requested);
  }
  return { beats, markers };
}

function nearestIndex(sorted, t) {
  let lo = 0;
  let hi = sorted.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= t) lo = mid;
    else hi = mid;
  }
  return t - sorted[lo] <= sorted[hi] - t ? lo : hi;
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/** The arc of a piece, in bars: how much of it plays when. Energy runs 0..1. */
export function arrange(totalBars) {
  const parts = [
    ["intro", 0.1, 0.2],
    ["build", 0.14, 0.45],
    ["main", 0.26, 0.8],
    ["break", 0.1, 0.35],
    ["lift", 0.3, 1],
    ["outro", 0.1, 0.25],
  ];
  const sections = [];
  let bar = 0;
  parts.forEach(([name, share, energy], i) => {
    const left = totalBars - bar;
    // Whole phrases of 2 bars where they fit; the last part takes what remains.
    let bars = i === parts.length - 1 ? left : Math.max(1, Math.round((share * totalBars) / 2) * 2);
    bars = Math.min(bars, left);
    if (bars > 0) {
      sections.push({ name, startBar: bar, bars, energy });
      bar += bars;
    }
  });
  return sections;
}

/**
 * A volume curve for a music clip: down under each voice range with a lead-in and a release. Ranges
 * closer than `mergeGapSecs` stay ducked between them, since pumping between words is distracting.
 */
export function duckingCurve(voiceRanges, { duckTo = 0.25, attackSecs = 0.25, releaseSecs = 0.6, mergeGapSecs = 1.2, durationSecs } = {}) {
  const sorted = (voiceRanges ?? []).filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  if (!sorted.length) return [];
  const merged = [];
  for (const [s, e] of sorted) {
    const last = merged.at(-1);
    if (last && s - last[1] < mergeGapSecs + attackSecs + releaseSecs) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  const curve = [];
  const push = (t, value) => {
    const clamped = Math.max(0, durationSecs ? Math.min(t, durationSecs) : t);
    if (curve.at(-1)?.t !== round3(clamped)) curve.push({ t: round3(clamped), value });
  };
  for (const [s, e] of merged) {
    if (s - attackSecs > 0) push(s - attackSecs, 1);
    push(s, duckTo);
    push(e, duckTo);
    push(e + releaseSecs, 1);
  }
  return curve;
}
