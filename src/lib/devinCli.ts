import type { AgentCliTurn } from "./agentCli";
import { streamAcpAgent, type AcpSpec } from "./acpAgent";
import type { ModelInfo } from "./models";

/**
 * Devin (Cognition's CLI) over the Agent Client Protocol (`devin acp`); the protocol itself is in
 * acpAgent.ts. Devin never signs in during a turn: its only auth method opens a browser sign-in,
 * so it runs on the one `devin auth login` saved.
 */

export const DEVIN_ACP: AcpSpec = {
  cli: "devin",
  label: "Devin",
  args: () => ["acp"],
  authMethods: [],
  authenticate: false,
  loginHint: "Inicia sesión con «devin auth login».",
  // Its session starts from a bundled catalog and offers the account's models a moment later.
  modelWaitMs: 10_000,
};

export function streamDevinCli(t: AgentCliTurn): Promise<string> {
  return streamAcpAgent(DEVIN_ACP, t);
}

const EFFORT_WORDS: Record<string, string | null> = {
  none: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  "x-high": "xhigh",
  max: "max",
};

/** "High Thinking Fast 1M" → { rest: "1M", effort: "high" }: the words that aren't a level or
 *  the speed. "No Thinking" is a level of its own (none), which Nyxs doesn't offer. */
function splitEffort(text: string): { rest: string; effort: string | null; leveled: boolean } {
  const words = text.split(/\s+/).filter(Boolean);
  const rest: string[] = [];
  let effort: string | null = null;
  let leveled = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const lower = word.toLowerCase();
    if (!leveled && lower === "no" && words[i + 1] === "Thinking") {
      leveled = true;
      i++;
    } else if (!leveled && lower in EFFORT_WORDS) {
      leveled = true;
      effort = EFFORT_WORDS[lower];
      if (words[i + 1] === "Thinking") i++;
    } else if (word !== "Fast") rest.push(word);
  }
  return { rest: rest.join(" "), effort, leveled };
}

/** A variant's label relative to its family: what sets its group apart ("1M", a Fusion pair)
 *  and its level. */
function parseVariant(family: string, label: string): { qualifier: string; effort: string | null } {
  const rest = (label.startsWith(family) && (label.length === family.length || label[family.length] === " ") ? label.slice(family.length) : label).trim();
  const pair = /^\((.+) \+ (.+)\)$/.exec(rest);
  if (pair) {
    const primary = splitEffort(pair[1]);
    const sidekick = pair[2].replace(/\s+Fast$/, "");
    return { qualifier: `(${primary.rest} + ${sidekick})`, effort: primary.effort };
  }
  if (rest.startsWith("(") || rest.includes("+")) return { qualifier: rest, effort: null };
  const { rest: qualifier, effort } = splitEffort(rest);
  return { qualifier, effort };
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join("-");
}

const LEVEL_ORDER = ["low", "medium", "high", "xhigh", "max"];

/**
 * Devin's catalog (`devin models list --format json`): families of variants, one per level and
 * speed ("SWE-2 Medium Fast"). Since CLI 3000.11 its session offers one id per group of variants
 * and takes the level as `thought_level`, so each group is one model here, its variants' ids the
 * ones the session may offer for it and its levels the ones they come in.
 */
export function parseDevinCatalog(text: string): ModelInfo[] {
  const start = text.indexOf("{");
  if (start < 0) return [];
  let data: { families?: { family_label?: string; variants?: { model_uid?: string; label?: string }[] }[] };
  try {
    data = JSON.parse(text.slice(start));
  } catch {
    return [];
  }
  const groups = new Map<string, { name: string; members: string[]; levels: Set<string> }>();
  for (const family of data.families ?? []) {
    const familyLabel = (family.family_label ?? "").trim();
    for (const variant of family.variants ?? []) {
      if (!variant.model_uid || !variant.label) continue;
      const { qualifier, effort } = parseVariant(familyLabel, variant.label.trim());
      const name = [familyLabel || variant.label, qualifier].filter(Boolean).join(" ");
      const group = groups.get(name) ?? { name, members: [], levels: new Set<string>() };
      group.members.push(variant.model_uid);
      if (effort) group.levels.add(effort);
      groups.set(name, group);
    }
  }
  return [...groups.values()].map((g) => ({
    id: `devin-cli:${slug(g.name)}`,
    apiModel: g.members[0],
    aliases: g.members.slice(1),
    name: g.name,
    description: "Devin",
    provider: "devin-cli" as const,
    effortLevels: LEVEL_ORDER.filter((l) => g.levels.has(l)),
  }));
}
