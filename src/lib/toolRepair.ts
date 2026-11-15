type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  anyOf?: Schema[];
  oneOf?: Schema[];
  enum?: unknown[];
  required?: string[];
  additionalProperties?: boolean | Schema;
};

const NAME_PREFIXES = /^(?:functions[.:]|default_api[.:]|tools?[.:])/i;

export function matchToolName(name: string, available: string[]): string | null {
  if (available.includes(name)) return name;
  const bare = name.replace(NAME_PREFIXES, "").trim();
  if (available.includes(bare)) return bare;
  const lower = bare.toLowerCase().replace(/[\s_-]/g, "");
  return available.find((n) => n.toLowerCase().replace(/[\s_-]/g, "") === lower) ?? null;
}

function typesOf(schema: Schema | undefined): string[] {
  if (!schema) return [];
  if (Array.isArray(schema.type)) return schema.type;
  if (schema.type) return [schema.type];
  const alts = schema.anyOf ?? schema.oneOf;
  return alts ? alts.flatMap(typesOf) : [];
}

function coerceValue(value: unknown, schema: Schema | undefined, depth: number): { value: unknown; changed: boolean } {
  if (!schema || depth > 6) return { value, changed: false };
  const types = typesOf(schema);
  if (types.length === 0) return { value, changed: false };

  if (value === null && !types.includes("null")) return { value: undefined, changed: true };

  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((types.includes("number") || types.includes("integer")) && !types.includes("string") && /^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      return { value: Number(trimmed), changed: true };
    }
    if (types.includes("boolean") && !types.includes("string") && /^(true|false)$/i.test(trimmed)) {
      return { value: trimmed.toLowerCase() === "true", changed: true };
    }
    if ((types.includes("array") || types.includes("object")) && !types.includes("string") && /^[[{]/.test(trimmed)) {
      try {
        const parsed = JSON.parse(trimmed);
        const nested = coerceValue(parsed, schema, depth + 1);
        return { value: nested.value, changed: true };
      } catch {
        return { value, changed: false };
      }
    }
    if (types.includes("array") && !types.includes("string")) {
      const item = coerceValue(value, schema.items, depth + 1);
      return { value: [item.value], changed: true };
    }
  }

  if (typeof value === "number" && types.includes("string") && !types.includes("number") && !types.includes("integer")) {
    return { value: String(value), changed: true };
  }

  if (Array.isArray(value) && schema.items) {
    let changed = false;
    const out = value.map((v) => {
      const r = coerceValue(v, schema.items, depth + 1);
      if (r.changed) changed = true;
      return r.value;
    });
    return { value: changed ? out : value, changed };
  }

  if (value && typeof value === "object" && !Array.isArray(value) && schema.properties) {
    const r = coerceObject(value as Record<string, unknown>, schema, depth + 1);
    return { value: r.value, changed: r.changed };
  }

  return { value, changed: false };
}

function coerceObject(obj: Record<string, unknown>, schema: Schema, depth: number): { value: Record<string, unknown>; changed: boolean } {
  const props = schema.properties ?? {};
  const out: Record<string, unknown> = {};
  let changed = false;
  for (const [key, v] of Object.entries(obj)) {
    if (!(key in props)) {
      if (schema.additionalProperties === false) {
        changed = true;
        continue;
      }
      out[key] = v;
      continue;
    }
    const r = coerceValue(v, props[key], depth);
    if (r.changed) changed = true;
    if (r.value !== undefined) out[key] = r.value;
  }
  return { value: out, changed };
}

export function coerceToolInput(obj: Record<string, unknown>, schema: unknown): { value: Record<string, unknown>; changed: boolean } {
  const s = schema as Schema | undefined;
  if (!s || typeof s !== "object" || !s.properties) return { value: obj, changed: false };
  return coerceObject(obj, s, 0);
}
