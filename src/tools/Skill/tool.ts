import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { resolveSkillContent } from "@/lib/skills";
import { devModsDir } from "@/lib/mods/devModsDir";
import { getSkillDescription } from "@/tools/Skill/prompt";
import type { ToolContext } from "@/tools/context";
import { checkGate } from "@/tools/gate";

export function addSkillTools(tools: ToolSet, ctx: ToolContext): void {
  const { skills, gate } = ctx;
  const byName = new Map(skills.map((s) => [s.name, s]));
  tools.Skill = tool({
    description: getSkillDescription(),
    inputSchema: z.object({
      skill: z.string().describe('Skill name, e.g. "commit".'),
      args: z.string().optional().describe("Optional arguments for the skill."),
    }),
    execute: async ({ skill, args }) => {
      const name = skill.trim().replace(/^\//, "");
      const def = byName.get(name);
      if (!def) {
        return `Unknown skill: ${name}. Available: ${[...byName.keys()].join(", ")}`;
      }
      const denied = await checkGate(gate, "Skill", { skill: name });
      if (denied) return denied;
      const content = resolveSkillContent(def, args ?? "");
      // The mods skill names this session's own folder for the mods it writes.
      if (!content.includes("${NYXS_DEV_MODS_DIR}")) return content;
      const dir = ctx.sessionKey ? await devModsDir(ctx.sessionKey) : null;
      return content.replaceAll("${NYXS_DEV_MODS_DIR}", dir ?? "~/.nyxs/dev-mods/<this session's id>");
    },
  });
}
