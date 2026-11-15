import { beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => ({ timeline: "", written: [] as string[] }));

vi.mock("@/lib/video/videoApi", () => ({
  readTimeline: vi.fn(async () => files.timeline),
  writeTimeline: vi.fn(async (_w: string, _s: string, json: string) => {
    files.written.push(json);
    files.timeline = json;
  }),
  extractAudio: vi.fn(async () => "C:/cache/audio.wav"),
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `asset://${p}`, invoke: vi.fn() }));

import { encodeWavBase64 } from "@/lib/transcribe";
import {
  SAMPLE_RATE,
  decodeWav,
  estimateWordTimings,
  generateCaptions,
  insertCaptionsClip,
  parseBackendWords,
  planChunks,
  resampleLinear,
  toCaptions,
  transcribeSamples,
  voicedRanges,
  buildCaptionsClip,
  type ChunkTranscriber,
} from "@/lib/video/captions";
import { emptyTimeline, validateTimeline, type Timeline } from "@/lib/video/timelineSchema";

/** Silence with a tone in each [startSec, endSec] range. */
function speechLike(totalSec: number, voiced: [number, number][], rate = SAMPLE_RATE): Float32Array {
  const out = new Float32Array(Math.round(totalSec * rate));
  for (const [s, e] of voiced) {
    for (let i = Math.round(s * rate); i < Math.min(out.length, Math.round(e * rate)); i++) out[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / rate);
  }
  return out;
}

function wavBytes(samples: Float32Array, rate: number): ArrayBuffer {
  const bin = atob(encodeWavBase64(samples, rate));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function timelineWithVideo(): Timeline {
  const t = emptyTimeline({ width: 1920, height: 1080, fps: 30, durationInFrames: 300 });
  t.assets.push({ id: "a1", kind: "video", src: "media/talk.mp4", name: "talk.mp4", durationInFrames: 600, fps: 30 });
  t.compositions[0].tracks = [
    {
      id: "v1",
      name: "Video",
      kind: "video",
      clips: [{ id: "clip1", type: "video", assetId: "a1", from: 30, durationInFrames: 150, trimStart: 60 }],
    },
  ];
  return t;
}

describe("decodeWav", () => {
  it("reads back what encodeWavBase64 writes", () => {
    const src = speechLike(0.5, [[0.1, 0.3]]);
    const { samples, sampleRate } = decodeWav(wavBytes(src, SAMPLE_RATE));
    expect(sampleRate).toBe(SAMPLE_RATE);
    expect(samples.length).toBe(src.length);
    expect(Math.abs(samples[2000] - src[2000])).toBeLessThan(1e-3);
  });

  it("rejects files that aren't WAV", () => {
    expect(() => decodeWav(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).buffer)).toThrow();
  });
});

describe("resampleLinear", () => {
  it("changes the length by the rate ratio", () => {
    expect(resampleLinear(new Float32Array(48000), 48000, 16000).length).toBe(16000);
  });
});

describe("planChunks", () => {
  it("keeps short audio in one chunk", () => {
    expect(planChunks(new Float32Array(SAMPLE_RATE * 10), SAMPLE_RATE)).toEqual([{ start: 0, end: SAMPLE_RATE * 10 }]);
  });

  it("cuts long audio at a quiet moment, within the limits", () => {
    // Speech everywhere except a pause at 15–16 s.
    const audio = speechLike(40, [[0, 15], [16, 40]]);
    const chunks = planChunks(audio, SAMPLE_RATE);
    expect(chunks[0].start).toBe(0);
    const cut = chunks[0].end / SAMPLE_RATE;
    expect(cut).toBeGreaterThanOrEqual(15);
    expect(cut).toBeLessThanOrEqual(16);
    for (const c of chunks) expect((c.end - c.start) / SAMPLE_RATE).toBeLessThanOrEqual(25);
    expect(chunks[chunks.length - 1].end).toBe(audio.length);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].start).toBe(chunks[i - 1].end);
  });
});

describe("voicedRanges", () => {
  it("finds the voiced stretches", () => {
    const ranges = voicedRanges(speechLike(3, [[0.5, 1], [2, 2.5]]), SAMPLE_RATE);
    expect(ranges).toHaveLength(2);
    expect(ranges[0][0]).toBeGreaterThanOrEqual(450);
    expect(ranges[0][1]).toBeLessThanOrEqual(1050);
    expect(ranges[1][0]).toBeGreaterThanOrEqual(1950);
  });
});

describe("estimateWordTimings", () => {
  it("spreads words over the voiced ranges only, in order", () => {
    const words = estimateWordTimings("hello there big world", 4000, [[0, 1000], [3000, 4000]]);
    expect(words.map((w) => w.text)).toEqual(["hello", "there", "big", "world"]);
    for (const w of words) {
      expect(w.endMs).toBeGreaterThanOrEqual(w.startMs);
      // No word starts in the silent middle.
      expect(w.startMs < 1000 || w.startMs >= 3000).toBe(true);
    }
    expect(words[0].startMs).toBe(0);
    expect(words[3].endMs).toBe(4000);
  });

  it("uses the whole span when nothing is voiced", () => {
    const words = estimateWordTimings("one two", 1000);
    expect(words[0].startMs).toBe(0);
    expect(words[1].endMs).toBe(1000);
  });
});

describe("parseBackendWords", () => {
  it("reads Whisper-style seconds and shifts them", () => {
    expect(parseBackendWords({ words: [{ word: " Hi", start: 0.5, end: 0.9, probability: 0.8 }] }, 1000)).toEqual([
      { text: "Hi", startMs: 1500, endMs: 1900, confidence: 0.8 },
    ]);
  });

  it("returns null for a text-only response", () => {
    expect(parseBackendWords({ text: "hello" })).toBeNull();
  });
});

describe("toCaptions", () => {
  it("follows Remotion's token convention and the playback rate", () => {
    const caps = toCaptions(
      [
        { text: "Hola", startMs: 0, endMs: 400 },
        { text: "mundo", startMs: 400, endMs: 1000 },
      ],
      0.5,
    );
    expect(caps.map((c) => c.text)).toEqual(["Hola", " mundo"]);
    expect(caps[1]).toMatchObject({ startMs: 200, endMs: 500, timestampMs: 350 });
  });
});

describe("insertCaptionsClip", () => {
  it("adds a Captions text track on top and keeps the timeline valid", () => {
    const t = timelineWithVideo();
    const clip = buildCaptionsClip({ from: 30, durationInFrames: 150 }, t.compositions[0], [{ text: "Hi", startMs: 0, endMs: 500 }]);
    const next = insertCaptionsClip(t, "Main", clip);
    const tracks = next.compositions[0].tracks;
    expect(tracks[tracks.length - 1]).toMatchObject({ name: "Captions", kind: "text" });
    expect(tracks[tracks.length - 1].clips[0].id).toBe(clip.id);
    expect(t.compositions[0].tracks).toHaveLength(1);
    const v = validateTimeline(next);
    expect(v.ok ? [] : v.errors).toEqual([]);
  });

  it("reuses a text track with room and opens a new one on overlap", () => {
    const t = timelineWithVideo();
    const comp = t.compositions[0];
    const a = buildCaptionsClip({ from: 0, durationInFrames: 60 }, comp, [{ text: "A", startMs: 0, endMs: 100 }]);
    const b = buildCaptionsClip({ from: 100, durationInFrames: 60 }, comp, [{ text: "B", startMs: 0, endMs: 100 }]);
    const c = buildCaptionsClip({ from: 120, durationInFrames: 30 }, comp, [{ text: "C", startMs: 0, endMs: 100 }]);
    const next = insertCaptionsClip(insertCaptionsClip(insertCaptionsClip(t, "Main", a), "Main", b), "Main", c);
    const text = next.compositions[0].tracks.filter((tr) => tr.kind === "text");
    expect(text).toHaveLength(2);
    expect(text[0].clips.map((x) => x.id)).toEqual([a.id, b.id]);
  });
});

describe("transcribeSamples", () => {
  it("estimates word times per chunk and offsets them", async () => {
    const audio = speechLike(40, [[1, 15], [16, 39]]);
    const calls: number[] = [];
    const transcribe: ChunkTranscriber = async (wav) => {
      calls.push(wav.length);
      return { text: calls.length === 1 ? "first chunk words" : "second chunk", words: null };
    };
    const { words, timing } = await transcribeSamples(audio, SAMPLE_RATE, { transcribe });
    expect(timing).toBe("estimated");
    expect(calls.length).toBe(2);
    expect(words.map((w) => w.text)).toEqual(["first", "chunk", "words", "second", "chunk"]);
    expect(words[0].startMs).toBeGreaterThanOrEqual(900);
    expect(words[3].startMs).toBeGreaterThanOrEqual(15000);
    for (let i = 1; i < words.length; i++) expect(words[i].startMs).toBeGreaterThanOrEqual(words[i - 1].startMs);
  });

  it("skips silent chunks without calling the backend", async () => {
    const transcribe = vi.fn<ChunkTranscriber>(async () => ({ text: "x", words: null }));
    const { words } = await transcribeSamples(new Float32Array(SAMPLE_RATE * 5), SAMPLE_RATE, { transcribe });
    expect(words).toEqual([]);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("uses the backend's word times when it sends them", async () => {
    const transcribe: ChunkTranscriber = async () => ({ text: "hi", words: [{ text: "hi", startMs: 1200, endMs: 1500 }] });
    const { words, timing } = await transcribeSamples(speechLike(3, [[1, 2]]), SAMPLE_RATE, { transcribe });
    expect(timing).toBe("backend");
    expect(words).toEqual([{ text: "hi", startMs: 1200, endMs: 1500 }]);
  });
});

describe("generateCaptions", () => {
  beforeEach(() => {
    files.timeline = JSON.stringify(timelineWithVideo());
    files.written = [];
    const wav = wavBytes(speechLike(5, [[0.5, 4.5]]), SAMPLE_RATE);
    vi.stubGlobal("fetch", vi.fn(async () => ({ arrayBuffer: async () => wav })));
  });

  it("writes a captions clip aligned with the source clip", async () => {
    const transcribe: ChunkTranscriber = async () => ({ text: "welcome to the launch", words: null });
    const res = await generateCaptions({ workspace: "C:/w", slug: "demo", compositionId: "Main", clipId: "clip1", transcribe });
    expect(res.words).toBe(4);
    expect(res.timing).toBe("estimated");
    expect(res.clip).toMatchObject({ type: "captions", from: 30, durationInFrames: 150, mode: "word-highlight" });
    expect(files.written).toHaveLength(1);
    const saved = validateTimeline(JSON.parse(files.written[0]));
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      const caps = saved.timeline.compositions[0].tracks.flatMap((t) => t.clips).find((c) => c.type === "captions");
      expect(caps?.type === "captions" && caps.captions.map((c) => c.text).join("")).toBe("welcome to the launch");
    }
  });

  it("refuses a clip that has no audio source", async () => {
    await expect(generateCaptions({ workspace: "C:/w", slug: "demo", compositionId: "Main", clipId: "nope" })).rejects.toThrow(/No video or audio clip/);
  });
});
