import type { ModelMessage } from "ai";
import { httpFetch } from "./modelClient";
import { AUTH_BASE, getToken } from "./auth";
import { privacySettings } from "./privacySettings";

/** The image types every provider reads as an image. Others (SVG, HEIC, BMP, TIFF…) go as files:
 *  an SVG as its text, the rest saved for the model to open. */
export const MODEL_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface ImageAttachment {
  mediaType: string;
  dataUrl: string;
  name?: string;
}

export interface CacheStats {
  readTokens: number;
  creationTokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  images?: ImageAttachment[];
  messages?: ModelMessage[];
}

export function toModelMessage(turn: ChatTurn, allowImages: boolean, visionDescriptions?: Map<string, string>): ModelMessage {
  // A chat saved before images were limited to these types may hold others, which providers refuse.
  const imgs = turn.role === "user" ? (turn.images ?? []).filter((img) => MODEL_IMAGE_TYPES.has(img.mediaType.toLowerCase())) : [];
  if (imgs.length === 0) {
    return { role: turn.role, content: turn.content };
  }
  if (allowImages) {
    const parts: Array<
      { type: "text"; text: string } | { type: "image"; image: string; mediaType: string }
    > = [];
    if (turn.content) parts.push({ type: "text", text: turn.content });
    for (const img of imgs) parts.push({ type: "image", image: img.dataUrl, mediaType: img.mediaType });
    return { role: "user", content: parts } as ModelMessage;
  }
  const described = imgs
    .map((img, i) => {
      const d = visionDescriptions?.get(img.dataUrl);
      return d ? `[Imagen adjunta ${i + 1}${img.name ? ` — ${img.name}` : ""}]:\n${d}` : null;
    })
    .filter((s): s is string => Boolean(s));
  if (described.length) {
    const body = [turn.content || "", ...described].filter(Boolean).join("\n\n");
    return { role: "user", content: body };
  }
  const note = `\n\n[${imgs.length} image attachment(s) were provided, but the current model can't read images.]`;
  return { role: "user", content: (turn.content || "(image attachment)") + note };
}

const visionCache = new Map<string, string>();

async function shrinkDataUrl(dataUrl: string, maxBytes = 170_000): Promise<string> {
  const bytesOf = (u: string) => Math.ceil((u.length - (u.indexOf(",") + 1)) * 3 / 4);
  if (typeof document === "undefined" || bytesOf(dataUrl) <= maxBytes) return dataUrl;
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = dataUrl;
    });
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;
    let scale = 1, quality = 0.85;
    const encode = () => {
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", quality);
    };
    let out = encode(), guard = 0;
    while (bytesOf(out) > maxBytes && guard < 12) {
      if (quality > 0.5) quality -= 0.12; else scale *= 0.8;
      out = encode(); guard++;
    }
    return out;
  } catch {
    return dataUrl;
  }
}

async function describeImageViaBackend(img: ImageAttachment, token: string): Promise<string | null> {
  const cached = visionCache.get(img.dataUrl);
  if (cached) return cached;
  try {
    const small = await shrinkDataUrl(img.dataUrl);
    const doFetch = httpFetch ?? fetch;
    const res = await doFetch(`${AUTH_BASE}/api/vision`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ image: small }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { description?: string };
    const desc = data?.description?.trim();
    if (!desc) return null;
    visionCache.set(img.dataUrl, desc);
    return desc;
  } catch {
    return null;
  }
}

export async function describeAttachedImages(history: ChatTurn[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const imgs: ImageAttachment[] = [];
  const seen = new Set<string>();
  for (const t of history) {
    if (t.role !== "user" || !t.images) continue;
    for (const img of t.images) {
      if (!seen.has(img.dataUrl)) { seen.add(img.dataUrl); imgs.push(img); }
    }
  }
  if (imgs.length === 0) return out;
  // Off in Settings › Privacy: no image leaves, and toModelMessage tells the model there was one.
  if (!(await privacySettings()).imageDescriptions) return out;
  const token = await getToken();
  if (!token) return out;
  await Promise.all(
    imgs.map(async (img) => {
      const d = await describeImageViaBackend(img, token);
      if (d) out.set(img.dataUrl, d);
    }),
  );
  return out;
}

const SUMMARY_RESULT_CHARS = 2000;
const SUMMARY_INPUT_CHARS = 600;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text;
}

function stringifyPart(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function serializeModelMessages(messages: ModelMessage[]): string {
  const out: string[] = [];
  for (const m of messages) {
    const content = (m as { content?: unknown }).content;
    const label = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : m.role === "tool" ? "Tool" : "System";
    if (typeof content === "string") {
      if (content.trim()) out.push(`[${label}]: ${content}`);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content as { type?: string; text?: string; toolName?: string; input?: unknown; output?: { value?: unknown } }[]) {
      if (part?.type === "text" && part.text?.trim()) out.push(`[${label}]: ${part.text}`);
      else if (part?.type === "tool-call") out.push(`[Assistant tool call]: ${part.toolName}(${clip(stringifyPart(part.input), SUMMARY_INPUT_CHARS)})`);
      else if (part?.type === "tool-result") out.push(`[Tool result ${part.toolName ?? ""}]: ${clip(stringifyPart(part.output?.value), SUMMARY_RESULT_CHARS)}`);
      else if (part?.type === "image" || part?.type === "file") out.push(`[${label}]: (attachment)`);
    }
  }
  return out.join("\n\n");
}

export function serializeTurnsForSummary(turns: ChatTurn[]): string {
  return turns
    .map((t) =>
      t.messages?.length
        ? serializeModelMessages(t.messages)
        : `[${t.role === "user" ? "User" : "Assistant"}]: ${t.content}`,
    )
    .filter(Boolean)
    .join("\n\n");
}
