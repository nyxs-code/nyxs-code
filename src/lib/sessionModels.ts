import { PROVIDERS, type ModelInfo } from "@/lib/models";
import { hasKey, type Settings } from "@/lib/settings";
import { EFFORT_LEVELS, type EffortLevel } from "@/lib/effort";

/** The models a session started from another one can run on: with a key, and not an agent that
 *  runs its own terminal (those can't be driven from here). */
export function drivableModels(settings: Settings): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const [provider, cfg] of Object.entries(settings)) {
    if (!hasKey(settings, provider as ModelInfo["provider"])) continue;
    if (PROVIDERS[provider as ModelInfo["provider"]]?.kind === "agent-cli") continue;
    for (const m of (cfg as { models?: ModelInfo[] }).models ?? []) out.push(m);
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_\-.:/]+/g, "");

/** The model the user asked for, by id or by name as they'd say it ("opus", "gpt 5", "Sonnet
 *  4.5"): an exact id first, then the same name, then the only model whose name contains it.
 *  Undefined when nothing, or more than one model, fits. */
export function resolveSessionModel(wanted: string, models: ModelInfo[]): ModelInfo | undefined {
  const w = wanted.trim();
  if (!w) return undefined;
  const exact = models.find((m) => m.id === w || m.aliases?.includes(w));
  if (exact) return exact;
  const n = norm(w);
  const same = models.filter((m) => norm(m.id) === n || norm(m.apiModel) === n || norm(m.name) === n);
  if (same.length) return same[0];
  // An id from another provider's catalog ("anthropic:claude-haiku-5-5") for a model the user has
  // through another one (Claude Code's "Haiku 5.5"): compare without the provider and the brand.
  const bare = (s: string) => norm(s.replace(/^[\w-]+:/, "")).replace(/^(claude|anthropic|openai)/, "");
  const b = bare(w);
  const sameBare = b ? models.filter((m) => bare(m.name) === b || bare(m.apiModel) === b || bare(m.id) === b) : [];
  if (sameBare.length) return sameBare[0];
  const partial = models.filter((m) => norm(m.name).includes(n) || norm(m.apiModel).includes(n));
  // Several versions of one family ("opus 4.1", "opus 4.5"): the first listed is the newest.
  return partial.length === 1 || (partial.length > 1 && partial.every((m) => m.provider === partial[0].provider)) ? partial[0] : undefined;
}

/** An effort the user named, in English or Spanish ("alto", "máximo"). */
export function resolveEffort(wanted: string | undefined): EffortLevel | undefined {
  if (!wanted) return undefined;
  const w = wanted.trim().toLowerCase();
  if ((EFFORT_LEVELS as string[]).includes(w)) return w as EffortLevel;
  const words: Record<string, EffortLevel> = {
    bajo: "low", baja: "low", minimal: "low",
    medio: "medium", media: "medium", normal: "medium",
    alto: "high", alta: "high",
    "extra high": "extra", xhigh: "extra", "muy alto": "extra",
    maximo: "max", máximo: "max", maximum: "max",
  };
  return words[w];
}
