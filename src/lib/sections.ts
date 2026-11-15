export type Section = "chat" | "code" | "routines" | "dispatch" | "customize" | "feedback";

const SECTION_LABELS: Record<Section, string> = {
  chat: "Chat",
  code: "Code",
  routines: "Routines",
  dispatch: "Dispatch",
  customize: "Customize",
  feedback: "Feedback",
};

export function sectionLabel(id: Section): string {
  return SECTION_LABELS[id] ?? id;
}
