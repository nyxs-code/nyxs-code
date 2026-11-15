import { invoke } from "@/lib/ipc";
import type { ModelInfo } from "./models";
import { EFFORT_LEVELS, type EffortLevel } from "./effort";
import { settingsFor } from "./settingsRuntime";

// The models Claude Code offers and the effort levels each one takes.

export const CLAUDE_CODE_CONNECTED = "subscription";

const CLAUDE_CODE_ALIASES: { alias: string; name: string }[] = [
  { alias: "fable", name: "Fable" },
  { alias: "opus", name: "Opus" },
  { alias: "sonnet", name: "Sonnet" },
  { alias: "haiku", name: "Haiku" },
];

export const CLAUDE_CODE_MODELS: ModelInfo[] = CLAUDE_CODE_ALIASES.map(({ alias, name }) => ({
  id: `claude-code:${alias}`,
  apiModel: alias,
  name,
  description: "Claude Code",
  provider: "claude-code",
}));

export const CLAUDE_CODE_DEFAULT_ENABLED = ["claude-code:opus", "claude-code:sonnet"];

interface CliModel {
  value?: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
}

export async function fetchClaudeCodeModels(): Promise<ModelInfo[]> {
  const listed = await invoke<{ models?: CliModel[] }>("claude_code_list_models");
  const models = (listed.models ?? [])
    .filter((m): m is CliModel & { value: string } => typeof m.value === "string" && m.value !== "default")
    .map((m) => {
      const resolved = m.resolvedModel && m.resolvedModel !== m.value ? ` → ${m.resolvedModel}` : "";
      return {
        id: `claude-code:${m.value}`,
        apiModel: m.value,
        name: m.displayName || m.value,
        description: `${m.description ?? "Claude Code"}${resolved}`,
        provider: "claude-code" as const,
        effortLevels: m.supportsEffort ? (m.supportedEffortLevels ?? []) : [],
      };
    });
  if (!models.length) throw new Error("Claude Code no devolvió modelos");
  return models;
}

const CLAUDE_EFFORT: Record<EffortLevel, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  extra: "xhigh",
  max: "max",
};

const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];

const FROM_CLAUDE_EFFORT: Record<string, EffortLevel> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "extra",
  max: "max",
};

/** The `--effort` value a turn runs with: the chosen level, or the closest one below it
 *  that the model supports (the CLI would clamp it the same way). Null: no effort at all. */
export function effortFor(model: ModelInfo, effort: EffortLevel): string | null {
  const wanted = CLAUDE_EFFORT[effort];
  const levels = model.effortLevels;
  if (!levels) return wanted;
  if (!levels.length) return null;
  for (let i = EFFORT_ORDER.indexOf(wanted); i >= 0; i--) {
    if (levels.includes(EFFORT_ORDER[i])) return EFFORT_ORDER[i];
  }
  return levels[0];
}

/** The levels the effort menu offers for a Claude Code model. Null when the model has no
 *  effort setting; every level when its list isn't known yet (an older saved model list). */
export function claudeCodeEffortLevels(model: ModelInfo): EffortLevel[] | null {
  const levels = model.effortLevels;
  if (!levels) return [...EFFORT_LEVELS];
  const offered = EFFORT_LEVELS.filter((l) => levels.includes(CLAUDE_EFFORT[l]));
  return offered.length ? offered : null;
}

/** The level a Claude Code turn will really use for the chosen one. */
export function claudeCodeEffectiveEffort(model: ModelInfo, effort: EffortLevel): EffortLevel | null {
  const e = effortFor(model, effort);
  return e ? FROM_CLAUDE_EFFORT[e] ?? null : null;
}

/**
 * Whether a Claude Code process in `cwd` must start without the folder's own `.claude/` settings
 * and `.mcp.json`: the user hasn't trusted them (settingsRuntime.ts), or that can't be told.
 * Probes count too: the CLI runs the repo's apiKeyHelper or hooks before any message.
 */
export async function claudeFolderUntrusted(cwd: string | null | undefined): Promise<boolean> {
  if (!cwd) return false;
  try {
    return (await settingsFor(cwd)).projectTrusted !== true;
  } catch {
    return true;
  }
}

const defaultEfforts = new Map<string, Promise<EffortLevel | null>>();

/** The level Claude Code itself picks for a model in this folder (its recommendation),
 *  read from the CLI's effective settings once per app run. */
export async function claudeCodeDefaultEffort(apiModel: string, workspace?: string | null): Promise<EffortLevel | null> {
  const untrustedProject = await claudeFolderUntrusted(workspace);
  const key = `${apiModel}|${workspace ?? ""}|${untrustedProject}`;
  let pending = defaultEfforts.get(key);
  if (!pending) {
    pending = invoke<string | null>("claude_code_default_effort", { model: apiModel, cwd: workspace ?? null, untrustedProject }).then(
      (e) => (e ? FROM_CLAUDE_EFFORT[e] ?? null : null),
      () => {
        defaultEfforts.delete(key);
        return null;
      },
    );
    defaultEfforts.set(key, pending);
  }
  return pending;
}
