import {
  getSettingsForSource,
  saveSettingsForSource,
  loadMergedSettings,
} from "@/lib/configStore";
import { getSecret, setSecret } from "@/lib/secureStore";
import type { PluginManifest, UserConfigOption } from "./schema";

const SETTINGS_KEY = "pluginConfig";

export function pluginSecretAccount(id: string, key: string): string {
  return `plugin:${id}:${key}`;
}

function toStr(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.map(String).join(",");
  return String(v);
}

function optionsOf(manifest: PluginManifest): [string, UserConfigOption][] {
  return Object.entries(manifest.userConfig ?? {});
}

export function hasUserConfig(manifest: PluginManifest): boolean {
  return optionsOf(manifest).length > 0;
}

async function storedValues(id: string): Promise<Record<string, unknown>> {
  const all = (await loadMergedSettings(null))[SETTINGS_KEY];
  const map = all && typeof all === "object" ? (all as Record<string, unknown>)[id] : undefined;
  return map && typeof map === "object" ? (map as Record<string, unknown>) : {};
}

export async function getPluginConfig(
  id: string,
  manifest: PluginManifest,
): Promise<Record<string, string>> {
  const stored = await storedValues(id);
  const out: Record<string, string> = {};
  for (const [key, opt] of optionsOf(manifest)) {
    if (opt.sensitive) {
      out[key] = (await getSecret(pluginSecretAccount(id, key))) ?? toStr(opt.default);
    } else {
      out[key] = key in stored ? toStr(stored[key]) : toStr(opt.default);
    }
  }
  return out;
}

export async function getPluginConfigForEdit(
  id: string,
  manifest: PluginManifest,
): Promise<Record<string, string>> {
  const stored = await storedValues(id);
  const out: Record<string, string> = {};
  for (const [key, opt] of optionsOf(manifest)) {
    if (opt.sensitive) out[key] = (await getSecret(pluginSecretAccount(id, key))) ?? "";
    else out[key] = key in stored ? toStr(stored[key]) : "";
  }
  return out;
}

function coerce(v: string, opt: UserConfigOption): unknown {
  if (opt.type === "number") {
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }
  if (opt.type === "boolean") return v === "true" || v === "1";
  if (opt.multiple) return v.split(",").map((s) => s.trim()).filter(Boolean);
  return v;
}

export async function setPluginConfig(
  id: string,
  manifest: PluginManifest,
  values: Record<string, string>,
): Promise<void> {
  const user = await getSettingsForSource("user", null);
  const allRaw = user[SETTINGS_KEY];
  const all = (allRaw && typeof allRaw === "object"
    ? { ...(allRaw as Record<string, unknown>) }
    : {}) as Record<string, Record<string, unknown>>;

  const nonSensitive: Record<string, unknown> = {};
  for (const [key, opt] of optionsOf(manifest)) {
    const v = values[key];
    if (opt.sensitive) {
      await setSecret(pluginSecretAccount(id, key), v ?? "");
    } else if (v !== undefined && v !== "") {
      nonSensitive[key] = coerce(v, opt);
    }
  }

  if (Object.keys(nonSensitive).length) all[id] = nonSensitive;
  else delete all[id];
  await saveSettingsForSource("user", null, { ...user, [SETTINGS_KEY]: all });
}

export function validateUserConfig(
  manifest: PluginManifest,
  values: Record<string, string>,
): string[] {
  const missing: string[] = [];
  for (const [key, opt] of optionsOf(manifest)) {
    if (opt.required && !String(values[key] ?? "").trim()) missing.push(key);
  }
  return missing;
}

const SUBSTITUTE_RE = /\$\{user_config\.([A-Za-z_]\w*)\}/g;
const PLUGIN_ROOT_RE = /\$\{CLAUDE_PLUGIN_ROOT\}/g;

/**
 * Fills `${user_config.<key>}` and, when `pluginRoot` is given, `${CLAUDE_PLUGIN_ROOT}` (the
 * plugin's installed folder, which Claude-format hooks, MCP servers and commands refer to).
 */
export function substituteUserConfig(text: string, values: Record<string, string>, pluginRoot?: string): string {
  const out = text.replace(SUBSTITUTE_RE, (_, k: string) => values[k] ?? "");
  return pluginRoot === undefined ? out : out.replace(PLUGIN_ROOT_RE, () => pluginRoot);
}

export function substituteDeep<T>(value: T, values: Record<string, string>, pluginRoot?: string): T {
  if (typeof value === "string") return substituteUserConfig(value, values, pluginRoot) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => substituteDeep(v, values, pluginRoot)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteDeep(v, values, pluginRoot);
    return out as unknown as T;
  }
  return value;
}
