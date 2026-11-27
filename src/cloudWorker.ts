import type { ModelMessage } from "ai";
import { invoke } from "@/lib/ipc";
import { streamChat, type CacheStats, type ChatTurn } from "@/lib/ai";
import { getModel, PROVIDERS, type ModelInfo, type ProviderId } from "@/lib/models";
import { checkPermission, loadFileRules, describePermission, type PermissionBehavior } from "@/lib/permissions";
import { loadSettings, saveSettings, type ProviderSettings, type Settings } from "@/lib/settings";
import { getSecret, providerSecretAccount } from "@/lib/secureStore";
import { getMergedSettings, setSettingsWorkspace } from "@/lib/settingsRuntime";
import { saveSettingsForSource } from "@/lib/configStore";
import { CLAUDE_CODE_CONNECTED } from "@/lib/claudeCodeModels";
import { AGENT_CLI_CONNECTED } from "@/lib/agentCli";
import { EFFORT_LEVELS, type EffortLevel } from "@/lib/effort";
import { noteProjectRole } from "@/lib/projects/projectDirectory";
import { setProjectHost, type ProjectHost } from "@/lib/projects/projectHost";
import type { NyxsSettings } from "@/lib/configStore";
import { describeFailure, headlessPermissionMode, stripStreamMarkers, type HeadlessArgs } from "./headless";
import { prepareRepo, publishRepo, tauriExec, CloudGitError, type CloudExec, type PreparedRepo } from "./cloudWorkerGit";

/** One turn of a cloud thread, as `headless.rs` parsed and checked it (`CloudJob`). */
export interface CloudJob {
  threadId: string;
  turn: number;
  prompt: string;
  repo: { url: string; branch?: string | null };
  workBranch: string;
  model?: { id: string; provider?: string | null; effort?: string | null } | null;
  settings?: unknown;
  projectInstructions?: string | null;
  memory?: string | null;
  permissionMode?: string | null;
  maxSteps?: number | null;
  title?: string | null;
  dryRun?: boolean;
}

/** Statuses a thread's `report` tool and the last `done` event use (spec: "Runner ↔ worker contract"). */
export type ReportStatus = "working" | "needs_input" | "review" | "failed";
export type DoneStatus = "review" | "needs_input" | "failed";

/** `<work>/.nyxs/session.json`: the thread's conversation, which the next turn resumes from. */
export interface CloudSession {
  version: 1;
  threadId: string;
  turns: number;
  model: string | null;
  /** The project memory the conversation last saw, to tell the model when it changed. */
  memory: string;
  history: ChatTurn[];
  updatedAt: string;
}

export interface CloudDeps {
  chat: typeof streamChat;
  exec: CloudExec;
  now: () => number;
}

const REPORT_STATUSES: ReportStatus[] = ["working", "needs_input", "review", "failed"];
/** The project a cloud turn's thread belongs to, as far as its tools know: one per container. */
const CLOUD_PROJECT_ID = "cloud";
const PREVIEW_CHARS = 500;
const TOOL_OUTPUT_CHARS = 4000;
const CLI_SENTINEL: Partial<Record<ProviderId, string>> = { "claude-code": CLAUDE_CODE_CONNECTED };

/** The previous turns, or none when the file is missing, unreadable or another thread's. */
export function readCloudSession(raw: string | null | undefined, threadId: string): CloudSession | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<CloudSession>;
    if (s.version !== 1 || s.threadId !== threadId || !Array.isArray(s.history)) return null;
    return { version: 1, threadId, turns: Number(s.turns) || 0, model: s.model ?? null, memory: s.memory ?? "", history: s.history, updatedAt: s.updatedAt ?? "" };
  } catch {
    return null;
  }
}

/** What the thread's first message carries before the task: where it runs, how its work gets
 *  out, and the project's instructions and memory. Later turns only say when the memory changed. */
export function cloudPreamble(job: CloudJob, base: string, previous: CloudSession | null): string {
  const memory = (job.memory ?? "").trim();
  if (previous) {
    return memory && memory !== previous.memory.trim() ? `<project-memory updated="true">\n${memory}\n</project-memory>\n\n` : "";
  }
  const parts = [
    "<nyxs-cloud-thread>",
    `You are a thread of a Nyxs project, running in the Nyxs cloud in the repository at the working folder, on the branch ${job.workBranch} (from ${base}).`,
    "Nobody can answer questions while you work: decide sensibly, and say at the end what you need from the user, if anything.",
    "When the turn ends, Nyxs commits your changes, pushes the branch and opens a draft pull request. Don't push or open pull requests yourself.",
    `When you finish, fail or need the user, call the report tool with a short summary: what you did and what is left. Status "review" when it's done, "needs_input" when you need an answer (put the question in the text), "failed" when you can't do it.`,
    "</nyxs-cloud-thread>",
  ];
  const instructions = (job.projectInstructions ?? "").trim();
  if (instructions) parts.push("", "<project-instructions>", instructions, "</project-instructions>");
  if (memory) parts.push("", "<project-memory>", memory, "</project-memory>");
  return `${parts.join("\n")}\n\n`;
}

/** The provider configuration the job brings (`settings.providers`, or the map itself). */
function jobProviders(settings: unknown): Partial<Record<ProviderId, Partial<ProviderSettings>>> {
  if (!settings || typeof settings !== "object") return {};
  const s = settings as { providers?: unknown };
  const map = s.providers && typeof s.providers === "object" ? s.providers : settings;
  const out: Partial<Record<ProviderId, Partial<ProviderSettings>>> = {};
  for (const [id, cfg] of Object.entries(map as Record<string, unknown>)) {
    if (!(id in PROVIDERS) || !cfg || typeof cfg !== "object") continue;
    const { apiKey: _ignored, ...rest } = cfg as ProviderSettings;
    out[id as ProviderId] = rest;
  }
  return out;
}

/** The Nyxs settings for the turn: the job's providers and models, each key from where the
 *  keychain would have it (in the cloud, the turn's env; see `headless.rs`), CLI providers marked
 *  connected (their CLI signs in with its own env), and the job's model listed and enabled even
 *  when the job's settings left it out. */
export async function cloudSettings(job: CloudJob, base: Settings, secret: (account: string) => Promise<string | null> = getSecret): Promise<Settings> {
  const providers = jobProviders(job.settings);
  const out = { ...base } as Settings;
  const wanted = job.model?.id ?? "";
  const modelProvider = (job.model?.provider || wanted.split(":")[0]) as ProviderId;
  const ids = new Set<ProviderId>(Object.keys(providers) as ProviderId[]);
  if (modelProvider in PROVIDERS) ids.add(modelProvider);
  for (const id of ids) {
    const cfg = { ...out[id], ...providers[id] } as ProviderSettings;
    const kind = PROVIDERS[id].kind;
    const key = kind === "claude-code" || kind === "agent-cli" ? (CLI_SENTINEL[id] ?? AGENT_CLI_CONNECTED) : ((await secret(providerSecretAccount(id))) ?? "");
    out[id] = { ...cfg, apiKey: key };
  }
  if (wanted && modelProvider in PROVIDERS) {
    const cfg = out[modelProvider];
    const models = cfg.models ?? [];
    if (!models.some((m) => m.id === wanted)) {
      const apiModel = wanted.includes(":") ? wanted.slice(wanted.indexOf(":") + 1) : wanted;
      const added: ModelInfo = { id: wanted, apiModel, name: apiModel, description: "", provider: modelProvider };
      cfg.models = [...models, added];
    }
    cfg.enabled = [...new Set([...(cfg.enabled ?? []), wanted])];
  }
  return out;
}

function effortOf(value: string | null | undefined): EffortLevel {
  if (value === "xhigh") return "extra";
  return EFFORT_LEVELS.includes(value as EffortLevel) ? (value as EffortLevel) : "medium";
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The thread's title for the commit and the pull request: the job's, or the task's first line. */
export function cloudTitle(job: CloudJob): string {
  const first = (job.title || job.prompt).trim().split("\n")[0].trim();
  return clip(first || `Nyxs thread ${job.threadId}`, 72);
}

/** Text the model wrote that can go out now: complete marker blocks removed, and anything after
 *  a marker that hasn't closed yet kept back for the next flush. */
export function takeText(buffer: string): { text: string; rest: string } {
  const open = /⟦(TOOLEND|TOOL|REASONING)⟧/g;
  let cut = buffer.length;
  for (let m = open.exec(buffer); m; m = open.exec(buffer)) {
    if (!buffer.includes(`⟦/${m[1]}⟧`, m.index)) {
      cut = m.index;
      break;
    }
  }
  return { text: stripStreamMarkers(buffer.slice(0, cut)), rest: buffer.slice(cut) };
}

/** The chat key a cloud turn runs under; the thread's tools find their thread by it. */
export const cloudChatKey = (threadId: string) => `cloud-${threadId}`;

/** What the project tools reach in a cloud turn, which is always a project's thread: its
 *  `report` becomes the contract's report event (the runner relays it to the coordinator); the
 *  coordinator's actions don't exist here. */
export function cloudThreadHost(onReport: (text: string, status: ReportStatus) => void): ProjectHost {
  return {
    startThread: async () => ({ error: "A cloud thread can't open threads." }),
    setThreadStatus: async () => false,
    stopThread: async () => false,
    report: async (_thread, text, status) => {
      onReport(text, REPORT_STATUSES.includes(status as ReportStatus) ? (status as ReportStatus) : "review");
      return "delivered";
    },
    readThread: async () => null,
    answerDecision: () => undefined,
    turnEnded: () => undefined,
  };
}

/** A tool call the cloud lets through: anything but a refusal (see the turn's gate). */
export function cloudAllows(verdict: PermissionBehavior): boolean {
  return verdict !== "deny";
}

/** Where the turn ends up: failed if it failed, else what its last report asked for, else review. */
export function doneStatus(failed: boolean, lastReport: ReportStatus | null): DoneStatus {
  if (failed || lastReport === "failed") return "failed";
  return lastReport === "needs_input" ? "needs_input" : "review";
}

/** Runs one turn of a cloud thread: the repo, the conversation so far, the model, then the
 *  commit, push and pull request. Prints the contract's JSONL events (`{ type, data }`) and always
 *  ends with `done`; exits 0 once `done` is out, whatever the turn's own outcome. */
export async function runCloudTurn(args: HeadlessArgs, deps: CloudDeps = { chat: streamChat, exec: tauriExec, now: Date.now }): Promise<void> {
  // One queue for every line, so events go out in the order they happened even when a callback
  // can't wait for the write.
  let queue: Promise<unknown> = Promise.resolve();
  const write = (text: string, stderr = false) => (queue = queue.then(() => invoke("nyxs_headless_write", { text, stderr }).catch(() => undefined)));
  const emit = (type: string, data: Record<string, unknown>) => write(`${JSON.stringify({ type, data })}\n`);
  const log = (line: string) => write(`[nyxs-cloud] ${line}\n`, true);
  let status: ReportStatus | null = null;
  const setStatus = (next: ReportStatus) => {
    if (next === status) return queue;
    status = next;
    return emit("status", { status: next });
  };
  const finish = async (data: { status: DoneStatus; preview: string; prUrl?: string; branch?: string; error?: string }) => {
    await emit("done", { ...data, preview: clip(data.preview.trim(), PREVIEW_CHARS) });
    await invoke("nyxs_headless_exit", { code: 0 });
  };

  const job = args.job as CloudJob | null | undefined;
  if (!job) {
    const message = args.jobError || "No job was given";
    await emit("error", { message });
    await finish({ status: "failed", preview: message });
    return;
  }
  const work = args.workDir || "/work";
  await setStatus("working");

  let repo: PreparedRepo;
  try {
    repo = await prepareRepo(job, work, deps.exec);
    await log(`${repo.cloned ? "cloned" : "fetched"} ${job.repo.url}, on ${job.workBranch} from ${repo.base}`);
  } catch (err) {
    const message = err instanceof CloudGitError ? err.message : describeFailure(err);
    await emit("error", { message });
    await finish({ status: "failed", preview: message, branch: job.workBranch });
    return;
  }

  const previous = readCloudSession(args.resume, job.threadId);
  const history: ChatTurn[] = [...(previous?.history ?? []), { role: "user", content: `${cloudPreamble(job, repo.base, previous)}${job.prompt}` }];
  const mode = headlessPermissionMode(args.permissionMode ?? job.permissionMode ?? "auto");
  const maxSteps = args.maxSteps && args.maxSteps > 0 ? args.maxSteps : null;
  const modelId = job.model?.id ?? null;

  let full = "";
  let failure: string | null = null;
  let usage: CacheStats | null = null;
  let messages: ModelMessage[] = [];
  const denied: string[] = [];
  let lastReport: { text: string; status: ReportStatus } | null = null;
  /** The model's last message: what the thread's card shows when it didn't report. */
  let lastText = "";

  if (job.dryRun) {
    await emit("start", { threadId: job.threadId, turn: job.turn, model: null, cwd: repo.dir, permissionMode: mode, dryRun: true });
    full = "Dry run: the repository and the thread's session are ready; no model was called.";
    lastText = full;
    await emit("text", { text: full });
  } else {
    const settings = await cloudSettings(job, loadSettings());
    saveSettings(settings);
    const nyxs = (job.settings as { nyxs?: unknown } | null)?.nyxs;
    if (nyxs && typeof nyxs === "object") await saveSettingsForSource("user", null, nyxs as NyxsSettings).catch(() => undefined);
    setSettingsWorkspace(repo.dir);
    await getMergedSettings();
    const rules = loadFileRules();
    const model = modelId ? getModel(modelId, loadSettings()) : undefined;
    if (!model) {
      failure = `Unknown model ${modelId}`;
    } else {
      await emit("start", { threadId: job.threadId, turn: job.turn, model: model.id, cwd: repo.dir, permissionMode: mode, ...(maxSteps ? { maxSteps } : {}) });
      let pending = "";
      const flush = () => {
        const { text, rest } = takeText(pending);
        pending = rest;
        if (!text) return queue;
        lastText = text;
        return emit("text", { text });
      };
      const seenTools = new Set<string>();
      const doneTools = new Set<string>();
      // The thread's `report` tool (projectTools.ts) is offered to a session the project directory
      // knows as a thread; its report goes out after the text the model wrote before it.
      const chatKey = cloudChatKey(job.threadId);
      noteProjectRole(chatKey, CLOUD_PROJECT_ID, "thread");
      setProjectHost(
        cloudThreadHost((reportText, next) => {
          void flush();
          lastReport = { text: reportText, status: next };
          void emit("report", { text: reportText, status: next });
          void setStatus(next);
        }),
      );
      try {
        full = await deps.chat({
          modelId: model.id,
          history,
          settings: loadSettings(),
          workspace: repo.dir,
          planMode: mode === "plan",
          permissionMode: mode,
          confirmBeforeWrite: false,
          onChunk: (delta) => {
            pending += delta;
          },
          onTool: (id, detail) => {
            if (detail.streaming) return;
            if (!seenTools.has(id)) {
              seenTools.add(id);
              void flush();
              void emit("tool", { id, name: detail.name, detail: detail.detail });
            }
            if (detail.endedAt && !doneTools.has(id)) {
              doneTools.add(id);
              void emit("tool_result", {
                id,
                name: detail.name,
                ...(detail.output ? { output: clip(detail.output, TOOL_OUTPUT_CHARS) } : {}),
                ...(detail.added !== undefined ? { added: detail.added, removed: detail.removed ?? 0 } : {}),
              });
            }
          },
          onTodos: (todos) => void emit("todos", { todos }),
          onCacheStats: (stats) => {
            usage = stats;
          },
          onOutputLimit: (hit) => void emit("output_limit", { ...hit }),
          onMessages: (msgs, segment) => {
            messages = segment ? [...messages, ...msgs] : msgs;
            void flush();
          },
          // Nobody can answer a question here, and the container is the sandbox: what would ask
          // goes ahead. What the settings deny (and plan mode refuses) stays refused.
          gate: async (toolName, input) => {
            if (cloudAllows(checkPermission(toolName, input, mode, rules))) return true;
            const what = describePermission(toolName, input);
            denied.push(what);
            void emit("permission_denied", { tool: toolName, detail: what });
            return false;
          },
          askUser: async () => null,
          effort: effortOf(job.model?.effort),
          sessionKey: chatKey,
          ...(maxSteps ? { maxSteps } : {}),
        });
        void flush();
        await queue;
      } catch (err) {
        failure = describeFailure(err);
      }
    }
  }

  const text = failure === null ? stripStreamMarkers(full) : "";
  if (failure !== null) await emit("error", { message: failure });
  else await emit("result", { text, usage, denied });

  // The conversation is saved whatever happened, so the next turn knows what this one did.
  const answer: ChatTurn = { role: "assistant", content: text || (failure ? `(The turn failed: ${failure})` : ""), ...(messages.length ? { messages } : {}) };
  const session: CloudSession = {
    version: 1,
    threadId: job.threadId,
    turns: Math.max(job.turn, (previous?.turns ?? 0) + 1),
    model: modelId,
    memory: (job.memory ?? "").trim() || previous?.memory || "",
    history: [...history, answer],
    updatedAt: new Date(deps.now()).toISOString(),
  };
  try {
    await invoke<string>("nyxs_headless_save_session", { json: `${JSON.stringify(session)}\n` });
  } catch (err) {
    await log(`couldn't save the session: ${describeFailure(err)}`);
  }

  const reportedLast = lastReport as { text: string; status: ReportStatus } | null;
  const preview = reportedLast?.text || lastText || text || failure || "";
  const final = doneStatus(failure !== null, reportedLast?.status ?? null);
  if (failure !== null) {
    // What a failed turn left stays uncommitted in the volume; the next turn goes on from it.
    await finish({ status: final, preview, branch: job.workBranch });
    return;
  }
  try {
    const published = await publishRepo(job, repo, { title: cloudTitle(job), body: prBody(job, preview), canPush: args.githubToken === true }, deps.exec);
    if (published.error) await emit("error", { message: published.error });
    await finish({
      status: final,
      preview,
      branch: job.workBranch,
      ...(published.prUrl ? { prUrl: published.prUrl } : {}),
      ...(published.error ? { error: published.error } : {}),
    });
  } catch (err) {
    const message = err instanceof CloudGitError ? err.message : describeFailure(err);
    await emit("error", { message });
    await finish({ status: final, preview, branch: job.workBranch, error: message });
  }
}

function prBody(job: CloudJob, preview: string): string {
  const summary = preview.trim() ? `${clip(preview.trim(), 2000)}\n\n` : "";
  return `${summary}---\nOpened by a Nyxs cloud thread (${job.threadId}). Later turns of the thread push to this branch.`;
}
