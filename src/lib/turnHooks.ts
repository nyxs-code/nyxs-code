import type { ToolSet } from "ai";
import {
  hasHooks,
  loadMergedHooks,
  loadMergedHooksAsync,
  runHooks,
  type HookEvent,
  type HookInput,
  type HookOutcome,
  type HooksConfig,
} from "./hooks";
import { settingsKnownFor } from "./settingsRuntime";

export interface HookVerdict {
  /** Stdout of the hooks that succeeded, to add to the model's context. */
  context: string[];
  blocking: string[];
  blocked: boolean;
}

export interface TurnHooks {
  has: (event: HookEvent) => boolean;
  fire: (input: HookInput) => Promise<HookVerdict>;
}

/** The user's hooks for one turn. Disabled outside Tauri, where they can't run. */
export function createTurnHooks(o: {
  enabled: boolean;
  workspace?: string | null;
  signal?: AbortSignal;
  emit: (text: string) => void;
}): TurnHooks {
  // The hooks of the turn's own folder. Until they're read, `has` says yes so a guard hook can't
  // be skipped, and `fire` waits for them.
  let config: HooksConfig | null = !o.enabled ? {} : settingsKnownFor(o.workspace) ? loadMergedHooks(o.workspace) : null;
  const ready: Promise<HooksConfig> = config
    ? Promise.resolve(config)
    : loadMergedHooksAsync(o.workspace)
        .catch(() => loadMergedHooks(o.workspace))
        .then((c) => (config = c));
  const report = (event: string, h: HookOutcome) => {
    const label = h.statusMessage || h.command;
    const icon = h.outcome === "success" ? "✓" : h.outcome === "blocking" ? "⛔" : "⚠️";
    o.emit(`\n\n> 🪝 **${event}** · \`${label}\` — ${icon}`);
    const body = (h.stderr || h.stdout).trim();
    if (body && h.outcome !== "success") {
      const lines = body.split("\n").slice(0, 20).join("\n> ");
      o.emit(`\n>\n> ${lines}`);
    }
    o.emit("\n\n");
  };
  return {
    has: (event) => o.enabled && (config === null || hasHooks(config, event)),
    fire: async (input) => {
      if (!o.enabled) return { context: [], blocking: [], blocked: false };
      const res = await runHooks(await ready, input, o.workspace, (h) => report(input.hook_event_name, h), o.signal);
      const context = res.outcomes
        .filter((h) => h.outcome === "success" && h.stdout.trim())
        .map((h) => h.stdout.trim());
      return { context, blocking: res.blockingFeedback, blocked: res.outcomes.some((h) => h.outcome === "blocking") };
    },
  };
}

/** Runs PreToolUse hooks before every tool; a blocking hook stops the call. */
export function guardWithPreToolUse(tools: ToolSet, hooks: TurnHooks, workspace?: string | null): void {
  if (!hooks.has("PreToolUse")) return;
  for (const [name, t] of Object.entries(tools)) {
    const run = (t as { execute?: (input: unknown, opts: unknown) => unknown }).execute;
    if (!run) continue;
    tools[name] = {
      ...t,
      execute: async (input: unknown, opts: unknown) => {
        const verdict = await hooks.fire({
          hook_event_name: "PreToolUse",
          cwd: workspace ?? undefined,
          tool_name: name,
          tool_input: input,
        });
        if (verdict.blocked) {
          const why = verdict.blocking.join("\n").trim() || "no reason given";
          return `Blocked by a PreToolUse hook — the tool did NOT run. Hook feedback:\n${why}`;
        }
        return run(input, opts);
      },
    } as typeof t;
  }
}
