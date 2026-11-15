import { invoke } from "@/lib/ipc";
import type { PermissionMode } from "@/components/ui/claude-style-chat-input";
import type { Settings as ProviderConfig } from "./settings";

export type SettingsSource = "user" | "project" | "local";

export interface NyxsSettings {
  permissions?: {
    defaultMode?: PermissionMode;
    allow?: string[];
    deny?: string[];
    skipByDefault?: boolean;
  };
  memory?: {
    paths?: string[];
  };
  env?: Record<string, string>;
  outputStyle?: string;
  providers?: Partial<ProviderConfig>;
  [key: string]: unknown;
}

export const PROJECT_FORBIDDEN_KEYS: readonly string[] = [
  "permissions.skipByDefault",
  "memory.paths",
];

type Plain = Record<string, unknown>;

function isPlainObject(v: unknown): v is Plain {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function dedupe(arr: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of arr) {
    const key =
      item !== null && typeof item === "object"
        ? `o:${JSON.stringify(item)}`
        : `${typeof item}:${String(item)}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

export function deepMerge<T = unknown>(base: T, over: T): T {
  if (isPlainObject(base) && isPlainObject(over)) {
    const out: Plain = { ...base };
    for (const [k, v] of Object.entries(over)) {
      if (v === undefined) {
        delete out[k];
      } else if (k in out) {
        out[k] = deepMerge(out[k], v);
      } else {
        out[k] = v;
      }
    }
    return out as T;
  }
  if (Array.isArray(base) && Array.isArray(over)) {
    return dedupe([...base, ...over]) as T;
  }
  return over === undefined ? base : over;
}

function stripPath(obj: Plain, dotted: string): void {
  const parts = dotted.split(".");
  let cur: Plain = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]];
    if (!isPlainObject(next)) return;
    cur = next;
  }
  delete cur[parts[parts.length - 1]];
}

export function sanitizeProjectSettings(settings: NyxsSettings): NyxsSettings {
  const clone = structuredClone(settings);
  for (const key of PROJECT_FORBIDDEN_KEYS) stripPath(clone, key);
  return clone;
}

export async function getSettingsForSource(
  source: SettingsSource,
  workspace: string | null,
): Promise<NyxsSettings> {
  if (source !== "user" && !workspace) return {};
  try {
    const raw = await invoke<string>("nyxs_read_settings", {
      source,
      workspace: workspace ?? null,
    });
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? (parsed as NyxsSettings) : {};
  } catch (err) {
    console.warn(`No se pudo leer settings (${source}):`, err);
    return {};
  }
}

export async function saveSettingsForSource(
  source: SettingsSource,
  workspace: string | null,
  settings: NyxsSettings,
): Promise<void> {
  await invoke("nyxs_write_settings", {
    source,
    workspace: workspace ?? null,
    json: JSON.stringify(settings, null, 2),
  });
}

export async function loadMergedSettings(
  workspace: string | null,
): Promise<NyxsSettings> {
  const [user, project, local] = await Promise.all([
    getSettingsForSource("user", workspace),
    getSettingsForSource("project", workspace),
    getSettingsForSource("local", workspace),
  ]);

  let merged = deepMerge<NyxsSettings>({}, user);
  merged = deepMerge<NyxsSettings>(merged, sanitizeProjectSettings(project));
  merged = deepMerge<NyxsSettings>(merged, local);
  return merged;
}
