import {
  Sun, Mailbox, SquareActivity, ListChecks, GitPullRequest, ShieldCheck, ScrollText, FlaskConical,
  Clock, type LucideIcon,
} from "lucide-react";
import type { Translations } from "@/lib/i18n";

type S = Translations["scheduled"];

export interface TaskTemplate {
  id: string;
  icon: LucideIcon;
  /** Locale keys of its name, description and the instructions it fills in. */
  name: keyof S;
  desc: keyof S;
  prompt: keyof S;
  cron: string;
}

// The minutes are off the hour on purpose, as in Claude: tasks made from the same template by
// many people don't all start at once.
export const TEMPLATES: TaskTemplate[] = [
  { id: "brief", icon: Sun, name: "tplBriefName", desc: "tplBriefDesc", prompt: "tplBriefPrompt", cron: "18 7 * * 1-5" },
  { id: "email", icon: Mailbox, name: "tplEmailName", desc: "tplEmailDesc", prompt: "tplEmailPrompt", cron: "52 7 * * 1-5" },
  { id: "health", icon: SquareActivity, name: "tplHealthName", desc: "tplHealthDesc", prompt: "tplHealthPrompt", cron: "47 7 * * *" },
  { id: "issues", icon: ListChecks, name: "tplIssuesName", desc: "tplIssuesDesc", prompt: "tplIssuesPrompt", cron: "23 7 * * 1-5" },
  { id: "prs", icon: GitPullRequest, name: "tplPrsName", desc: "tplPrsDesc", prompt: "tplPrsPrompt", cron: "49 7 * * 1-5" },
  { id: "deps", icon: ShieldCheck, name: "tplDepsName", desc: "tplDepsDesc", prompt: "tplDepsPrompt", cron: "16 15 * * 1" },
  { id: "release", icon: ScrollText, name: "tplReleaseName", desc: "tplReleaseDesc", prompt: "tplReleasePrompt", cron: "0 16 * * 5" },
  { id: "flaky", icon: FlaskConical, name: "tplFlakyName", desc: "tplFlakyDesc", prompt: "tplFlakyPrompt", cron: "54 15 * * 1" },
];

/** A task's icon: its template's, or a clock. */
export function taskIcon(template: string | undefined): LucideIcon {
  return TEMPLATES.find((t) => t.id === template)?.icon ?? Clock;
}
