import type { SkillDef } from "@/lib/skills";
import makeColors from "./make-colors.js?raw";
import body from "./mods.md?raw";

/** The built-in `plugin-authoring` skill: how the agent writes a mod (a theme, a scene, a command)
 *  in Claude Code's format for Nyxs to load. Its folder (`${NYXS_DEV_MODS_DIR}`) is filled in for
 *  the session when the skill is read. A project or user skill with the same name replaces it. */
export const MODS_SKILL: SkillDef = {
  name: "plugin-authoring",
  dir: "",
  source: "builtin",
  description:
    "Make a mod: a change to Nyxs' own look and behaviour, such as a theme with custom colors and an animated background, a / command, a card above the chat box or a toast, in Claude Code's mod format.",
  whenToUse:
    "When the user asks to change how Nyxs looks (a theme, colors, an animated or image background, a custom look), or for a / command, card, status line or toast of their own in the app.",
  body: body.trim().replace("{{MAKE_COLORS}}", () => makeColors.trim()),
};
