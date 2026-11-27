import type { SessionToolDef, SessionToolRun } from "@/lib/sessionTools";
import { sessionBridge } from "@/lib/sessionBridge";
import { deliveryMarker, latestDeliveryId } from "@/lib/sessionDelivery";
import { projectHost } from "./projectHost";
import { projectEntry, projectRoleOf, type ThreadEntry } from "./projectDirectory";
import { PROJECT_TOOL_NAMES, type ProjectToolMcpName } from "./projectPrompt";
import { writeProjectMemory } from "./projectStore";
import { PROJECT_MEMORY_MAX, type ThreadStatus } from "./types";

// The tools of a project's sessions (docs/proyectos-nube-spec.md): the coordinator opens and
// follows threads, asks the user to decide and keeps the memory; a thread reports back. Same
// definitions as the session tools, so the built-in models (src/tools/Sessions) and the CLI agents
// (the `nyxs-sessions` MCP server) get them alike, each only in the sessions of a project.

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const threadId = { type: "string", description: "The thread's id (from start_thread or list_threads)." };

function host() {
  const h = projectHost();
  if (!h) throw new Error("Projects aren't available here.");
  return h;
}

/** The project of the coordinator running the tool. */
function coordinatorProject(ctx: SessionToolRun) {
  const role = projectRoleOf(ctx.chat);
  const entry = projectEntry(role?.projectId);
  if (!role || role.role !== "coordinator" || !entry) throw new Error("Only a project's coordinator can use this tool.");
  return entry;
}

function ownThread(ctx: SessionToolRun, id: string): ThreadEntry {
  const entry = coordinatorProject(ctx);
  const thread = entry.threads.find((t) => t.id === id);
  if (!thread) throw new Error(`No thread ${id} in this project. list_threads shows them.`);
  return thread;
}

const GROUP_WORDS: Record<ThreadEntry["group"], string> = {
  waiting: "waiting on the user",
  working: "working",
  review: "to review",
  resolved: "resolved",
  failed: "failed",
};

const def = (mcp: ProjectToolMcpName, d: Omit<SessionToolDef, "name" | "mcpName">): SessionToolDef => ({ name: PROJECT_TOOL_NAMES[mcp], mcpName: mcp, ...d });

export const COORDINATOR_TOOLS: SessionToolDef[] = [
  def("start_thread", {
    description:
      "Open a thread for one real task of the project: a separate Nyxs session, in its own git worktree of the project folder, that works on it in its own turns and reports back here as a message. " +
      "One thread per independent task; for several unrelated tasks, call it once for each. Its instructions are all it knows: it can't see this conversation. " +
      "After starting threads, end your turn with one short line instead of waiting.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "A short title for the thread, as the user will see it (at most 80 characters)." },
        instructions: { type: "string", description: "Everything the thread needs to do the task: what, where, constraints, how to check it." },
        where: {
          type: "string",
          enum: ["local", "cloud"],
          description:
            'Where it runs: "local" (a worktree on this computer) or "cloud" (an isolated container in the Nyxs cloud that clones the project\'s repository, keeps working with the computer off and opens a draft pull request). Leave it out for the project\'s default.',
        },
        model: { type: "string", description: "A model the user asked for, as they said it. Leave it out for the project's default." },
      },
      required: ["title", "instructions"],
      additionalProperties: false,
    },
    readOnly: false,
    run: async (input, ctx) => {
      coordinatorProject(ctx);
      const title = str(input.title).trim().slice(0, 80);
      const instructions = str(input.instructions).trim();
      if (!title || !instructions) throw new Error("Pass a title and the thread's instructions.");
      const asked = str(input.where);
      const out = await host().startThread(ctx.chat!, {
        title,
        instructions,
        model: str(input.model).trim() || undefined,
        ...(asked === "cloud" || asked === "local" ? { where: asked } : {}),
      });
      if ("error" in out) throw new Error(out.error);
      const where =
        out.where === "cloud"
          ? "in the Nyxs cloud: it clones the repository, works on its own branch and opens a draft pull request, even with this computer off"
          : out.branch
            ? `in its own worktree, on branch ${out.branch}`
            : "in the project folder (no worktree: it isn't a git repository)";
      return `Started the thread "${title}" (${out.id}) on ${out.model}, ${out.effort} effort, ${where}. It is working on it now; its report will arrive here as a message, so end your turn with one short line.`;
    },
  }),
  def("message_thread", {
    description: "Send a follow-up to one of the project's threads (a new request in its area, an answer it asked for). It answers in its own turn, once its current one ends, and reports back here.",
    inputSchema: {
      type: "object",
      properties: { threadId, text: { type: "string", description: "What to tell the thread." } },
      required: ["threadId", "text"],
      additionalProperties: false,
    },
    readOnly: false,
    run: async (input, ctx) => {
      const id = str(input.threadId);
      const text = str(input.text).trim();
      if (!text) throw new Error("Pass the text to send.");
      const thread = ownThread(ctx, id);
      const b = sessionBridge();
      if (!b) throw new Error("Sessions aren't available here.");
      const outcome = await b.send(ctx.chat, id, text, { header: "Message from the project's coordinator:" });
      if (outcome === "missing") throw new Error(`Thread ${id} isn't loaded or is archived: the message wasn't delivered.`);
      if (outcome === "unsupported") throw new Error(`Thread ${id} uses a model that can't be messaged from here.`);
      const sentId = latestDeliveryId(ctx.chat, id);
      const marker = sentId ? ` ${deliveryMarker(sentId)}` : "";
      return outcome === "queued"
        ? `Queued for "${thread.title}": it is busy, and the message goes in when its turn ends.${marker}`
        : `Sent to "${thread.title}"; it is working on it now and will report back here.${marker}`;
    },
  }),
  def("read_thread", {
    description: "Read one of the project's threads: its last messages, without tool details.",
    inputSchema: {
      type: "object",
      properties: { threadId, lastN: { type: "number", description: "How many of its last messages (default 20, at most 200)." } },
      required: ["threadId"],
      additionalProperties: false,
    },
    readOnly: true,
    run: async (input, ctx) => {
      const id = str(input.threadId);
      const thread = ownThread(ctx, id);
      const last = Math.min(200, Math.max(1, Number(input.lastN) || 20));
      const read = await host().readThread(id, last);
      if (!read) throw new Error(`Thread ${id} couldn't be read.`);
      const body = read.messages.map((m) => `[${m.role === "user" ? "User" : "Thread"}]: ${m.content}`).join("\n\n");
      const text = `Thread "${thread.title}" (${id}), ${GROUP_WORDS[thread.group]}:\n\n${body || "(no messages)"}`;
      return text.length > 40_000 ? `${text.slice(0, 40_000)}\n… (cut; ask for fewer messages with lastN)` : text;
    },
  }),
  def("list_threads", {
    description: "List the project's threads, newest change first: id, title, state, branch, when it changed and its last report.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    run: async (_input, ctx) => {
      const entry = coordinatorProject(ctx);
      if (!entry.threads.length) return "No threads yet.";
      return entry.threads
        .map((t) => {
          const when = new Date(t.updatedAt).toISOString().slice(0, 16).replace("T", " ");
          const preview = t.preview ? ` · ${t.preview.replace(/\s+/g, " ").slice(0, 160)}` : "";
          return `${t.id} · ${t.title} · ${GROUP_WORDS[t.group]}${t.branch ? ` · ${t.branch}` : ""} · ${when}${preview}`;
        })
        .join("\n");
    },
  }),
  def("set_thread_status", {
    description: 'Mark a thread "resolved" when the user is done with its work, or "idle" to set it aside. A new message to it brings it back.',
    inputSchema: {
      type: "object",
      properties: { threadId, status: { type: "string", enum: ["resolved", "idle"] } },
      required: ["threadId", "status"],
      additionalProperties: false,
    },
    readOnly: false,
    run: async (input, ctx) => {
      const id = str(input.threadId);
      const status = str(input.status);
      if (status !== "resolved" && status !== "idle") throw new Error('The status is "resolved" or "idle".');
      const thread = ownThread(ctx, id);
      if (!(await host().setThreadStatus(id, status))) throw new Error(`Thread ${id} couldn't be updated.`);
      return `Marked "${thread.title}" as ${status}.`;
    },
  }),
  def("ask_decision", {
    description:
      "Ask the user to choose between 2 to 4 options, shown as a card in this conversation. Their choice arrives as their next message, so end your turn after calling it. Use it for a real choice (a direction, a trade-off a thread raised), not for yes/no small talk.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, in the user's language." },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "The option, a few words." },
              consequence: { type: "string", description: "What choosing it means, in one short line." },
            },
            required: ["label"],
            additionalProperties: false,
          },
        },
        recommended: { type: "string", description: "The label of the option you recommend, if any." },
      },
      required: ["question", "options"],
      additionalProperties: false,
    },
    readOnly: false,
    run: async (input, ctx) => {
      coordinatorProject(ctx);
      const parsed = decisionOf(input);
      if (!parsed) throw new Error("Pass the question and 2 to 4 options, each with a label.");
      return "Shown to the user as a decision card. Their choice arrives as their next message: end your turn now.";
    },
  }),
  def("update_memory", {
    description: `Replace the project's memory (MEMORY.md) with this text: what every session of the project should know (decisions, conventions, where things are). Keep it short (at most ${PROJECT_MEMORY_MAX} characters); it is not a log. Pass the whole new text, not only what changed.`,
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The whole new memory, as Markdown." } },
      required: ["text"],
      additionalProperties: false,
    },
    readOnly: false,
    run: async (input, ctx) => {
      const entry = coordinatorProject(ctx);
      const text = str(input.text);
      const kept = await writeProjectMemory(entry.project.id, text);
      const cut = text.trim().length > kept.length ? ` It was cut to ${PROJECT_MEMORY_MAX} characters: keep it shorter.` : "";
      return `Saved the project's memory (${kept.length} characters).${cut}`;
    },
  }),
];

const REPORT_STATUSES: ThreadStatus[] = ["working", "needs_input", "review", "failed"];

export const THREAD_TOOLS: SessionToolDef[] = [
  def("report", {
    description:
      'Report to the project\'s coordinator: a card in the project conversation, and your status. "review" when the task is done, "needs_input" when you need the user (say what), "failed" when you can\'t do it, "working" for a progress note on long work. Keep it short: what you did, the branch, what is left.',
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The report, in the user's language." },
        status: { type: "string", enum: REPORT_STATUSES, description: 'Your status now (default "review").' },
      },
      required: ["text"],
      additionalProperties: false,
    },
    readOnly: false,
    run: async (input, ctx) => {
      const role = projectRoleOf(ctx.chat);
      if (!ctx.chat || role?.role !== "thread") throw new Error("Only a project's thread can report.");
      const text = str(input.text).trim();
      if (!text) throw new Error("Pass the report's text.");
      const status = (REPORT_STATUSES.includes(str(input.status) as ThreadStatus) ? str(input.status) : "review") as ThreadStatus;
      const out = await host().report(ctx.chat, text, status);
      if (out === "no-coordinator") throw new Error("The project's coordinator couldn't be reached; your status was saved.");
      return out === "noted" ? "Noted in the project conversation; carry on." : "Reported to the coordinator.";
    },
  }),
];

export interface Decision {
  question: string;
  options: { label: string; consequence?: string }[];
  recommended?: string;
}

/** An ask_decision call's input, checked: 2 to 4 options with a label. */
export function decisionOf(input: unknown): Decision | null {
  const i = (input ?? {}) as Record<string, unknown>;
  const question = str(i.question).trim();
  const options = (Array.isArray(i.options) ? i.options : [])
    .map((o) => {
      const r = (o ?? {}) as Record<string, unknown>;
      const label = str(r.label).trim();
      const consequence = str(r.consequence).trim();
      return label ? { label, ...(consequence ? { consequence } : {}) } : null;
    })
    .filter((o): o is { label: string; consequence?: string } => !!o);
  if (!question || options.length < 2 || options.length > 4) return null;
  const recommended = str(i.recommended).trim();
  return { question, options, ...(recommended && options.some((o) => o.label === recommended) ? { recommended } : {}) };
}

/** The project tools of the session `chat`: the coordinator's, a thread's, or none. */
export function projectToolsFor(chat: string | undefined | null): SessionToolDef[] {
  const role = projectRoleOf(chat);
  if (role?.role === "coordinator") return COORDINATOR_TOOLS;
  if (role?.role === "thread") return THREAD_TOOLS;
  return [];
}

export const PROJECT_TOOLS: SessionToolDef[] = [...COORDINATOR_TOOLS, ...THREAD_TOOLS];
