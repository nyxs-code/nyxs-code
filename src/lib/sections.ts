export type Section = "chat" | "code" | "projects" | "routines" | "artifacts" | "customize" | "feedback";

const SECTION_LABELS: Record<Section, string> = {
  chat: "Chat",
  code: "Code",
  projects: "Projects",
  routines: "Scheduled",
  artifacts: "Artifacts",
  customize: "Plugins",
  feedback: "Feedback",
};

export function sectionLabel(id: Section): string {
  return SECTION_LABELS[id] ?? id;
}
