import { z, type ZodType } from "zod";

export function toJsonSchema(schema: ZodType): unknown | null {
  try {
    return z.toJSONSchema(schema, { io: "output", unrepresentable: "any" });
  } catch {
    return null;
  }
}

export function structuredInstruction(schema: ZodType): string {
  const js = toJsonSchema(schema);
  const shape = js ? `\n\nThe JSON MUST conform to this JSON Schema:\n${JSON.stringify(js, null, 2)}` : "";
  return (
    "\n\n---\n# Required output format\n" +
    "Reply with ONLY a single JSON value and NOTHING else — no prose, no explanation, " +
    "no markdown code fences. Your entire reply must be valid JSON that parses directly." +
    shape
  );
}

export function retryInstruction(prompt: string, error: string): string {
  return (
    `${prompt}\n\nYour previous reply did not match the required JSON schema (${error}). ` +
    "Reply with ONLY the corrected JSON value — no prose, no markdown fences."
  );
}

function firstBalanced(s: string): string | null {
  const start = s.search(/[{[]/);
  if (start === -1) return null;
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fall through */
    }
  }
  const slice = firstBalanced(trimmed);
  if (slice) {
    try {
      return JSON.parse(slice);
    } catch {
      /* fall through */
    }
  }
  throw new Error("no JSON value found in reply");
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseStructured<T>(text: string, schema: ZodType<T>): ParseResult<T> {
  let json: unknown;
  try {
    json = extractJson(text);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const res = schema.safeParse(json);
  if (res.success) return { ok: true, value: res.data };
  const issue = res.error.issues[0];
  const where = issue?.path?.length ? ` at ${issue.path.join(".")}` : "";
  return { ok: false, error: `${issue?.message ?? "invalid"}${where}` };
}
