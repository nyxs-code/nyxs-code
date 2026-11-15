import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { createWebFetchTool } from "./WebFetch/tool";
import type { ToolContext } from "./context";
import {
  fetchYouTubeVideo,
  formatTimestamp,
  formatTranscript,
  formatYouTubeVideo,
  parseCaptionXml,
  parseJson3,
  pickCaptionTrack,
  youTubeVideoId,
  type CaptionTrack,
} from "./youtube";

const ID = "dQw4w9WgXcQ";

type Route = { ok?: boolean; status?: number; body: string };
type Call = { url: string; method: string; body?: string };

/** A fetch that answers by address: the player API, then each caption format. */
function fakeYouTube(routes: { player: Route | string; json3?: Route | string; xml?: Route | string }) {
  const calls: Call[] = [];
  const pick = (url: string) => (url.includes("/youtubei/v1/player") ? routes.player : url.includes("fmt=json3") ? routes.json3 : routes.xml);
  const impl = async (url: string, init: { method: string; body?: string }) => {
    calls.push({ url, method: init.method, body: init.body });
    const r = pick(url);
    const route: Route = r === undefined ? { ok: false, status: 404, body: "" } : typeof r === "string" ? { body: r } : r;
    return { ok: route.ok ?? true, status: route.status ?? 200, text: async () => route.body };
  };
  return { impl, calls };
}

const track = (languageCode: string, kind?: string): CaptionTrack => ({
  baseUrl: `https://www.youtube.com/api/timedtext?v=${ID}&lang=${languageCode}${kind ? "&kind=asr" : ""}&fmt=srv3`,
  languageCode,
  kind,
});

const playerBody = (extra: object = {}) =>
  JSON.stringify({
    playabilityStatus: { status: "OK" },
    videoDetails: { title: "Never Gonna Give You Up", author: "Rick Astley", shortDescription: "The official video.", lengthSeconds: "213" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          { ...track("en"), name: { simpleText: "English" } },
          { ...track("es-419"), name: { simpleText: "Spanish (Latin America)" } },
          { ...track("en", "asr"), name: { simpleText: "English (auto-generated)" } },
        ],
      },
    },
    ...extra,
  });

const json3 = JSON.stringify({
  events: [
    { tStartMs: 1360, segs: [{ utf8: "[♪♪♪]" }] },
    { tStartMs: 18640, segs: [{ utf8: "We're no " }, { utf8: "strangers\nto love" }] },
    { tStartMs: 20000, segs: [{ utf8: "\n" }] },
    { tStartMs: 62000, segs: [{ utf8: "Never gonna give you up" }] },
  ],
});

describe("youTubeVideoId", () => {
  it("reads every kind of video address", () => {
    for (const url of [
      `https://www.youtube.com/watch?v=${ID}`,
      `https://www.youtube.com/watch?feature=share&v=${ID}&t=42s`,
      `https://m.youtube.com/watch?v=${ID}`,
      `https://music.youtube.com/watch?v=${ID}&list=RD`,
      `https://youtu.be/${ID}?si=abc`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://www.youtube.com/embed/${ID}`,
      `https://www.youtube.com/live/${ID}?feature=shared`,
      `https://www.youtube-nocookie.com/embed/${ID}`,
      `youtu.be/${ID}`,
    ]) {
      expect(youTubeVideoId(url), url).toBe(ID);
    }
  });

  it("ignores pages that aren't one video", () => {
    for (const url of ["https://www.youtube.com/@RickAstleyYT", "https://www.youtube.com/results?search_query=x", "https://example.com/watch?v=dQw4w9WgXcQ", `https://www.youtube.com/watch?v=short`, "not a url"]) {
      expect(youTubeVideoId(url), url).toBeNull();
    }
  });
});

describe("pickCaptionTrack", () => {
  const tracks = [track("en"), track("es-419"), track("en", "asr"), track("fr", "asr")];

  it("prefers a hand-made track in the user's language, matching its regional variants", () => {
    expect(pickCaptionTrack(tracks, ["es-ES", "en"])?.languageCode).toBe("es-419");
  });

  it("takes the generated track of a preferred language before a less preferred hand-made one", () => {
    expect(pickCaptionTrack(tracks, ["fr-FR", "en"])).toMatchObject({ languageCode: "fr", kind: "asr" });
  });

  it("falls back to any hand-made track, then to any track", () => {
    expect(pickCaptionTrack(tracks, ["ja"])?.languageCode).toBe("en");
    expect(pickCaptionTrack([track("de", "asr")], ["ja"])?.languageCode).toBe("de");
    expect(pickCaptionTrack([], ["en"])).toBeNull();
  });
});

describe("caption parsing", () => {
  it("reads json3 and skips empty cues", () => {
    expect(parseJson3(json3)).toEqual([
      { startMs: 1360, text: "[♪♪♪]" },
      { startMs: 18640, text: "We're no strangers to love" },
      { startMs: 62000, text: "Never gonna give you up" },
    ]);
    expect(parseJson3("")).toEqual([]);
  });

  it("reads the XML format, unescaping its doubly escaped text", () => {
    const xml = `<?xml version="1.0" encoding="utf-8" ?><transcript><text start="1.36" dur="1.68">[♪♪♪]</text><text start="18.64" dur="3.24">♪ We&amp;#39;re no strangers
to love ♪</text></transcript>`;
    expect(parseCaptionXml(xml)).toEqual([
      { startMs: 1360, text: "[♪♪♪]" },
      { startMs: 18640, text: "♪ We're no strangers to love ♪" },
    ]);
  });

  it("marks the time about every 30 seconds", () => {
    expect(formatTimestamp(62_000)).toBe("1:02");
    expect(formatTimestamp(3_723_000)).toBe("1:02:03");
    expect(formatTranscript(parseJson3(json3))).toBe("[0:01] [♪♪♪] We're no strangers to love\n[1:02] Never gonna give you up");
  });
});

describe("fetchYouTubeVideo", () => {
  it("asks the player API as the Android client and reads the chosen track as json3", async () => {
    const yt = fakeYouTube({ player: playerBody(), json3 });
    const video = await fetchYouTubeVideo(ID, ["es-ES", "en"], yt.impl);
    expect(yt.calls[0]).toMatchObject({ method: "POST" });
    expect(JSON.parse(yt.calls[0].body!)).toMatchObject({ videoId: ID, context: { client: { clientName: "ANDROID", hl: "es-ES" } } });
    expect(yt.calls[1].url).toContain("lang=es-419");
    expect(yt.calls[1].url).toMatch(/&fmt=json3$/);
    expect(yt.calls[1].url).not.toContain("fmt=srv3");
    expect(video).toMatchObject({
      title: "Never Gonna Give You Up",
      author: "Rick Astley",
      lengthSeconds: 213,
      transcript: { languageCode: "es-419", name: "Spanish (Latin America)", generated: false },
    });
    const text = formatYouTubeVideo(video!);
    expect(text).toContain("Channel: Rick Astley\nLength: 3:33\nDescription: The official video.");
    expect(text).toContain("Transcript (Spanish (Latin America), captions; [m:ss] marks the time in the video):\n[0:01] [♪♪♪]");
  });

  it("falls back to the XML format when json3 comes back empty", async () => {
    const yt = fakeYouTube({ player: playerBody(), json3: "", xml: `<transcript><text start="5">Hello</text></transcript>` });
    const video = await fetchYouTubeVideo(ID, ["en"], yt.impl);
    expect(video?.transcript?.text).toBe("[0:05] Hello");
  });

  it("says so when the video has no captions or they can't be downloaded", async () => {
    const none = await fetchYouTubeVideo(ID, ["en"], fakeYouTube({ player: playerBody({ captions: undefined }) }).impl);
    expect(none?.transcript).toBeUndefined();
    expect(formatYouTubeVideo(none!)).toContain("The video has no captions");

    const empty = await fetchYouTubeVideo(ID, ["en"], fakeYouTube({ player: playerBody(), json3: "", xml: "" }).impl);
    expect(formatYouTubeVideo(empty!)).toContain("The video has captions (en, es-419, en) but they couldn't be downloaded.");
  });

  it("keeps the details of a video behind an age check", async () => {
    const player = playerBody({ playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm your age" }, captions: undefined });
    const video = await fetchYouTubeVideo(ID, ["en"], fakeYouTube({ player }).impl);
    expect(video?.unplayable).toBe("Sign in to confirm your age");
    expect(formatYouTubeVideo(video!)).toContain("YouTube won't play it here: Sign in to confirm your age");
  });

  it("gives up (so the page is read instead) when YouTube doesn't know the video", async () => {
    const removed = JSON.stringify({ playabilityStatus: { status: "ERROR", reason: "This video is unavailable" } });
    expect(await fetchYouTubeVideo(ID, ["en"], fakeYouTube({ player: removed }).impl)).toBeNull();
    expect(await fetchYouTubeVideo(ID, ["en"], fakeYouTube({ player: { ok: false, status: 429, body: "" } }).impl)).toBeNull();
    expect(await fetchYouTubeVideo(ID, ["en"], fakeYouTube({ player: "<html>consent</html>" }).impl)).toBeNull();
  });
});

describe("WebFetch of a YouTube video", () => {
  type Execute = (input: { url: string; prompt: string }, opts: { abortSignal?: AbortSignal }) => Promise<string>;
  const run = (ctx: Partial<ToolContext>, url: string, prompt = "what is said") =>
    (createWebFetchTool(ctx as ToolContext).execute as unknown as Execute)({ url, prompt }, {});

  const respondWith = (routes: Parameters<typeof fakeYouTube>[0]) => {
    const yt = fakeYouTube(routes);
    vi.mocked(tauriFetch).mockImplementation((async (url: string, init: { method: string; body?: string }) => {
      const r = await yt.impl(String(url), init);
      return { ...r, headers: new Headers({ "content-type": "text/html" }) };
    }) as unknown as typeof tauriFetch);
    return yt;
  };

  it("returns the transcript for a short link", async () => {
    respondWith({ player: playerBody(), json3 });
    const out = await run({}, `https://youtu.be/${ID}`);
    expect(out).toContain("Title: Never Gonna Give You Up");
    expect(out).toContain("[1:02] Never gonna give you up");
  });

  it("hands a long transcript to the helper model with the prompt", async () => {
    const long = JSON.stringify({ events: Array.from({ length: 400 }, (_, i) => ({ tStartMs: i * 5000, segs: [{ utf8: `line number ${i} of the talk` }] })) });
    respondWith({ player: playerBody(), json3: long });
    const extract = vi.fn(async (_prompt: string, text: string) => `The talk is ${text.length} characters long.`);
    const out = await run({ extract }, `https://www.youtube.com/shorts/${ID}`, "the main points");
    expect(extract).toHaveBeenCalledWith("the main points", expect.stringContaining("[0:30] line number 6"), expect.any(AbortSignal));
    expect(out).toContain('what the video says about "the main points"');
  });

  it("reads the watch page as before when YouTube's player API doesn't answer", async () => {
    respondWith({
      player: { ok: false, status: 403, body: "" },
      xml: `<html><head><title>Never Gonna Give You Up - YouTube</title></head><body>page</body></html>`,
    });
    const out = await run({}, `https://www.youtube.com/watch?v=${ID}`);
    expect(out).toContain("Title: Never Gonna Give You Up - YouTube");
  });
});

/** Against the real YouTube: `NYXS_LIVE_YOUTUBE=1 npx vitest run src/tools/youtube.test.ts`. */
describe.runIf(process.env.NYXS_LIVE_YOUTUBE)("live YouTube", () => {
  it("reads the transcript of a real video", async () => {
    const live = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => globalThis.fetch(url, init);
    const video = await fetchYouTubeVideo("jNQXAC9IVRw", ["en"], live);
    expect(video?.title).toBe("Me at the zoo");
    expect(video?.transcript?.text).toMatch(/elephants/i);
  }, 30_000);
});
