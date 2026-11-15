import {
  BASH_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  LIST_DIR_TOOL_NAME,
  READ_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from "./toolNames";

export const TOOL_OUTPUT_LIMITS: Record<string, number> = {
  default: 30_000,
  [READ_TOOL_NAME]: 60_000,
  [BASH_TOOL_NAME]: 30_000,
  [GREP_TOOL_NAME]: 30_000,
  [GLOB_TOOL_NAME]: 20_000,
  [LIST_DIR_TOOL_NAME]: 20_000,
  [WEB_FETCH_TOOL_NAME]: 40_000,
  [WEB_SEARCH_TOOL_NAME]: 20_000,
};

export function outputLimitFor(toolName: string): number {
  return TOOL_OUTPUT_LIMITS[toolName] ?? TOOL_OUTPUT_LIMITS.default;
}

export function truncateOutput(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n… [output truncated to ${max} characters]`;
}

export function truncateForTool(toolName: string, text: string): string {
  return truncateOutput(text, outputLimitFor(toolName));
}

export function truncateMiddle(text: string, max: number, headShare = 1 / 3): string {
  if (text.length <= max) return text;
  const headLen = Math.floor(max * headShare);
  const tailLen = max - headLen;
  let head = text.slice(0, headLen);
  let tail = text.slice(text.length - tailLen);
  const headBreak = head.lastIndexOf("\n");
  if (headBreak > headLen / 2) head = head.slice(0, headBreak);
  const tailBreak = tail.indexOf("\n");
  if (tailBreak >= 0 && tailBreak < tailLen / 2) tail = tail.slice(tailBreak + 1);
  const omitted = text.length - head.length - tail.length;
  return `${head}\n… [${omitted} characters omitted from the middle of the output] …\n${tail}`;
}

export function truncateNumberedLines(text: string, max: number): { text: string; lastLine: number | null } {
  if (text.length <= max) return { text, lastLine: null };
  const cut = text.lastIndexOf("\n", max);
  const kept = cut > 0 ? text.slice(0, cut + 1) : text.slice(0, max);
  const lines = kept.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*(\d+)\t/.exec(lines[i]);
    if (m) return { text: kept, lastLine: Number(m[1]) };
  }
  return { text: kept, lastLine: null };
}
