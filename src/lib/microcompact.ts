import type { ModelMessage } from "ai";
import { readFingerprint } from "./fileStateCache";
import { hasVideoMarker } from "./toolMedia";

export const MC_CLEARED_MESSAGE =
  "[Old tool result content cleared to save context — re-read the file or re-run the command if you need it again.]";

export const MC_PRUNE_MARKER = "\n\n[... tool result middle pruned to save context — re-read the file or re-run the command if you need this part ...]\n\n";

const COMPACTABLE_TOOLS = new Set<string>([
  "Read",
  "ReadPdf",
  "Bash",
  "BashOutput",
  "Grep",
  "Glob",
  "ListDir",
  "WebFetch",
  "WebSearch",
  "GitDiff",
  "GitLog",
  "GitBlame",
  "Lsp",
  "TaskOutput",
  "WatchVideo",
  "Computer",
  "VideoStill",
]);

/** Tools whose images may be cleared with the rest of an old result: a video's frames are seen
 *  once, a desktop screenshot is stale after the next action, and both can be taken again. */
const CLEARABLE_MEDIA_TOOLS = new Set<string>(["WatchVideo", "Computer", "VideoStill"]);

/** The video editor's reads, stale as soon as the project changes, like the browser's pages. */
const VIDEO_LOOKING_TOOLS = new Set(["VideoSnapshot", "VideoFind", "VideoScreenshot", "VideoScreenshotEditor", "VideoConsoleLogs"]);

/** The built-in browser's tools (BrowserSnapshot, BrowserScreenshot...): their pages and
 *  pictures go stale as soon as the page changes, so old ones can go, screenshots included. */
const isBrowserTool = (name: string): boolean => /^Browser[A-Z]/.test(name) || VIDEO_LOOKING_TOOLS.has(name);

export const PRUNE_TRIGGER_RATIO = 0.6;
export const PRUNE_TARGET_RATIO = 0.45;
export const PRUNE_PROTECT_TOKENS = 40_000;
export const PRUNE_MINIMUM_TOKENS = 20_000;
const TRIM_OVER_CHARS = 8192;
const TRIM_HEAD_CHARS = 4096;
const TRIM_TAIL_CHARS = 1024;
const MIN_CLEARABLE_TOKENS = 200;
const IMAGE_TOKENS = 1600;
// A whole video in a request (WatchVideo's marker): Qwen samples 2 frames a second, so a
// minute is tens of thousands of tokens. A rough middle, for pruning to know it is heavy.
const VIDEO_TOKENS = 20_000;

export type PruneAction = "trim" | "clear";
export type PruneMap = Record<string, PruneAction>;

type ToolResultPart = {
  type: "tool-result";
  toolCallId?: string;
  toolName?: string;
  output?: { type?: string; value?: unknown };
};

export function liveToolResultFingerprints(messages: ModelMessage[], toolName: string): Set<string> {
  const prints = new Set<string>();
  for (const m of messages) {
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content as ToolResultPart[]) {
      if (part?.type !== "tool-result" || part.toolName !== toolName) continue;
      const value = part.output?.value;
      if (typeof value !== "string" || value === MC_CLEARED_MESSAGE || value.includes(MC_PRUNE_MARKER)) continue;
      prints.add(readFingerprint(value));
    }
  }
  return prints;
}

const estTokens = (chars: number): number => Math.ceil(chars / 4);

function valueChars(v: unknown): number {
  if (typeof v === "string") return v.length + (hasVideoMarker(v) ? VIDEO_TOKENS * 4 : 0);
  if (v == null) return 0;
  if (Array.isArray(v)) {
    let n = 0;
    for (const item of v as { type?: string; data?: unknown; text?: unknown }[]) {
      if (item?.type === "image" || item?.type === "media" || item?.type === "image-data" || item?.type === "file-data") n += IMAGE_TOKENS * 4;
      else n += valueChars(item?.text ?? item);
    }
    return n;
  }
  try {
    return JSON.stringify(v).length;
  } catch {
    return 0;
  }
}

function partTokens(part: unknown): number {
  if (typeof part === "string") return estTokens(part.length);
  const p = part as { type?: string; text?: unknown; input?: unknown; output?: { value?: unknown } };
  switch (p?.type) {
    case "text":
    case "reasoning":
      return estTokens(typeof p.text === "string" ? p.text.length : 0);
    case "image":
    case "file":
      return IMAGE_TOKENS;
    case "tool-call":
      return estTokens(valueChars(p.input)) + 8;
    case "tool-result":
      return estTokens(valueChars(p.output?.value)) + 8;
    default:
      return estTokens(valueChars(part));
  }
}

export function estimateMessageTokens(messages: ModelMessage[]): number {
  let total = 0;
  for (const m of messages) {
    const content = (m as { content?: unknown }).content;
    total += 4;
    if (typeof content === "string") total += estTokens(content.length);
    else if (Array.isArray(content)) for (const part of content) total += partTokens(part);
  }
  return total;
}

function resultText(part: ToolResultPart): string | null {
  const v = part.output?.value;
  return typeof v === "string" ? v : null;
}

function isClearableResult(part: unknown): part is ToolResultPart {
  const p = part as ToolResultPart | undefined;
  if (!p || p.type !== "tool-result" || !p.toolCallId) return false;
  if (!p.toolName || !(COMPACTABLE_TOOLS.has(p.toolName) || isBrowserTool(p.toolName))) return false;
  const t = p.output?.type;
  return (
    t === "text" ||
    t === "json" ||
    t === "error-text" ||
    t === undefined ||
    (t === "content" && (isBrowserTool(p.toolName) || CLEARABLE_MEDIA_TOOLS.has(p.toolName)))
  );
}

export function trimToolText(text: string): string {
  if (text.length <= TRIM_OVER_CHARS || text.includes(MC_PRUNE_MARKER)) return text;
  return text.slice(0, TRIM_HEAD_CHARS) + MC_PRUNE_MARKER + text.slice(text.length - TRIM_TAIL_CHARS);
}

export function applyToolResultPruning(messages: ModelMessage[], prune: PruneMap): ModelMessage[] {
  if (!Object.keys(prune).length) return messages;
  let changed = false;
  const out = messages.map((m) => {
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) return m;
    let touched = false;
    const next = content.map((part) => {
      const p = part as ToolResultPart;
      if (p?.type !== "tool-result" || !p.toolCallId) return part;
      const action = prune[p.toolCallId];
      if (!action) return part;
      if (action === "clear") {
        if (resultText(p) === MC_CLEARED_MESSAGE) return part;
        touched = true;
        return { ...p, output: { type: "text", value: MC_CLEARED_MESSAGE } };
      }
      const text = resultText(p);
      if (text === null) return part;
      const trimmed = trimToolText(text);
      if (trimmed === text) return part;
      touched = true;
      return { ...p, output: { ...p.output, value: trimmed } };
    });
    if (!touched) return m;
    changed = true;
    return { ...(m as object), content: next } as ModelMessage;
  });
  return changed ? out : messages;
}

export interface PrunePlanOptions {
  usedTokens: number;
  contextWindow: number;
  existing?: PruneMap;
}

export interface PrunePlan {
  prune: PruneMap;
  added: number;
  freedTokens: number;
}

export function planToolResultPruning(messages: ModelMessage[], opts: PrunePlanOptions): PrunePlan {
  const existing = opts.existing ?? {};
  const none: PrunePlan = { prune: existing, added: 0, freedTokens: 0 };
  if (opts.usedTokens < opts.contextWindow * PRUNE_TRIGGER_RATIO) return none;
  const need = opts.usedTokens - opts.contextWindow * PRUNE_TARGET_RATIO;

  type Ref = { id: string; tokens: number; trimmable: number };
  const refs: Ref[] = [];
  for (const m of messages) {
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as ToolResultPart;
      if (p?.type !== "tool-result") continue;
      const tokens = partTokens(p);
      if (!isClearableResult(p) || existing[p.toolCallId!] === "clear") {
        refs.push({ id: "", tokens, trimmable: 0 });
        continue;
      }
      const text = resultText(p);
      const trimmable =
        existing[p.toolCallId!] !== "trim" && text && text.length > TRIM_OVER_CHARS && !text.includes(MC_PRUNE_MARKER)
          ? estTokens(text.length - TRIM_HEAD_CHARS - TRIM_TAIL_CHARS - MC_PRUNE_MARKER.length)
          : 0;
      refs.push({ id: p.toolCallId!, tokens, trimmable });
    }
  }

  let protectedTokens = 0;
  let cutoff = refs.length;
  for (let i = refs.length - 1; i >= 0; i--) {
    if (protectedTokens >= PRUNE_PROTECT_TOKENS) break;
    protectedTokens += refs[i].tokens;
    cutoff = i;
  }
  const candidates = refs.slice(0, cutoff).filter((r) => r.id);

  const prune: PruneMap = { ...existing };
  let freed = 0;
  let added = 0;
  for (const r of candidates) {
    if (freed >= need) break;
    if (r.trimmable > 0) {
      prune[r.id] = "trim";
      freed += r.trimmable;
      added++;
    }
  }
  for (const r of candidates) {
    if (freed >= need) break;
    if (r.tokens < MIN_CLEARABLE_TOKENS) continue;
    const already = prune[r.id] === "trim" ? r.trimmable : 0;
    prune[r.id] = "clear";
    freed += r.tokens - already;
    if (!already) added++;
  }

  if (freed < PRUNE_MINIMUM_TOKENS) return none;
  return { prune, added, freedTokens: freed };
}
