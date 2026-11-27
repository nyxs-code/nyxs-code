import type { ModelMessage } from "ai";
import { invoke } from "@/lib/ipc";
import type { PermissionMode } from "@/components/ui/claude-style-chat-input";
import { streamChat, type CacheStats } from "@/lib/ai";
import { getActiveModels, getModel, runsInCli, type ModelInfo } from "@/lib/models";
import { checkPermission, loadFileRules, describePermission } from "@/lib/permissions";
import { loadSelectedModel, loadSettings } from "@/lib/settings";
import { getMergedSettings, setSettingsWorkspace } from "@/lib/settingsRuntime";
import { runCloudTurn, type CloudJob } from "./cloudWorker";

export interface HeadlessArgs {
  prompt: string;
  format: "text" | "json";
  cwd: string;
  model?: string | null;
  permissionMode?: string | null;
  /** `--max-steps`: the most model steps the run may take. */
  maxSteps?: number | null;
  /** `--save-session <file>`: write the run's transcript there (see HeadlessSession). */
  saveSession?: string | null;
  /** `--job`: one turn of a cloud thread (cloudWorker.ts); its run replaces this one. */
  job?: CloudJob | null;
  /** Why the `--job` input couldn't be used. */
  jobError?: string | null;
  /** The cloud thread's saved conversation, when an earlier turn ran. */
  resume?: string | null;
  /** The folder that persists between a cloud thread's turns (`/work`). */
  workDir?: string | null;
  /** `GITHUB_TOKEN` is set for the cloud turn. */
  githubToken?: boolean;
}

/** What `--save-session` writes: the run as an eval can check it. `events` are the same objects
 *  `--format json` prints; `messages` are the model messages the turn saved, tool calls and
 *  results included. */
export interface HeadlessSession {
  version: 1;
  startedAt: string;
  durationMs: number;
  model: string;
  cwd: string;
  permissionMode: PermissionMode;
  maxSteps: number | null;
  prompt: string;
  status: "ok" | "error";
  error?: string;
  events: Record<string, unknown>[];
  messages: ModelMessage[];
  result: { text: string; usage: CacheStats | null; denied: string[] } | null;
}

/** What a headless run talks to, swapped in tests. */
export interface HeadlessDeps {
  chat: typeof streamChat;
  now: () => number;
}

const MODES: PermissionMode[] = ["ask", "acceptEdits", "plan", "auto", "skip"];

export function stripStreamMarkers(text: string): string {
  return text
    .replace(/⟦TOOLEND⟧[\s\S]*?⟦\/TOOLEND⟧/g, "")
    .replace(/⟦TOOL⟧[\s\S]*?⟦\/TOOL⟧/g, "")
    .replace(/⟦REASONING⟧[\s\S]*?⟦\/REASONING⟧/g, "")
    .replace(/⟦TODO⟧|⟦PLAN⟧/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A failed run's reason. Not everything thrown is an Error: a provider's error payload printed as
 *  "[object Object]" told nothing. */
export function describeFailure(err: unknown): string {
  // An API error whose payload the SDK couldn't read has "[object Object]" as its message; what
  // the provider said is in the response body.
  const body = (err as { responseBody?: unknown } | null)?.responseBody;
  const withBody = (message: string) =>
    typeof body === "string" && body && !message.includes(body) ? `${message} (${body.slice(0, 500)})` : message;
  if (err instanceof Error) return withBody(err.message);
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
    try {
      return JSON.stringify(err);
    } catch {
      // A cyclic object: fall through to its tag.
    }
  }
  return String(err);
}

export function headlessPermissionMode(value: string | null | undefined): PermissionMode {
  return MODES.includes(value as PermissionMode) ? (value as PermissionMode) : "acceptEdits";
}

/** Models a headless run can use: API models and Claude Code. The other agent CLIs take no step
 *  limit and keep their own sessions, so evals can't drive them the same way. */
export function headlessCanUse(model: ModelInfo): boolean {
  return model.provider === "claude-code" || !runsInCli(model.provider);
}

export async function runHeadless(args: HeadlessArgs, deps: HeadlessDeps = { chat: streamChat, now: Date.now }): Promise<void> {
  if (args.job || args.jobError) {
    await runCloudTurn(args);
    return;
  }
  const json = args.format === "json";
  const write = (text: string, stderr = false) => invoke("nyxs_headless_write", { text, stderr }).catch(() => undefined);
  const events: Record<string, unknown>[] = [];
  const event = (obj: Record<string, unknown>) => {
    events.push(obj);
    return json ? write(`${JSON.stringify(obj)}\n`) : Promise.resolve(undefined);
  };
  const say = (line: string) => (json ? Promise.resolve(undefined) : write(`${line}\n`, true));
  const exit = (code: number) => invoke("nyxs_headless_exit", { code });

  const settings = loadSettings();
  const available = getActiveModels(settings).filter(headlessCanUse);
  if (args.model && !getModel(args.model, settings)) {
    const list = available.map((m) => m.id).join(", ");
    await event({ type: "error", message: `Unknown model ${args.model}`, available: available.map((m) => m.id) });
    await say(`nyxs: unknown model ${args.model}. Available: ${list}`);
    await exit(2);
    return;
  }
  const wanted = args.model || loadSelectedModel();
  const model = (wanted && getModel(wanted, settings)) || available[0];
  if (!model || !headlessCanUse(model)) {
    await event({ type: "error", message: "No usable model. Pass --model provider:model (an API model or Claude Code) or pick one in the app first." });
    await say("nyxs: no usable model. Pass --model provider:model (an API model or Claude Code) or pick one in the app first.");
    await exit(2);
    return;
  }

  const mode = headlessPermissionMode(args.permissionMode);
  const maxSteps = args.maxSteps && args.maxSteps > 0 ? args.maxSteps : null;
  // The project's settings, as the app would apply them there: an untrusted project's allow
  // rules, hooks and MCP servers stay off (there's no one to ask), its deny rules apply.
  setSettingsWorkspace(args.cwd || null);
  await getMergedSettings();
  const rules = loadFileRules();
  const denied: string[] = [];
  const started = deps.now();
  await event({ type: "start", model: model.id, cwd: args.cwd, permissionMode: mode, ...(maxSteps ? { maxSteps } : {}) });

  let usage: CacheStats | null = null;
  let messages: ModelMessage[] = [];
  const seenTools = new Set<string>();
  let full = "";
  let failure: string | null = null;
  try {
    full = await deps.chat({
      modelId: model.id,
      history: [{ role: "user", content: args.prompt }],
      settings,
      workspace: args.cwd,
      planMode: mode === "plan",
      confirmBeforeWrite: false,
      onChunk: () => undefined,
      onTool: (id, detail) => {
        if (detail.streaming || seenTools.has(id)) return;
        seenTools.add(id);
        void event({ type: "tool", id, name: detail.name, detail: detail.detail });
        void say(`→ ${detail.name}${detail.detail ? ` ${detail.detail}` : ""}`);
      },
      onTodos: (todos) => void event({ type: "todos", todos }),
      onCacheStats: (stats) => {
        usage = stats;
      },
      onOutputLimit: (hit) => {
        void event({ type: "output_limit", ...hit });
        const limit = hit.limit ? ` (${hit.limit} tokens; raise generation.maxOutputTokens in settings.json)` : "";
        void say(
          hit.cut
            ? `! the reply was cut off: the model ran out of output tokens${limit}`
            : `! the model ran out of output tokens while thinking and was asked to act${limit}`,
        );
      },
      // Each call carries the turn's messages so far (an injected message splits them in parts).
      onMessages: (msgs, segment) => {
        messages = segment ? [...messages, ...msgs] : msgs;
      },
      gate: async (toolName, input) => {
        const verdict = checkPermission(toolName, input, mode, rules);
        if (verdict === "allow") return true;
        const what = describePermission(toolName, input);
        denied.push(what);
        void event({ type: "permission_denied", tool: toolName, detail: what });
        void say(`✗ not allowed in ${mode} mode: ${what}`);
        return false;
      },
      askUser: async () => null,
      effort: "medium",
      sessionKey: `headless-${started}`,
      ...(maxSteps ? { maxSteps } : {}),
    });
  } catch (err) {
    failure = describeFailure(err);
  }

  const text = failure === null ? stripStreamMarkers(full) : "";
  if (failure !== null) {
    await event({ type: "error", message: failure });
    await say(`nyxs: ${failure}`);
  } else if (json) await event({ type: "result", text, usage, denied });
  else await write(`${text}\n`);

  if (args.saveSession) {
    const session: HeadlessSession = {
      version: 1,
      startedAt: new Date(started).toISOString(),
      durationMs: Math.max(0, deps.now() - started),
      model: model.id,
      cwd: args.cwd,
      permissionMode: mode,
      maxSteps,
      prompt: args.prompt,
      status: failure === null ? "ok" : "error",
      ...(failure !== null ? { error: failure } : {}),
      events,
      messages,
      result: failure === null ? { text, usage, denied } : null,
    };
    try {
      const where = await invoke<string>("nyxs_headless_save_session", { json: `${JSON.stringify(session, null, 2)}\n` });
      await say(`nyxs: session saved to ${where}`);
    } catch (err) {
      await say(`nyxs: couldn't save the session: ${err instanceof Error ? err.message : String(err)}`);
      if (failure === null) {
        await exit(1);
        return;
      }
    }
  }
  await exit(failure === null ? 0 : 1);
}
