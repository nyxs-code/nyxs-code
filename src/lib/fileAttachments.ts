import { invoke } from "@/lib/ipc";
import type { AttachedFile } from "@/components/ui/claude-style-chat-input";
import { isImageAttachment, MAX_IMAGE_BYTES } from "./imageAttachments";
import { VIDEO_EXT_RE } from "@/tools/WatchVideo/format";

export interface DocumentAttachment {
  name: string;
  size: number;
  mime: string;
  text?: string;
  truncated?: boolean;
  path?: string;
  /** Over MAX_ATTACHMENT_BYTES: it was never read, so it has neither text nor a saved copy. */
  tooLarge?: boolean;
}

export const MAX_INLINE_CHARS = 100_000;

/** The largest file saved for the agent to open (the backend takes no more). A file is read
 *  whole and sent as base64 to be saved: a few hundred MB asked WebView2 for gigabytes at once
 *  and crashed the app, so a bigger one isn't read at all. */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** A text file is inlined up to MAX_INLINE_CHARS, so only that much (at most 4 bytes a
 *  character in UTF-8) is ever read, however long the file. */
const TEXT_READ_BYTES = MAX_INLINE_CHARS * 4;

export function formatFileSize(bytes: number): string {
  if (bytes <= 0) return "0 Bytes";
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${sizes[i]}`;
}

const TEXT_MIME = /^(text\/|application\/(json|ld\+json|xml|javascript|x-javascript|typescript|x-yaml|yaml|toml|x-sh|sql|csv|x-ndjson))/i;
const TEXT_EXT =
  /\.(txt|text|md|markdown|mdx|rst|csv|tsv|json|jsonl|ndjson|yaml|yml|toml|ini|cfg|conf|env|log|xml|html?|css|scss|less|svg|js|jsx|mjs|cjs|ts|tsx|vue|svelte|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|pl|lua|r|dart|scala|sh|bash|zsh|fish|ps1|psm1|bat|cmd|sql|graphql|gql|proto|tf|gradle|dockerfile|makefile|gitignore|editorconfig)$/i;

export function looksLikeText(name: string, mime: string, bytes: Uint8Array): boolean {
  if (TEXT_MIME.test(mime) || TEXT_EXT.test(name)) return true;
  const sample = bytes.subarray(0, 8192);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: true });
    return true;
  } catch {
    return false;
  }
}

function toBase64(bytes: Uint8Array): string {
  // Encoded a chunk at a time (a multiple of 3 bytes, so the pieces join without padding):
  // one binary string of the whole file doubled its size in memory before btoa even started.
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x7ffe) parts.push(btoa(String.fromCharCode(...bytes.subarray(i, i + 0x7ffe))));
  return parts.join("");
}

export type SaveAttachment = (name: string, base64: string) => Promise<string>;

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const saveAttachment: SaveAttachment | undefined = isTauri
  ? (name, data) => invoke<string>("nyxs_save_attachment", { name, data })
  : undefined;

export async function toDocumentAttachments(files: AttachedFile[], save?: SaveAttachment): Promise<DocumentAttachment[]> {
  const out: DocumentAttachment[] = [];
  for (const f of files) {
    // Images the model gets as images; one too big for that is attached as a file.
    if (isImageAttachment(f) && f.file.size <= MAX_IMAGE_BYTES) continue;
    const base = { name: f.file.name, size: f.file.size, mime: f.file.type || "application/octet-stream" };
    const head = new Uint8Array(await f.file.slice(0, TEXT_READ_BYTES).arrayBuffer());
    if (looksLikeText(base.name, base.mime, head)) {
      // Cut at a whole character: the last bytes read may be half of one.
      const text = new TextDecoder().decode(head, { stream: f.file.size > head.length });
      const cut = f.file.size > head.length || text.length > MAX_INLINE_CHARS;
      out.push(cut ? { ...base, text: text.slice(0, MAX_INLINE_CHARS), truncated: true } : { ...base, text });
      continue;
    }
    if (f.file.size > MAX_ATTACHMENT_BYTES) {
      out.push({ ...base, tooLarge: true });
      continue;
    }
    const bytes = f.file.size > head.length ? new Uint8Array(await f.file.arrayBuffer()) : head;
    const path = save ? await save(base.name, toBase64(bytes)).catch(() => undefined) : undefined;
    out.push(path ? { ...base, path } : base);
  }
  return out;
}

const attr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

function documentBlock(d: DocumentAttachment): string {
  const head = `<attached-file name="${attr(d.name)}" type="${attr(d.mime)}" size="${d.size}"`;
  if (d.text !== undefined) {
    const cut = d.truncated ? `\n[Only the first ${MAX_INLINE_CHARS} characters are included.]` : "";
    return `${head}>\n${d.text}${cut}\n</attached-file>`;
  }
  if (d.path) {
    const reader =
      /\.pdf$/i.test(d.name) || d.mime === "application/pdf"
        ? "ReadPdf"
        : VIDEO_EXT_RE.test(d.name) || d.mime.startsWith("video/")
          ? "WatchVideo"
          : "Read";
    return `${head} path="${attr(d.path)}">\nThe user attached this file. It is saved at the path above; open it with ${reader} when you need its contents.\n</attached-file>`;
  }
  if (d.tooLarge) {
    return `${head}>\nThe user attached this file, but at ${formatFileSize(d.size)} it is over the ${formatFileSize(MAX_ATTACHMENT_BYTES)} limit, so it wasn't read or saved. Tell the user, and ask for its path in the project or on disk if you need it.\n</attached-file>`;
  }
  return `${head}>\nThe user attached this file, but it is not text and could not be saved for you to open.\n</attached-file>`;
}

export function withDocuments(content: string, docs: DocumentAttachment[] | undefined): string {
  if (!docs?.length) return content;
  return [content, docs.map(documentBlock).join("\n\n")].filter(Boolean).join("\n\n");
}
