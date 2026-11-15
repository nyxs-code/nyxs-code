import { getCachedPluginComponents } from "@/lib/plugins/pluginLoader";

export interface OutputStyle {
  id: string;
  name: string;
  description: string;
  prompt: string;
}

export const OUTPUT_STYLES: OutputStyle[] = [
  {
    id: "default",
    name: "Default",
    description: "Concise and direct, focused on the task",
    prompt: "",
  },
  {
    id: "explanatory",
    name: "Explanatory",
    description: "Explains the why and the key decisions",
    prompt:
      "Beyond completing the task, explain your reasoning and the key decisions as you go, in clear prose. Surface trade-offs and why you chose a given approach, so the user learns from your process. Keep explanations relevant — don't pad.",
  },
  {
    id: "learning",
    name: "Learning",
    description: "Teaches you while it codes",
    prompt:
      "Act as a mentor. Explain concepts as you work, and where helpful leave small, clearly-marked 'TODO(you):' pieces for the user to implement, with guidance on how. Teach the underlying ideas, not just the solution.",
  },
  {
    id: "concise",
    name: "Ultra concise",
    description: "Minimal text, only the essentials",
    prompt:
      "Keep prose to an absolute minimum. Prefer doing over explaining. Reply in one or two short sentences unless the user explicitly asks for detail.",
  },
  {
    id: "proactive",
    name: "Proactive",
    description: "Works autonomously, with fewer questions",
    prompt:
      "Work proactively and autonomously. Start implementing right away, make reasonable assumptions on routine, low-risk decisions instead of asking, and prefer action over planning. Treat course corrections from the user as normal input. This is not a license for destructive actions: anything that deletes data or touches shared or production systems still needs the user's explicit confirmation.",
  },
];

export const DEFAULT_OUTPUT_STYLE = "default";

function pluginOutputStyles(): OutputStyle[] {
  return getCachedPluginComponents().outputStyles.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    prompt: s.prompt,
  }));
}

export function getAllOutputStyles(): OutputStyle[] {
  return [...OUTPUT_STYLES, ...pluginOutputStyles()];
}

export function getOutputStyle(id: string): OutputStyle {
  return getAllOutputStyles().find((s) => s.id === id) ?? OUTPUT_STYLES[0];
}
