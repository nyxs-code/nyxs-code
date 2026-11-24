import { invoke } from "@/lib/ipc";
import { parsePluginManifest, type PluginManifest } from "./schema";

/** An installed plugin's manifest, from whichever of its usual places has one. */
export async function readManifest(installLocation: string): Promise<PluginManifest | null> {
  for (const p of [
    `${installLocation}/.nyxs-plugin/plugin.json`,
    `${installLocation}/.claude-plugin/plugin.json`,
    `${installLocation}/plugin.json`,
  ]) {
    try {
      const raw = await invoke<string>("nyxs_read_text", { path: p });
      if (raw.trim()) return parsePluginManifest(JSON.parse(raw)).manifest;
    } catch {
      /* try next */
    }
  }
  return null;
}
