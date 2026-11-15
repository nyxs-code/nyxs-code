import { invoke } from "./ipc";
import { replayResponse } from "./providerFetch";

/** The largest video a model is sent whole: Gemini takes about 20 MB inline per request, and
 *  DashScope's data URLs are in the same range. A bigger one is watched as frames. */
export const NATIVE_VIDEO_MAX_BYTES = 20 * 1024 * 1024;

/** Only the latest videos ride along on each request: every step resends the whole history, and
 *  a video costs thousands of tokens each time. Older ones become a note to watch them again. */
const MAX_ATTACHED_VIDEOS = 2;

const VIDEO_MARKER_RE = /⟦nyxs-video (\S+) (\S+)⟧/g;

/** Where a tool result asks for a whole video. The result keeps only this marker (the session
 *  never stores the video); `withToolMedia` reads the file and puts it in the request. */
export function videoMarker(path: string, mediaType: string): string {
  return `⟦nyxs-video ${encodeURIComponent(path)} ${mediaType}⟧`;
}

export function hasVideoMarker(text: string): boolean {
  return text.includes("⟦nyxs-video ");
}

/** Models (`videoModelKey`) whose endpoint turned a video down: they get frames from then on. */
export const nativeVideoRejected = new Set<string>();

/** How many images and videos a model's endpoint takes per request, once it said so. vLLM
 *  servers (NVIDIA NIM, most self-hosted models) refuse more than `--limit-mm-per-prompt`. */
export const mediaLimits = new Map<string, { image?: number; video?: number }>();

const MEDIA_LIMIT_RE = /at most (\d+) (image|video)\(?s?\)?/i;

export type VideoLoader = (path: string) => Promise<{ base64: string; mediaType: string }>;

const loaded = new Map<string, Promise<{ base64: string; mediaType: string }>>();

/** Reads a video for the request, keeping the last two: the steps of a turn resend the same one. */
const loadVideo: VideoLoader = (path) => {
  const hit = loaded.get(path);
  if (hit) {
    loaded.delete(path);
    loaded.set(path, hit);
    return hit;
  }
  const p = invoke<{ base64: string; mediaType: string }>("agent_read_video", { path, maxBytes: NATIVE_VIDEO_MAX_BYTES });
  p.catch(() => loaded.delete(path));
  loaded.set(path, p);
  while (loaded.size > MAX_ATTACHED_VIDEOS) loaded.delete(loaded.keys().next().value!);
  return p;
};

const NOTE_ATTACHED = "[The video is attached in the next message.]";
const NOTE_DROPPED =
  "[This video is no longer attached, to save context. Call WatchVideo again if you need to see it.]";
const noteRejected = (why: string) =>
  `[The model's endpoint didn't accept this video (${why}). Call WatchVideo again with mode "frames" to see it as frames.]`;
const noteFailed = (why: string) => `[The video couldn't be attached: ${why}]`;
const noteImagesDropped = (n: number, limit: number) =>
  `[${n === 1 ? "The image" : `${n} images`} this tool returned ${n === 1 ? "was" : "were"} left out: the model's endpoint takes at most ${limit} per request, and newer ones came after. Call the tool again if you need ${n === 1 ? "it" : "them"}.]`;

type Videos = "attach" | { rejected: string };

interface Limits {
  videos: Videos;
  image?: number;
  video?: number;
}

interface MediaPlan {
  /** Whether any video went into the request. */
  attached: boolean;
  /** How many of the tools' images went into it. */
  images: number;
}

/** How many video markers the body holds, so only the latest ones are sent. */
function countMarkers(texts: string[]): number {
  let n = 0;
  for (const t of texts) n += t.match(VIDEO_MARKER_RE)?.length ?? 0;
  return n;
}

/** Swaps each marker in `text` for a note, collecting the videos still to send: the latest
 *  `keep` of the body's `total`. */
async function takeVideos(
  text: string,
  seen: { n: number; total: number; keep: number },
  videos: Videos,
  load: VideoLoader,
  out: { mediaType: string; base64: string }[],
): Promise<string> {
  const matches = [...text.matchAll(VIDEO_MARKER_RE)];
  if (!matches.length) return text;
  let result = "";
  let last = 0;
  for (const m of matches) {
    result += text.slice(last, m.index);
    last = m.index! + m[0].length;
    const live = seen.n++ >= seen.total - seen.keep;
    if (!live) {
      result += NOTE_DROPPED;
      continue;
    }
    if (videos !== "attach") {
      result += noteRejected(videos.rejected);
      continue;
    }
    try {
      const v = await load(decodeURIComponent(m[1]));
      out.push({ mediaType: v.mediaType || m[2], base64: v.base64 });
      result += NOTE_ATTACHED;
    } catch (e) {
      result += noteFailed(e instanceof Error ? e.message : String(e));
    }
  }
  return result + text.slice(last);
}

type WirePart = Record<string, unknown>;
type WireMessage = { role?: string; content?: unknown } & Record<string, unknown>;

/** The image parts of a tool result the OpenAI-compatible SDK turned into JSON text
 *  (`[{"type":"text",...},{"type":"file-data",...}]`), or null when it is plain text. */
function toolResultParts(content: string): { text: string; images: string[] } | null {
  if (!content.startsWith("[{")) return null;
  let parts: { type?: string; text?: string; data?: string; mediaType?: string }[];
  try {
    parts = JSON.parse(content);
  } catch {
    return null;
  }
  if (!Array.isArray(parts)) return null;
  const isImage = (p: (typeof parts)[number]) =>
    (p?.type === "image-data" || p?.type === "file-data") && typeof p.data === "string" && /^image\//.test(p.mediaType ?? "");
  if (!parts.some(isImage)) return null;
  const text = parts.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
  const images = parts.filter(isImage).map((p) => `data:${p.mediaType};base64,${p.data}`);
  return { text, images };
}

/** Images the user attached, which count toward the endpoint's limit too. */
function userImageCount(msgs: WireMessage[]): number {
  let n = 0;
  for (const m of msgs) {
    if (m?.role !== "user" || !Array.isArray(m.content)) continue;
    for (const p of m.content as WirePart[]) if (p?.type === "image_url") n++;
  }
  return n;
}

/** OpenAI's chat format has no images or video in a tool message, so what a tool returned goes
 *  in a user message right after the run of tool messages: merged into the user message that
 *  already follows, or a new one. */
async function rewriteOpenAI(body: Record<string, unknown>, limits: Limits, load: VideoLoader): Promise<MediaPlan> {
  const msgs = body.messages as WireMessage[] | undefined;
  if (!Array.isArray(msgs)) return { attached: false, images: 0 };
  const toolMsgs = msgs.filter((m) => m?.role === "tool" && typeof m.content === "string");
  const seen = {
    n: 0,
    total: countMarkers(toolMsgs.map((m) => m.content as string)),
    keep: Math.min(MAX_ATTACHED_VIDEOS, limits.video ?? MAX_ATTACHED_VIDEOS),
  };
  const parsed = new Map<WireMessage, { text: string; images: string[] } | null>(toolMsgs.map((m) => [m, toolResultParts(m.content as string)]));
  const totalImages = [...parsed.values()].reduce((n, p) => n + (p?.images.length ?? 0), 0);
  const keepImages = limits.image === undefined ? totalImages : Math.max(0, limits.image - userImageCount(msgs));
  let imageIndex = 0;
  const out: WireMessage[] = [];
  let pending: WirePart[] = [];
  let attached = false;
  let images = 0;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m?.role === "tool" && typeof m.content === "string") {
      let content = m.content;
      const parts = parsed.get(m);
      if (parts) {
        // The latest images are kept when the endpoint takes fewer than the history holds.
        const kept = parts.images.filter(() => imageIndex++ >= totalImages - keepImages);
        const dropped = parts.images.length - kept.length;
        const notes = [];
        if (kept.length) notes.push(`[The image${kept.length > 1 ? "s" : ""} this tool returned ${kept.length > 1 ? "are" : "is"} in the next message.]`);
        if (dropped) notes.push(noteImagesDropped(dropped, limits.image ?? 0));
        content = [parts.text, ...notes].filter(Boolean).join("\n");
        for (const url of kept) pending.push({ type: "image_url", image_url: { url } });
        images += kept.length;
      }
      if (hasVideoMarker(content)) {
        const found: { mediaType: string; base64: string }[] = [];
        content = await takeVideos(content, seen, limits.videos, load, found);
        for (const v of found) pending.push({ type: "video_url", video_url: { url: `data:${v.mediaType};base64,${v.base64}` } });
        attached ||= found.length > 0;
      }
      out.push(content === m.content ? m : { ...m, content });
      if (msgs[i + 1]?.role === "tool" || !pending.length) continue;
      const lead: WirePart = { type: "text", text: "What the tool calls above returned:" };
      const next = msgs[i + 1];
      if (next?.role === "user") {
        const rest = typeof next.content === "string" ? [{ type: "text", text: next.content }] : (next.content as WirePart[]) ?? [];
        out.push({ ...next, content: [lead, ...pending, ...rest] });
        i++;
      } else {
        out.push({ role: "user", content: [lead, ...pending] });
      }
      pending = [];
      continue;
    }
    out.push(m);
  }
  body.messages = out;
  return { attached, images };
}

/** Gemini takes media next to a function response, as the SDK itself sends a tool's images. */
async function rewriteGoogle(body: Record<string, unknown>, limits: Limits, load: VideoLoader): Promise<MediaPlan> {
  const contents = body.contents as { parts?: WirePart[] }[] | undefined;
  if (!Array.isArray(contents)) return { attached: false, images: 0 };
  type FnResponse = { functionResponse?: { response?: { content?: unknown } } };
  const responseText = (p: WirePart) => (p as FnResponse).functionResponse?.response?.content;
  const texts = contents.flatMap((c) => c.parts ?? []).map(responseText).filter((t): t is string => typeof t === "string");
  const seen = { n: 0, total: countMarkers(texts), keep: Math.min(MAX_ATTACHED_VIDEOS, limits.video ?? MAX_ATTACHED_VIDEOS) };
  let attached = false;
  for (const c of contents) {
    if (!Array.isArray(c.parts)) continue;
    const parts: WirePart[] = [];
    for (const p of c.parts) {
      const text = responseText(p);
      if (typeof text !== "string" || !hasVideoMarker(text)) {
        parts.push(p);
        continue;
      }
      const found: { mediaType: string; base64: string }[] = [];
      const content = await takeVideos(text, seen, limits.videos, load, found);
      const fr = (p as FnResponse).functionResponse!;
      parts.push({ ...p, functionResponse: { ...fr, response: { ...fr.response, content } } });
      for (const v of found) parts.push({ inlineData: { mimeType: v.mediaType, data: v.base64 } });
      attached ||= found.length > 0;
    }
    c.parts = parts;
  }
  return { attached, images: 0 };
}

const RETRY_STATUSES = new Set([400, 413, 415, 422]);

/** The error an OpenAI-compatible stream opens with instead of an answer, if it does. NVIDIA's
 *  vLLM answers a request over its image limit with HTTP 200 and an `error` event, so the status
 *  alone doesn't tell. The stream is handed back whole either way. */
async function peekStreamError(res: Response): Promise<{ res: Response; error?: string }> {
  if (!res.ok || !res.body || !/event-stream/i.test(res.headers.get("content-type") ?? "")) return { res };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let head = "";
  let done = false;
  // Until the first event is whole: a normal answer's first event arrives as soon as it starts.
  while (!done && !/\n\n|\r\n\r\n/.test(head) && head.length < 65_536) {
    const r = await reader.read();
    done = r.done;
    if (r.value) {
      chunks.push(r.value);
      head += decoder.decode(r.value, { stream: true });
    }
  }
  const first = /^data:\s*(.+)$/m.exec(head)?.[1];
  let error: string | undefined;
  if (first) {
    try {
      const event = JSON.parse(first) as { error?: { message?: unknown } | string; object?: string; message?: unknown };
      const e = event.error ?? (event.object === "error" ? event : undefined);
      if (e) error = typeof e === "string" ? e : typeof e.message === "string" ? e.message : JSON.stringify(e);
    } catch {
      // Not JSON: an ordinary event.
    }
  }
  const replay = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      if (done) controller.close();
    },
    async pull(controller) {
      const r = await reader.read();
      if (r.done) controller.close();
      else controller.enqueue(r.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { res: new Response(replay, { status: res.status, statusText: res.statusText, headers: res.headers }), error };
}

/** A refusal that is about the media sent, so sending less (or no video) may get through. */
const MEDIA_ERROR_RE = /video|image|multi.?modal|limit-mm|media|content.?type|unsupported/i;

/** Puts what tools returned into the request in the form the API takes: the videos WatchVideo
 *  asked for (`videoMarker`), and for OpenAI-compatible endpoints the images a tool returned,
 *  which the SDK would otherwise send as base64 text. When the endpoint turns the media down, the
 *  request is retried: within the per-request limit it named, or without the video, telling the
 *  model to watch frames instead. */
export function withToolMedia(base: typeof fetch, wire: "openai" | "google", modelKey: string, load: VideoLoader = loadVideo): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const raw = init?.body;
    if (typeof raw !== "string") return base(input, init);
    const video = hasVideoMarker(raw);
    const images = wire === "openai" && /image-data|file-data/.test(raw);
    if (!video && !images) return base(input, init);
    const build = async (limits: Limits) => {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(raw);
      } catch {
        return null;
      }
      const plan = wire === "openai" ? await rewriteOpenAI(obj, limits, load) : await rewriteGoogle(obj, limits, load);
      return { body: JSON.stringify(obj), ...plan };
    };
    const known = mediaLimits.get(modelKey) ?? {};
    let limits: Limits = {
      videos: nativeVideoRejected.has(modelKey) ? { rejected: "it turned a video down earlier in this session" } : "attach",
      ...known,
    };
    let sent = await build(limits);
    if (!sent) return base(input, init);
    // Each retry gives up something the endpoint refused, so this ends in a few rounds.
    for (let round = 0; ; round++) {
      let res = await base(input, { ...init, body: sent.body });
      const reducible = (sent.attached || sent.images > 0) && round < 3;
      let bodyText: string;
      if (res.ok) {
        if (!reducible) return res;
        const peek = await peekStreamError(res);
        if (!peek.error || !MEDIA_ERROR_RE.test(peek.error)) return peek.res;
        void peek.res.body?.cancel().catch(() => undefined);
        bodyText = peek.error;
        // Retried below like a refusal; if it can't be, the stream's error reaches the SDK.
        res = replayResponse(res, JSON.stringify({ error: { message: peek.error } }), 400, "Bad Request");
      } else {
        if (!RETRY_STATUSES.has(res.status) || !reducible) return res;
        try {
          bodyText = await res.text();
        } catch {
          return res;
        }
      }
      const limit = MEDIA_LIMIT_RE.exec(bodyText);
      const kind = limit?.[2].toLowerCase() as "image" | "video" | undefined;
      const max = limit ? Number(limit[1]) : NaN;
      let next: Limits | null = null;
      if (kind === "image" && sent.images > 0 && max < (limits.image ?? Infinity)) {
        next = { ...limits, image: max };
      } else if (kind === "video" && sent.attached && max < (limits.video ?? MAX_ATTACHED_VIDEOS) && max > 0) {
        next = { ...limits, video: max };
      } else if (sent.attached && MEDIA_ERROR_RE.test(bodyText)) {
        next = { ...limits, videos: { rejected: `HTTP ${res.status}: ${bodyText.replace(/\s+/g, " ").slice(0, 160)}` } };
      }
      if (!next) return replayResponse(res, bodyText);
      const retry = await build(next);
      if (!retry) return replayResponse(res, bodyText);
      if (next.image !== limits.image || next.video !== limits.video) {
        mediaLimits.set(modelKey, { ...mediaLimits.get(modelKey), ...(next.image !== undefined ? { image: next.image } : {}), ...(next.video !== undefined ? { video: next.video } : {}) });
      } else if (next.videos !== limits.videos) {
        nativeVideoRejected.add(modelKey);
      }
      limits = next;
      sent = retry;
    }
  }) as typeof fetch;
}
