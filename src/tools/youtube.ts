import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { decodeHtmlEntities } from "@/tools/web";

/** What a YouTube video is and what is said in it, read through YouTube's player API. The watch
 *  page lists its caption tracks too, but their addresses there need a proof-of-origin token and
 *  come back empty; the ones the Android client gets download as they are. The player API also
 *  isn't behind the cookie-consent page some countries see. */

export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  /** "asr" for captions YouTube generated from the audio. */
  kind?: string;
  name?: string;
}

export interface Cue {
  startMs: number;
  text: string;
}

export interface YouTubeVideo {
  id: string;
  title: string;
  author: string;
  description: string;
  lengthSeconds: number;
  /** Why YouTube won't play it here (age check, private, removed), when it won't. */
  unplayable?: string;
  transcript?: { languageCode: string; name: string; generated: boolean; text: string };
  /** The caption languages the video has, for when none could be read. */
  captionLanguages: string[];
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

const YOUTUBE_HOST = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/i;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** The video id in a YouTube address: watch?v=, youtu.be/, /shorts/, /embed/, /live/, /v/. */
export function youTubeVideoId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return null;
  }
  if (!YOUTUBE_HOST.test(u.hostname)) return null;
  const segments = u.pathname.split("/").filter(Boolean);
  const candidate = /youtu\.be$/i.test(u.hostname)
    ? segments[0]
    : segments[0] === "watch"
      ? u.searchParams.get("v")
      : ["shorts", "embed", "live", "v"].includes(segments[0] ?? "")
        ? segments[1]
        : u.searchParams.get("v");
  return candidate && VIDEO_ID.test(candidate) ? candidate : null;
}

const base = (code: string) => code.toLowerCase().split(/[-_]/)[0];

/** The track to read: for each preferred language (most preferred first), a hand-made track and
 *  then a generated one; failing all, any hand-made track, then any. A generated track only
 *  exists in the language spoken in the video, so it beats a hand-made one in a language the
 *  user prefers less. */
export function pickCaptionTrack(tracks: CaptionTrack[], languages: string[]): CaptionTrack | null {
  const wanted = [...new Set(languages.filter(Boolean).map(base))];
  const manual = tracks.filter((t) => t.kind !== "asr");
  const generated = tracks.filter((t) => t.kind === "asr");
  for (const lang of wanted) {
    for (const group of [manual, generated]) {
      const exact = group.find((t) => t.languageCode.toLowerCase() === lang);
      const hit = exact ?? group.find((t) => base(t.languageCode) === lang);
      if (hit) return hit;
    }
  }
  return manual[0] ?? generated[0] ?? null;
}

/** Cues from the `fmt=json3` caption format. */
export function parseJson3(body: string): Cue[] {
  let data: { events?: { tStartMs?: number; segs?: { utf8?: string }[] }[] };
  try {
    data = JSON.parse(body) as typeof data;
  } catch {
    return [];
  }
  const cues: Cue[] = [];
  for (const ev of data.events ?? []) {
    const text = (ev.segs ?? [])
      .map((s) => s.utf8 ?? "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (text) cues.push({ startMs: ev.tStartMs ?? 0, text });
  }
  return cues;
}

/** Cues from the default XML caption format (`<text start="1.2">…</text>`). */
export function parseCaptionXml(body: string): Cue[] {
  const cues: Cue[] = [];
  for (const m of body.matchAll(/<text\b[^>]*\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g)) {
    // The text is escaped twice: once as XML and once as the HTML inside it.
    const text = decodeHtmlEntities(decodeHtmlEntities(m[2])).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (text) cues.push({ startMs: Math.round(Number(m[1]) * 1000), text });
  }
  return cues;
}

export function formatTimestamp(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The transcript as paragraphs, each starting with its time (`[1:30]`) about every
 *  `everyMs`, so the model can say where in the video something is said. */
export function formatTranscript(cues: Cue[], everyMs = 30_000): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  let start = -Infinity;
  for (const cue of cues) {
    if (cue.startMs - start >= everyMs) {
      if (current.length) paragraphs.push(current.join(" "));
      current = [`[${formatTimestamp(cue.startMs)}]`];
      start = cue.startMs;
    }
    current.push(cue.text);
  }
  if (current.length) paragraphs.push(current.join(" "));
  return paragraphs.join("\n");
}

const ANDROID_CLIENT = { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 34 };
const ANDROID_UA = "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip";

interface PlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  videoDetails?: { title?: string; author?: string; shortDescription?: string; lengthSeconds?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: { baseUrl?: string; languageCode?: string; kind?: string; name?: { simpleText?: string; runs?: { text?: string }[] } }[];
    };
  };
}

async function downloadCues(track: CaptionTrack, fetchImpl: FetchLike): Promise<Cue[]> {
  const url = track.baseUrl.replace(/&fmt=[^&]*/g, "");
  const headers = { "User-Agent": ANDROID_UA };
  const json = await fetchImpl(`${url}&fmt=json3`, { method: "GET", headers }).catch(() => null);
  const cues = json?.ok ? parseJson3(await json.text()) : [];
  if (cues.length) return cues;
  const xml = await fetchImpl(url, { method: "GET", headers }).catch(() => null);
  return xml?.ok ? parseCaptionXml(await xml.text()) : [];
}

/** The video's details and transcript, or null when YouTube didn't answer about it (the caller
 *  then reads the watch page as any other page). */
export async function fetchYouTubeVideo(
  id: string,
  languages: string[],
  fetchImpl: FetchLike = tauriFetch as unknown as FetchLike,
): Promise<YouTubeVideo | null> {
  let player: PlayerResponse;
  try {
    const res = await fetchImpl("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": ANDROID_UA },
      body: JSON.stringify({ context: { client: { ...ANDROID_CLIENT, hl: languages[0] ?? "en" } }, videoId: id }),
    });
    if (!res.ok) return null;
    player = JSON.parse(await res.text()) as PlayerResponse;
  } catch {
    return null;
  }
  const details = player.videoDetails;
  if (!details?.title) return null;
  const status = player.playabilityStatus;
  const tracks: CaptionTrack[] = (player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [])
    .filter((t) => t.baseUrl && t.languageCode)
    .map((t) => ({
      baseUrl: t.baseUrl!,
      languageCode: t.languageCode!,
      kind: t.kind,
      name: t.name?.simpleText ?? t.name?.runs?.map((r) => r.text ?? "").join(""),
    }));
  const video: YouTubeVideo = {
    id,
    title: details.title,
    author: details.author ?? "",
    description: (details.shortDescription ?? "").trim(),
    lengthSeconds: Number(details.lengthSeconds ?? 0) || 0,
    unplayable: status?.status && status.status !== "OK" ? status.reason || status.status : undefined,
    captionLanguages: tracks.map((t) => t.languageCode),
  };
  const track = pickCaptionTrack(tracks, languages);
  if (track) {
    const cues = await downloadCues(track, fetchImpl);
    if (cues.length) {
      video.transcript = {
        languageCode: track.languageCode,
        name: track.name || track.languageCode,
        generated: track.kind === "asr",
        text: formatTranscript(cues),
      };
    }
  }
  return video;
}

export function formatYouTubeVideo(v: YouTubeVideo): string {
  const lines = [`Title: ${v.title}`];
  if (v.author) lines.push(`Channel: ${v.author}`);
  if (v.lengthSeconds) lines.push(`Length: ${formatTimestamp(v.lengthSeconds * 1000)}`);
  if (v.unplayable) lines.push(`YouTube won't play it here: ${v.unplayable}`);
  if (v.description) lines.push(`Description: ${v.description}`);
  if (v.transcript) {
    const kind = v.transcript.generated ? "captions generated by YouTube, may have errors" : "captions";
    lines.push("", `Transcript (${v.transcript.name}, ${kind}; [m:ss] marks the time in the video):`, v.transcript.text);
  } else if (v.captionLanguages.length) {
    lines.push("", `The video has captions (${v.captionLanguages.join(", ")}) but they couldn't be downloaded.`);
  } else {
    lines.push("", "The video has no captions, so there is no transcript of what is said in it.");
  }
  return lines.join("\n");
}
