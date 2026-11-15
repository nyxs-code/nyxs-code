import { chatModeOf } from "@/lib/chatModes";
import { sessionBridge } from "@/lib/sessionBridge";

// The user's other sessions, as Claude Code Desktop gives them to Claude: list, read, message,
// create (nested under this one), rename and archive. One set of definitions serves the
// built-in models (src/tools/Sessions) and the agents that run their own CLI (Claude Code,
// Codex, ACP agents), which reach them through the `nyxs-sessions` MCP server Nyxs hosts
// (src/lib/browserMcp.ts).

export const SESSIONS_MCP_SERVER = "nyxs-sessions";

/** Added to the system prompt of an agent with its own CLI (Claude Code): its sessions are
 *  Nyxs's, reached through this MCP server, not its own sub-agents. */
export const CLI_SESSIONS_PROMPT = `# The user's sessions
You run inside Nyxs, which keeps the user's conversations as sessions listed in its Recents. When the user asks you to create, start or open a new session (in Spanish "nueva sesión", often typed "sesion" or "secion"), call mcp__${SESSIONS_MCP_SERVER}__create_session right away, with the model and effort they named in their own words if they named any: don't use the Agent/Task tool for it, and don't look anything up first. Its first reply comes back to you as a message, so end your turn with one short line until it does. To read, message, rename or archive their other sessions, use the other mcp__${SESSIONS_MCP_SERVER}__ tools.`;

export interface SessionToolRun {
  /** The chat the agent runs in. */
  chat?: string;
  /** Asks the user when the chat's permission mode says so; a refusal comes back as text. Agents
   *  with their own CLI ask through it instead, so they pass none. */
  gate?: (toolName: string, input: Record<string, unknown>) => Promise<string | null>;
}

export interface SessionToolDef {
  /** The built-in models' name ("CreateSession"). */
  name: string;
  /** The MCP tool's name ("create_session"). */
  mcpName: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
  readOnly: boolean;
  /** Resolves with what to tell the model; throws when nothing was done, so the chat shows the
   *  call as failed (and no card for a session that wasn't created). */
  run(input: Record<string, unknown>, ctx: SessionToolRun): Promise<string>;
}

const MAX_LISTED = 20;
const MAX_READ = 40_000;

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const sessionId = { type: "string", description: "The session's id, from list_sessions." };

function bridge() {
  const b = sessionBridge();
  if (!b) throw new Error("Sessions aren't available here.");
  return b;
}

async function gated(ctx: SessionToolRun, name: string, input: Record<string, unknown>): Promise<void> {
  const denied = ctx.gate ? await ctx.gate(name, input) : null;
  if (denied) throw new Error(denied);
}

function notSelf(ctx: SessionToolRun, id: string): void {
  if (id === ctx.chat) throw new Error("That's this session itself.");
}

export const SESSION_TOOLS: SessionToolDef[] = [
  {
    name: "ListSessions",
    mcpName: "list_sessions",
    description: `List the user's ${MAX_LISTED} most recent other sessions in Nyxs (conversations with an agent, listed in Recents; not this one, not archived), newest first: id, title, project, when it last changed, and whether a turn is running there. Use it to find a session to read, message, rename or archive.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    run: async (_input, ctx) => {
      const list = bridge().list(ctx.chat).slice(0, MAX_LISTED);
      if (!list.length) return "No other sessions.";
      return list
        .map((s) => `${s.id} · ${s.title || "(untitled)"} · ${s.project} · ${new Date(s.modifiedAt).toISOString().slice(0, 16).replace("T", " ")}${s.working ? " · working" : ""}`)
        .join("\n");
    },
  },
  {
    name: "ReadSession",
    mcpName: "read_session",
    description: "Read another session's conversation (its last messages, without tool details). Use the id from list_sessions.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: sessionId,
        last: { type: "number", description: "How many of its last messages to read (default 30, at most 200)." },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
    readOnly: true,
    run: async (input) => {
      const id = str(input.session_id);
      const last = Math.min(200, Math.max(1, Number(input.last) || 30));
      const s = await bridge().read(id, last);
      if (!s) throw new Error(`No session ${id}.`);
      const body = s.messages.map((m) => `[${m.role === "user" ? "User" : "Assistant"}]: ${m.content}`).join("\n\n");
      const text = `Session "${s.title}" (${id}):\n\n${body || "(no messages)"}`;
      return text.length > MAX_READ ? `${text.slice(0, MAX_READ)}\n… (cut; ask for fewer messages with last)` : text;
    },
  },
  {
    name: "SendToSession",
    mcpName: "send_to_session",
    description:
      "Send a message to another of the user's sessions: it shows there as a card from this session, and that session's agent answers it in its own turn (once its current turn ends, if one is running). You won't get its reply here: read the session later to see it.",
    inputSchema: {
      type: "object",
      properties: { session_id: sessionId, message: { type: "string", description: "What to tell that session." } },
      required: ["session_id", "message"],
      additionalProperties: false,
    },
    readOnly: false,
    run: async (input, ctx) => {
      const id = str(input.session_id);
      const message = str(input.message).trim();
      if (!message) throw new Error("Pass the message to send.");
      notSelf(ctx, id);
      // The gate compares the other session's mode with this one's.
      const targetMode = chatModeOf(id);
      await gated(ctx, "SendToSession", { session_id: id, message, ...(targetMode ? { target_mode: targetMode } : {}) });
      const outcome = await bridge().send(ctx.chat, id, message);
      if (outcome === "missing") throw new Error(`No session ${id}, or it is archived: the message wasn't delivered.`);
      if (outcome === "unsupported") throw new Error(`Session ${id} uses a model that can't be messaged from here (no key, or an agent that runs its own terminal).`);
      return outcome === "queued"
        ? `Queued for ${id}: a turn is running there, and the message goes in when it ends.`
        : `Sent to ${id}; its agent is answering it now.`;
    },
  },
  {
    name: "CreateSession",
    mcpName: "create_session",
    description:
      "Create a new Nyxs session: a separate conversation with its own agent, which the user sees in Recents nested under this one, in this project. It gets its first message and works on it in its own turn. " +
      "Use it whenever the user asks to create, start or open a new session or chat (in Spanish \"nueva sesión\", often typed \"sesion\" or \"secion\"), and for a task that should run apart from this conversation. " +
      "Call it straight away: there is nothing to look up first, not the project, not model ids. " +
      "It runs on this session's model and effort; pass model or effort only when the user asks for others, in the user's own words. " +
      "Its first reply comes back here as a message, so you can tell the user what it said; until then, end your turn with one short line instead of waiting. " +
      "For several sessions, call it once for each. This is not a sub-agent: for research inside this conversation, use your Task/Agent tool instead.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The session's title, as the user will see it in Recents (at most 80 characters)." },
        message: { type: "string", description: "Its first message: everything its agent needs, as it can't see this conversation." },
        model: {
          type: "string",
          description: 'The model the user asked for, exactly as they said it ("haiku 5.5", "opus", "gpt-5"): Nyxs matches it. Leave it out for this session\'s model. If nothing matches, the error lists the models.',
        },
        effort: { type: "string", description: 'The effort the user asked for, as they said it ("low", "bajo", "max"). Leave it out for this session\'s effort.' },
        report_back: { type: "boolean", description: "Send its first reply back here (default true)." },
      },
      required: ["title", "message"],
      additionalProperties: false,
    },
    readOnly: false,
    run: async (input, ctx) => {
      const title = str(input.title).trim().slice(0, 80);
      const message = str(input.message).trim();
      if (!title || !message) throw new Error("Pass a title and its first message.");
      const model = str(input.model).trim() || undefined;
      const effort = str(input.effort).trim() || undefined;
      const reportBack = input.report_back !== false;
      await gated(ctx, "CreateSession", { title, message, model, effort });
      const outcome = await bridge().create(ctx.chat, { title, message, model, effort, reportBack });
      if (outcome === "no-project") throw new Error("Sessions live in a project folder, and none is open.");
      if (outcome === "unsupported") throw new Error("This session's model can't run a new session from here (no key, or an agent that runs its own terminal). Ask the user which model to use.");
      if ("unknownModel" in outcome) {
        throw new Error(`No model matches "${model}", so the session wasn't created. Call it again with one of these (name or id):\n${outcome.unknownModel.slice(0, 40).join("\n")}`);
      }
      if ("unknownEffort" in outcome) throw new Error(`"${effort}" isn't an effort level (${outcome.unknownEffort.join(", ")}), so the session wasn't created.`);
      const runs = `on ${outcome.model}, ${outcome.effort} effort`;
      return reportBack
        ? `Created the session "${title}" (${outcome.id}), ${runs}. Its agent is answering it now and its reply will arrive here as a message: end your turn now.`
        : `Created the session "${title}" (${outcome.id}), ${runs}; its agent is answering it now. Read it later to see its reply.`;
    },
  },
  {
    name: "RenameSession",
    mcpName: "rename_session",
    description: "Rename one of the user's sessions (or this one).",
    inputSchema: {
      type: "object",
      properties: { session_id: sessionId, title: { type: "string", description: "The new title (at most 80 characters)." } },
      required: ["session_id", "title"],
      additionalProperties: false,
    },
    readOnly: false,
    run: async (input, ctx) => {
      const id = str(input.session_id);
      const title = str(input.title).trim().slice(0, 80);
      if (!title) throw new Error("Pass the new title.");
      await gated(ctx, "RenameSession", { session_id: id, title });
      if (!(await bridge().rename(id, title))) throw new Error(`No session ${id}.`);
      return `Renamed ${id} to "${title}".`;
    },
  },
  {
    name: "ArchiveSession",
    mcpName: "archive_session",
    description: "Archive one of the user's other sessions (it leaves Recents; the user can bring it back). The user is asked first.",
    inputSchema: { type: "object", properties: { session_id: sessionId }, required: ["session_id"], additionalProperties: false },
    readOnly: false,
    run: async (input, ctx) => {
      const id = str(input.session_id);
      notSelf(ctx, id);
      await gated(ctx, "ArchiveSession", { session_id: id });
      if (!(await bridge().archive(id))) throw new Error(`No session ${id}.`);
      return `Archived ${id}.`;
    },
  },
];

const BY_MCP = new Map(SESSION_TOOLS.map((d) => [`mcp__${SESSIONS_MCP_SERVER}__${d.mcpName}`, d]));

/** The session tool behind a tool name, as either kind of agent calls it. */
export function sessionToolFor(toolName: string): SessionToolDef | undefined {
  return SESSION_TOOLS.find((d) => d.name === toolName) ?? BY_MCP.get(toolName);
}
