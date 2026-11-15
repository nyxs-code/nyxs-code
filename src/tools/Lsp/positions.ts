export function toOneBasedPositions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toOneBasedPositions);
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = toOneBasedPositions(v);
  if (typeof obj.line === "number" && typeof obj.character === "number") {
    out.line = obj.line + 1;
    out.character = obj.character + 1;
  }
  return out;
}
