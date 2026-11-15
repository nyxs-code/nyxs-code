import { invoke } from "@/lib/ipc";
import { isTauri, listDir, pathExists } from "./paths";
import { joinPath } from "./catalog";
import { parsePluginManifest, type PluginManifest } from "./schema";
import type { ConfigError } from "@/lib/configSchema";

export interface ValidationReport {
  ok: boolean;
  manifest: PluginManifest | null;
  errors: ConfigError[];
  warnings: string[];
}

async function readText(path: string): Promise<string> {
  try {
    return await invoke<string>("nyxs_read_text", { path });
  } catch {
    return "";
  }
}

function toList(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

export async function validatePlugin(pluginDir: string): Promise<ValidationReport> {
  const errors: ConfigError[] = [];
  const warnings: string[] = [];

  if (!isTauri) {
    return { ok: false, manifest: null, errors: [{ file: pluginDir, path: "", message: "Validation requires the desktop app." }], warnings };
  }

  const manifestPath =
    (await pathExists(joinPath(pluginDir, ".nyxs-plugin/plugin.json")))
      ? joinPath(pluginDir, ".nyxs-plugin/plugin.json")
      : joinPath(pluginDir, "plugin.json");
  const raw = await readText(manifestPath);
  if (!raw.trim()) {
    errors.push({ file: manifestPath, path: "", message: "No .nyxs-plugin/plugin.json found." });
    return { ok: false, manifest: null, errors, warnings };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    errors.push({ file: manifestPath, path: "", message: "plugin.json is not valid JSON." });
    return { ok: false, manifest: null, errors, warnings };
  }

  const { manifest, errors: schemaErrors } = parsePluginManifest(json, manifestPath);
  errors.push(...schemaErrors);
  if (!manifest) return { ok: false, manifest: null, errors, warnings };

  const checkPath = async (rel: string, what: string) => {
    if (!(await pathExists(joinPath(pluginDir, rel)))) {
      errors.push({ file: manifestPath, path: what, message: `Declared ${what} not found: ${rel}` });
    }
  };

  const c = manifest.commands;
  if (typeof c === "string" || Array.isArray(c)) {
    for (const rel of toList(c)) await checkPath(rel, "commands");
  } else if (c && typeof c === "object") {
    for (const [name, meta] of Object.entries(c)) {
      if (meta.source) await checkPath(meta.source, `commands.${name}`);
      else if (!meta.content) {
        errors.push({ file: manifestPath, path: `commands.${name}`, message: "Command has neither source nor content." });
      }
    }
  }
  for (const rel of toList(manifest.agents)) await checkPath(rel, "agents");
  for (const rel of toList(manifest.skills)) await checkPath(rel, "skills");
  for (const rel of toList(manifest.outputStyles)) await checkPath(rel, "outputStyles");

  const hasFolder = async (folder: string) => (await listDir(joinPath(pluginDir, folder))).length > 0;
  const contributes =
    Boolean(manifest.commands || manifest.agents || manifest.skills || manifest.outputStyles || manifest.hooks || manifest.mcpServers) ||
    (await hasFolder("commands")) ||
    (await hasFolder("agents")) ||
    (await hasFolder("skills")) ||
    (await hasFolder("output-styles"));
  if (!contributes) warnings.push("Plugin declares no components (commands/agents/skills/output-styles/hooks/mcpServers).");

  return { ok: errors.length === 0, manifest, errors, warnings };
}
