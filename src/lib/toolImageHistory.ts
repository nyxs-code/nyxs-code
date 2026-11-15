import type { ModelMessage } from "ai";
import type { ChatMessage } from "@/components/Message";

/** What the model reads in place of a screenshot left out of the saved history. */
export const OLD_TOOL_IMAGE_NOTE = "[Old screenshot left out of the saved history to save space. Take a new one if you need it.]";

/** How many of a chat's latest tool images its saved history keeps. */
export const KEPT_TOOL_IMAGES = 3;

type Part = { type?: string; data?: unknown; mediaType?: unknown };
type ToolResult = { type?: string; output?: { type?: string; value?: unknown } };

const isImage = (p: Part): boolean =>
  (p?.type === "image-data" || p?.type === "file-data") && typeof p.data === "string" && /^image\//.test(String(p.mediaType ?? ""));

/** The tool results of `m` with images in them, in order: a model message holds them only in a
 *  `content` output's list. */
function imageResults(m: ModelMessage): ToolResult[] {
  if (m.role !== "tool" || !Array.isArray(m.content)) return [];
  return (m.content as ToolResult[]).filter(
    (p) => p?.type === "tool-result" && p.output?.type === "content" && Array.isArray(p.output.value) && (p.output.value as Part[]).some(isImage),
  );
}

function countImages(m: ModelMessage): number {
  return imageResults(m).reduce((n, r) => n + (r.output!.value as Part[]).filter(isImage).length, 0);
}

/** `m` with its first `drop` tool images replaced by the note. */
function dropImages(m: ModelMessage, drop: number): ModelMessage {
  let left = drop;
  const content = (m.content as ToolResult[]).map((p) => {
    if (left <= 0 || !imageResults({ role: "tool", content: [p] } as ModelMessage).length) return p;
    const value = (p.output!.value as Part[]).map((part) => {
      if (left <= 0 || !isImage(part)) return part;
      left--;
      return { type: "text", text: OLD_TOOL_IMAGE_NOTE };
    });
    return { ...p, output: { ...p.output, value } };
  });
  return { ...m, content } as ModelMessage;
}

/** The chat as it is saved: the screenshots its tools took (Computer, the browser's, an MCP
 *  server's) stay in the latest `keep` only. Each one is a JPEG of a few hundred KB in base64,
 *  and a long desktop or browser task left dozens in the chat's file and its session, rewritten
 *  on every save, and sent back to the model on every turn after a reload. Only the model reads
 *  these (`responseMessages`); what the chat shows, and the user's own images, are untouched.
 *  Returns `messages` itself when nothing goes. */
export function withoutOldToolImages(messages: ChatMessage[], keep = KEPT_TOOL_IMAGES): ChatMessage[] {
  let seen = 0;
  let changed = false;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const rm = out[i].responseMessages;
    if (!rm?.length) continue;
    let touched = false;
    const next = [...rm];
    for (let j = next.length - 1; j >= 0; j--) {
      const n = countImages(next[j]);
      if (!n) continue;
      const drop = Math.min(n, Math.max(0, seen + n - keep));
      seen += n;
      if (!drop) continue;
      // The older images of the message are the first ones.
      next[j] = dropImages(next[j], drop);
      touched = true;
    }
    if (touched) {
      out[i] = { ...out[i], responseMessages: next };
      changed = true;
    }
  }
  return changed ? out : messages;
}
