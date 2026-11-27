import { getLanguage } from "@/lib/i18n";
import type { Translations } from "@/locales/types";
import type { PartKind, PluginParts } from "@/lib/plugins/pluginDetails";
import { partKinds } from "@/lib/plugins/pluginDetails";

type PageText = Translations["customizePage"];

const LABELS: Record<PartKind, [keyof PageText, keyof PageText]> = {
  hook: ["kindHook", "kindHooks"],
  command: ["kindCommand", "kindCommands"],
  agent: ["kindAgent", "kindAgents"],
  skill: ["kindSkill", "kindSkills"],
  localMcp: ["kindLocalMcp", "kindLocalMcps"],
  mcp: ["kindMcp", "kindMcps"],
  outputStyle: ["kindStyle", "kindStyles"],
};

/** What a plugin adds, as Claude's list says it: "Hooks, agent and commands". Empty when it adds
 *  nothing Nyxs can list. */
export function partsLine(parts: PluginParts | undefined, t: PageText): string {
  if (!parts) return "";
  const words = partKinds(parts).map(({ kind, count }) => t[LABELS[kind][count === 1 ? 0 : 1]]);
  if (!words.length) return "";
  const line = new Intl.ListFormat(getLanguage(), { type: "conjunction" }).format(words);
  return line.charAt(0).toUpperCase() + line.slice(1);
}
