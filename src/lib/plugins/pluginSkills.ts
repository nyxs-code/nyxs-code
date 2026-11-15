import { invoke } from "@/lib/ipc";
import { isTauri, listDir } from "./paths";
import { joinPath } from "./catalog";
import { listInstalled } from "./install";
import { getEnabledPlugins } from "./pluginSettings";

export interface RawPluginSkill {
  name: string;
  dir: string;
  content: string;
  plugin: string;
}

let memo: RawPluginSkill[] | null = null;

export function clearPluginComponentsCache(): void {
  memo = null;
}

export async function loadPluginRawSkills(): Promise<RawPluginSkill[]> {
  if (!isTauri) return [];
  if (memo) return memo;

  const [installed, enabledIds] = await Promise.all([listInstalled(), getEnabledPlugins()]);
  const enabledSet = new Set(enabledIds);
  const enabled = installed.filter((p) => enabledSet.has(p.id));

  const out: RawPluginSkill[] = [];
  for (const p of enabled) {
    const skillsRoot = joinPath(p.installLocation, "skills");
    const names = await listDir(skillsRoot);
    for (const name of names) {
      const dir = joinPath(skillsRoot, name);
      try {
        const content = await invoke<string>("nyxs_read_text", {
          path: joinPath(dir, "SKILL.md"),
        });
        if (content.trim()) out.push({ name, dir, content, plugin: p.id });
      } catch {
        // No SKILL.md in this entry (e.g. a stray file) — skip it.
      }
    }
  }

  memo = out;
  return out;
}
