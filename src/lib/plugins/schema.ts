import { z } from "zod";
import { hookCommandSchema, hookMatcherSchema, mcpServerSchema, type ConfigError } from "../configSchema";

export const marketplaceSourceSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("github"), repo: z.string().min(1) }),
  z.object({ source: z.literal("git"), url: z.string().min(1) }),
  z.object({ source: z.literal("url"), url: z.string().url() }),
  z.object({ source: z.literal("npm"), package: z.string().min(1) }),
  z.object({ source: z.literal("file"), path: z.string().min(1) }),
  z.object({ source: z.literal("directory"), path: z.string().min(1) }),
]);

export type MarketplaceSource = z.infer<typeof marketplaceSourceSchema>;

export const knownMarketplaceSchema = z.object({
  name: z.string().min(1),
  source: marketplaceSourceSchema,
  installLocation: z.string().min(1),
  lastUpdated: z.number().optional(),
  autoUpdate: z.boolean().default(false),
});

export type KnownMarketplace = z.infer<typeof knownMarketplaceSchema>;

export const knownMarketplacesFileSchema = z.object({
  version: z.literal(1).default(1),
  marketplaces: z.array(knownMarketplaceSchema).default([]),
});

export type KnownMarketplacesFile = z.infer<typeof knownMarketplacesFileSchema>;

export const pluginSourceSchema = z
  .union([z.string(), z.record(z.string(), z.unknown())])
  .optional();

export type PluginSource = z.infer<typeof pluginSourceSchema>;

const authorLike = z.preprocess(
  (v) => (v && typeof v === "object" ? (v as { name?: string }).name ?? undefined : v),
  z.string().optional(),
);

export const catalogPluginSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  version: z.string().default("0.0.0"),
  author: authorLike,
  category: z.string().optional(),
  keywords: z.array(z.string()).default([]),
  homepage: z.string().optional(),
  source: pluginSourceSchema,
});

export type CatalogPlugin = z.infer<typeof catalogPluginSchema>;

export const marketplaceCatalogSchema = z.object({
  name: z.string().optional(),
  owner: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  plugins: z.array(catalogPluginSchema).default([]),
});

export type MarketplaceCatalog = z.infer<typeof marketplaceCatalogSchema>;

export const installedPluginSchema = z.object({
  id: z.string().min(1),
  plugin: z.string().min(1),
  marketplace: z.string().min(1),
  version: z.string().min(1),
  installLocation: z.string().min(1),
  installedAt: z.number(),
  sha: z.string().optional(),
});

export type InstalledPlugin = z.infer<typeof installedPluginSchema>;

export const installedPluginsFileSchema = z.object({
  version: z.literal(1).default(1),
  plugins: z.array(installedPluginSchema).default([]),
});

export type InstalledPluginsFile = z.infer<typeof installedPluginsFileSchema>;

export function pluginId(plugin: string, marketplace: string): string {
  return `${plugin}@${marketplace}`;
}

export function parsePluginId(id: string): { plugin: string; marketplace: string } | null {
  const at = id.lastIndexOf("@");
  if (at <= 0 || at === id.length - 1) return null;
  return { plugin: id.slice(0, at), marketplace: id.slice(at + 1) };
}

export const pluginAuthorSchema = z.object({
  name: z.string().min(1, "Author name cannot be empty."),
  email: z.string().optional(),
  url: z.string().optional(),
});

export type PluginAuthor = z.infer<typeof pluginAuthorSchema>;

export const USER_CONFIG_TYPES = ["string", "number", "boolean", "directory", "file"] as const;

export const userConfigOptionSchema = z.object({
  type: z.enum(USER_CONFIG_TYPES),
  title: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
  multiple: z.boolean().optional(),
  sensitive: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});

export type UserConfigOption = z.infer<typeof userConfigOptionSchema>;

export const commandMetadataSchema = z.object({
  source: z.string().optional(),
  content: z.string().optional(),
  description: z.string().optional(),
  argumentHint: z.string().optional(),
  model: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
});

export type CommandMetadata = z.infer<typeof commandMetadataSchema>;

const pathOrPathsSchema = z.union([z.string(), z.array(z.string())]);
const manifestCommandsSchema = z.union([
  z.string(),
  z.array(z.string()),
  z.record(z.string(), commandMetadataSchema),
]);

export const pluginHooksMapSchema = z.record(z.string(), z.array(hookMatcherSchema));
export type PluginHooksMap = z.infer<typeof pluginHooksMapSchema>;
export const pluginMcpMapSchema = z.record(z.string(), mcpServerSchema);
export type PluginMcpMap = z.infer<typeof pluginMcpMapSchema>;

/** Claude-format manifests give hooks and MCP servers inline, as a path to a JSON file, or a list of both. */
function inlineOrPaths<T extends z.ZodTypeAny>(inline: T) {
  return z.union([z.string(), inline, z.array(z.union([z.string(), inline]))]);
}

export const pluginManifestSchema = z.object({
  name: z
    .string()
    .min(1, "Plugin name cannot be empty.")
    .refine((n) => !n.includes(" "), {
      message: 'Plugin name cannot contain spaces. Use kebab-case (e.g. "my-plugin").',
    }),
  version: z.string().optional(),
  description: z.string().optional(),
  // Many manifests write the author as plain text.
  author: z.preprocess((v) => (typeof v === "string" ? { name: v } : v), pluginAuthorSchema).optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  dependencies: z.array(z.string()).optional(),

  commands: manifestCommandsSchema.optional(),
  agents: pathOrPathsSchema.optional(),
  skills: pathOrPathsSchema.optional(),
  outputStyles: pathOrPathsSchema.optional(),
  hooks: inlineOrPaths(pluginHooksMapSchema).optional(),
  mcpServers: inlineOrPaths(pluginMcpMapSchema).optional(),

  userConfig: z.record(z.string(), userConfigOptionSchema).optional(),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export type PluginSourceKind = "marketplace" | "local" | "builtin";

export interface LoadedPlugin {
  name: string;
  id: string;
  marketplace: string;
  manifest: PluginManifest;
  path: string;
  source: PluginSourceKind;
  enabled: boolean;
  sha?: string;
  isBuiltin?: boolean;
}

function collectIssues(error: z.ZodError, file: string, errors: ConfigError[], base: (string | number)[] = []): void {
  for (const issue of error.issues) {
    errors.push({
      file,
      path: [...base, ...issue.path].map((p) => String(p)).join("."),
      message: issue.message,
    });
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Keeps the entries of a map that pass `entry`, reporting the rest. */
function salvageRecord<T extends z.ZodTypeAny>(
  value: unknown,
  entry: T,
  file: string,
  errors: ConfigError[],
  base: (string | number)[],
): Record<string, z.infer<T>> | undefined {
  if (!isRecord(value)) {
    errors.push({ file, path: base.join("."), message: "Expected an object." });
    return undefined;
  }
  const out: Record<string, z.infer<T>> = {};
  for (const [key, v] of Object.entries(value)) {
    const r = entry.safeParse(v);
    if (r.success) out[key] = r.data;
    else collectIssues(r.error, file, errors, [...base, key]);
  }
  return out;
}

/**
 * Keeps the hooks Nyxs can run, one by one, reporting the rest. A hook with an `if` condition is
 * left out: running it without the condition would fire it on every matching tool call.
 */
export function salvageHooksMap(
  value: unknown,
  file: string,
  errors: ConfigError[],
  base: (string | number)[] = ["hooks"],
): PluginHooksMap | undefined {
  if (!isRecord(value)) {
    errors.push({ file, path: base.join("."), message: "Expected an object of hook events." });
    return undefined;
  }
  const out: PluginHooksMap = {};
  for (const [event, matchers] of Object.entries(value)) {
    if (!Array.isArray(matchers)) {
      errors.push({ file, path: [...base, event].join("."), message: "Expected a list of matchers." });
      continue;
    }
    const kept: PluginHooksMap[string] = [];
    matchers.forEach((m, i) => {
      const at = [...base, event, i];
      if (!isRecord(m) || !Array.isArray(m.hooks)) {
        errors.push({ file, path: at.join("."), message: "Expected { matcher?, hooks: [...] }." });
        return;
      }
      const hooks: PluginHooksMap[string][number]["hooks"] = [];
      m.hooks.forEach((h, j) => {
        const path = [...at, "hooks", j].join(".");
        if (isRecord(h) && "if" in h) {
          errors.push({ file, path, message: 'Hooks with an "if" condition aren\'t supported yet; this one was skipped.' });
          return;
        }
        if (isRecord(h) && h.type !== "command") {
          errors.push({ file, path, message: `Only "command" hooks are supported; this "${String(h.type)}" hook was skipped.` });
          return;
        }
        const r = hookCommandSchema.safeParse(h);
        if (r.success) hooks.push(r.data);
        else collectIssues(r.error, file, errors, [...at, "hooks", j]);
      });
      if (!hooks.length) return;
      const matcher = typeof m.matcher === "string" ? { matcher: m.matcher } : {};
      kept.push({ ...matcher, hooks });
    });
    if (kept.length) out[event] = kept;
  }
  return out;
}

function salvageInlineOrPaths<T>(
  value: unknown,
  salvageInline: (v: unknown, base: (string | number)[]) => T | undefined,
  base: string,
): string | T | (string | T)[] | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return salvageInline(value, [base]);
  const out: (string | T)[] = [];
  value.forEach((v, i) => {
    const s = typeof v === "string" ? v : salvageInline(v, [base, i]);
    if (s !== undefined) out.push(s);
  });
  return out;
}

/**
 * Validates a plugin.json field by field: a field the schema doesn't accept is reported and left
 * out, instead of throwing the whole manifest away. Only a non-object gives `manifest: null`.
 */
export function parsePluginManifest(
  raw: unknown,
  file = "plugin.json",
): { manifest: PluginManifest | null; errors: ConfigError[] } {
  const errors: ConfigError[] = [];
  if (!isRecord(raw)) {
    errors.push({ file, path: "", message: "plugin.json must be a JSON object." });
    return { manifest: null, errors };
  }
  const out: Record<string, unknown> = {};
  const shape = pluginManifestSchema.shape;
  for (const key of Object.keys(shape) as (keyof typeof shape)[]) {
    const value = raw[key];
    if (value === undefined) continue;
    let candidate: unknown = value;
    if (key === "hooks") {
      candidate = salvageInlineOrPaths(value, (v, base) => salvageHooksMap(v, file, errors, base), key);
    } else if (key === "mcpServers") {
      candidate = salvageInlineOrPaths(value, (v, base) => salvageRecord(v, mcpServerSchema, file, errors, base), key);
    } else if (key === "userConfig") {
      candidate = salvageRecord(value, userConfigOptionSchema, file, errors, [key]);
    } else if (key === "commands" && isRecord(value)) {
      candidate = salvageRecord(value, commandMetadataSchema, file, errors, [key]);
    }
    if (candidate === undefined) continue;
    const r = shape[key].safeParse(candidate);
    if (r.success) {
      if (r.data !== undefined) out[key] = r.data;
    } else {
      collectIssues(r.error, file, errors, [key]);
    }
  }
  return { manifest: { ...out, name: typeof out.name === "string" ? out.name : "" } as PluginManifest, errors };
}
