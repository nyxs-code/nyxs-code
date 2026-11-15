import { invoke } from "@/lib/ipc";
import { SOURCE_PRECEDENCE, settingsFor, settingsSnapshotFor } from "@/lib/settingsRuntime";
import { getCachedPluginComponents } from "@/lib/plugins/pluginLoader";

export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SessionStart",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface CommandHook {
  type: "command";
  command: string;
  timeout?: number;
  statusMessage?: string;
}

export interface HookMatcher {
  matcher?: string;
  hooks: CommandHook[];
}

export type HooksConfig = Partial<Record<HookEvent, HookMatcher[]>>;

function coerceHooksConfig(raw: unknown): HooksConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: HooksConfig = {};
  for (const [event, matchers] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) continue;
    const valid: HookMatcher[] = [];
    for (const m of matchers) {
      if (!m || typeof m !== "object") continue;
      const { matcher, hooks: rawHooks } = m as Record<string, unknown>;
      if (!Array.isArray(rawHooks)) continue;
      const coercedHooks: CommandHook[] = [];
      for (const h of rawHooks) {
        if (!h || typeof h !== "object") continue;
        const { command, timeout, statusMessage } = h as Record<string, unknown>;
        if (typeof command !== "string" || !command.trim()) continue;
        coercedHooks.push({
          type: "command",
          command,
          ...(typeof timeout === "number" ? { timeout } : {}),
          ...(typeof statusMessage === "string" ? { statusMessage } : {}),
        });
      }
      if (coercedHooks.length > 0) {
        valid.push({
          ...(typeof matcher === "string" ? { matcher } : {}),
          hooks: coercedHooks,
        });
      }
    }
    if (valid.length > 0) out[event as HookEvent] = valid;
  }
  return out;
}

function accumulateHooks(...configs: HooksConfig[]): HooksConfig {
  const out: HooksConfig = {};
  for (const cfg of configs) {
    for (const [rawEvent, matchers] of Object.entries(cfg)) {
      const event = rawEvent as HookEvent;
      if (!out[event]) out[event] = [];
      for (const m of matchers ?? []) {
        const existing = out[event]!;
        const isDup = existing.some(
          (e) =>
            e.matcher === m.matcher &&
            e.hooks.length === m.hooks.length &&
            e.hooks.every((h, i) => h.command === m.hooks[i]?.command),
        );
        if (!isDup) existing.push(m);
      }
    }
  }
  return out;
}

/** The hooks of the turns working in `workspace` (the open folder when not given): that folder's
 *  settings, not the open one's, so a turn keeps its own hooks when another project is opened. */
export function loadMergedHooks(workspace?: string | null): HooksConfig {
  const snap = settingsSnapshotFor(workspace).perSource;
  const fileHooks = SOURCE_PRECEDENCE.map((src) => {
    const raw = snap[src]?.hooks;
    return raw ? coerceHooksConfig(raw) : {};
  });

  const pluginHooks = getCachedPluginComponents().hooks;

  return accumulateHooks(...fileHooks, pluginHooks);
}

export async function loadMergedHooksAsync(workspace?: string | null): Promise<HooksConfig> {
  await settingsFor(workspace);
  return loadMergedHooks(workspace);
}

export function hasHooks(config: HooksConfig, event: HookEvent): boolean {
  return (config[event] ?? []).some((m) => m.hooks.length > 0);
}

export function matchesPattern(matchQuery: string, matcher: string | undefined): boolean {
  if (!matcher || matcher === "*") return true;
  if (/^[a-zA-Z0-9_|]+$/.test(matcher)) {
    if (matcher.includes("|")) {
      return matcher.split("|").map((p) => p.trim()).includes(matchQuery);
    }
    return matchQuery === matcher;
  }
  try {
    return new RegExp(matcher).test(matchQuery);
  } catch {
    return false;
  }
}

export interface HookInput {
  hook_event_name: HookEvent;
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  prompt?: string;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  timed_out: boolean;
}

export interface HookOutcome {
  command: string;
  statusMessage?: string;
  code: number;
  stdout: string;
  stderr: string;
  outcome: "success" | "blocking" | "error";
}

export interface AggregatedHookResult {
  outcomes: HookOutcome[];
  blockingFeedback: string[];
}

/** Past this, an environment variable may keep the process from starting at all (Windows caps
 *  one at 32,767 characters): a Write's whole file would. The whole input goes on stdin. */
const MAX_ENV_INPUT = 16_000;
const MAX_ENV_TEXT = 2_000;

/** `value` with every string longer than MAX_ENV_TEXT cut, saying how long it was. */
function cutLongTexts(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_ENV_TEXT ? `${value.slice(0, MAX_ENV_TEXT)}… [cut: ${value.length} characters]` : value;
  }
  if (Array.isArray(value)) return value.map(cutLongTexts);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cutLongTexts(v)]));
  return value;
}

function buildEnv(input: HookInput): Record<string, string> {
  const whole = JSON.stringify(input);
  const env: Record<string, string> = {
    NYXS_HOOK_EVENT: input.hook_event_name,
    NYXS_HOOK_INPUT: whole.length > MAX_ENV_INPUT ? JSON.stringify(cutLongTexts(input)) : whole,
  };
  if (whole.length > MAX_ENV_INPUT) env.NYXS_HOOK_INPUT_TRUNCATED = "1";
  if (input.cwd) env.NYXS_WORKSPACE = input.cwd;
  if (input.tool_name) env.NYXS_TOOL_NAME = input.tool_name;
  const ti = (input.tool_input ?? {}) as Record<string, unknown>;
  if (typeof ti.file_path === "string") {
    env.NYXS_FILE_PATH = ti.file_path;
    env.NYXS_FILE_PATHS = ti.file_path;
  }
  const text = (v: string) => cutLongTexts(v) as string;
  if (typeof ti.command === "string") env.NYXS_COMMAND = ti.command.length > MAX_ENV_INPUT ? text(ti.command) : ti.command;
  if (typeof input.prompt === "string") env.NYXS_PROMPT = input.prompt.length > MAX_ENV_INPUT ? text(input.prompt) : input.prompt;
  return env;
}

function matchQueryFor(input: HookInput): string {
  return input.tool_name ?? "";
}

export type HookReporter = (outcome: HookOutcome) => void;

export async function runHooks(
  config: HooksConfig,
  input: HookInput,
  workspace: string | null | undefined,
  report?: HookReporter,
  signal?: AbortSignal,
): Promise<AggregatedHookResult> {
  const result: AggregatedHookResult = { outcomes: [], blockingFeedback: [] };
  const matchers = config[input.hook_event_name] ?? [];
  if (matchers.length === 0) return result;

  const query = matchQueryFor(input);
  const env = buildEnv(input);
  // Whole on stdin, the way Claude Code's hooks read it; NYXS_HOOK_INPUT keeps its cut copy.
  const stdin = JSON.stringify(input);

  for (const m of matchers) {
    if (!matchesPattern(query, m.matcher)) continue;
    for (const hook of m.hooks) {
      if (signal?.aborted) return result;
      if (hook.type !== "command" || !hook.command.trim()) continue;
      let outcome: HookOutcome;
      try {
        const res = await invoke<RunResult>("agent_run", {
          command: hook.command,
          cwd: workspace ?? undefined,
          timeoutMs: (hook.timeout ?? 60) * 1000,
          env,
          stdin,
        });
        const kind = res.code === 0 ? "success" : res.code === 2 ? "blocking" : "error";
        outcome = {
          command: hook.command,
          statusMessage: hook.statusMessage,
          code: res.code,
          stdout: res.stdout,
          stderr: res.stderr,
          outcome: kind,
        };
        if (kind === "blocking" && res.stderr.trim()) {
          result.blockingFeedback.push(res.stderr.trim());
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // A guard that never ran approved nothing, so the tool it guards doesn't run either.
        const guard = input.hook_event_name === "PreToolUse";
        outcome = {
          command: hook.command,
          statusMessage: hook.statusMessage,
          code: -1,
          stdout: "",
          stderr: guard ? `The hook couldn't start (${message}), so the tool was stopped instead of running unchecked.` : message,
          outcome: guard ? "blocking" : "error",
        };
        if (guard) result.blockingFeedback.push(outcome.stderr);
      }
      result.outcomes.push(outcome);
      report?.(outcome);
    }
  }
  return result;
}
