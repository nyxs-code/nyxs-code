import type { AskQuestion, AskUserFn } from "./agentTools";

/**
 * Nyxs' own chat features as an MCP server for the CLIs that only take tools over MCP (Grok,
 * Antigravity): multiple-choice questions shown with Nyxs' question card, and in plan mode a
 * plan handed over for the same review Claude Code's ExitPlanMode gets. The server is served
 * by the bridge (mcpBridge.ts); each call goes to the turn running in the asking chat.
 */

type Json = Record<string, unknown>;

export const CHAT_MCP_SERVER = "nyxs-chat";
export const ASK_TOOL = "ask_user_question";
export const PLAN_TOOL = "exit_plan_mode";

const PROTOCOL_VERSION = "2025-06-18";

/** What a running CLI turn lends the chat server. */
export interface ChatTurnHooks {
  askUser?: AskUserFn;
  /** Shows a plan for review (the turn's ⟦PLAN⟧); only set while the chat is in plan mode. */
  plan?: (plan: string) => void;
  /** The CLI's own conversation id, once known: Antigravity names it on each call. */
  conversationId?: string;
  /** The chat's permission check, for the CLIs that can't ask the user themselves (headless
   *  Antigravity): its calls to Nyxs' browser go through it. */
  gate?: (toolName: string, input: Json) => Promise<boolean>;
}

interface Registered extends ChatTurnHooks {
  chatKey?: string;
  seq: number;
}

const turns: Registered[] = [];
let seq = 0;

/** Lends `hooks` to the chat server while a turn runs; returns how to take them back. Unregistered
 *  turns' tools aren't offered, so a CLI started outside a turn sees an empty server. */
export function registerChatTurn(chatKey: string | undefined, hooks: ChatTurnHooks): { update: (patch: ChatTurnHooks) => void; release: () => void } {
  const entry: Registered = { ...hooks, chatKey, seq: ++seq };
  turns.push(entry);
  return {
    update: (patch) => Object.assign(entry, patch),
    release: () => {
      const i = turns.indexOf(entry);
      if (i >= 0) turns.splice(i, 1);
    },
  };
}

/** The turn a call comes from: by the chat in its address (Grok, and Antigravity through its
 *  proxy), else by the CLI conversation it names (an `agy` started outside Nyxs), else the latest
 *  turn running. */
function turnFor(chat: string | undefined, conversationId: string | undefined): Registered | undefined {
  const latest = (list: Registered[]) => list.reduce<Registered | undefined>((a, b) => (!a || b.seq > a.seq ? b : a), undefined);
  if (chat) return latest(turns.filter((t) => t.chatKey === chat));
  if (conversationId) {
    const named = latest(turns.filter((t) => t.conversationId === conversationId));
    if (named) return named;
  }
  return latest(turns);
}

/** The Antigravity conversation a call names in its `_meta` (agy adds it to every MCP call). */
function antigravityConversation(params: Json): string | undefined {
  const meta = (params._meta ?? {}) as Json;
  const id = meta["antigravity.google/conversation_id"];
  return typeof id === "string" ? id : undefined;
}

/** The running Antigravity turn a call to another of Nyxs' servers comes from: its chat and
 *  permission check. Undefined for any other agent's call (Claude Code and Grok ask through
 *  their own permission requests). */
export function antigravityTurnFor(params: Json): Pick<Registered, "chatKey" | "gate"> | undefined {
  const conversation = antigravityConversation(params);
  if (conversation === undefined) return undefined;
  // A subagent's calls name its own conversation and, as the root, the turn's.
  const root = ((params._meta ?? {}) as Json)["antigravity.google/root_conversation_id"];
  const ids = [conversation, ...(typeof root === "string" ? [root] : [])];
  const gated = turns.filter((t) => t.gate);
  const latest = (list: Registered[]) => list.reduce<Registered | undefined>((a, b) => (!a || b.seq > a.seq ? b : a), undefined);
  // A new conversation's id is only known once agy names it, so a turn still without one stands
  // in. Another conversation (agy run from a terminal on the same global config) is no turn's.
  return latest(gated.filter((t) => !!t.conversationId && ids.includes(t.conversationId))) ?? latest(gated.filter((t) => !t.conversationId));
}

const QUESTIONS_SCHEMA: Json = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      description: "1-4 questions to ask the user.",
      items: {
        type: "object",
        properties: {
          question: { type: "string", description: "The full question text. Clear and specific; end with a question mark." },
          header: { type: "string", description: 'Very short chip label for the question (e.g. "Library", "Approach").' },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            description: "2-4 distinct, mutually-exclusive choices (unless multiSelect).",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Short option text the user selects (1-5 words)." },
                description: { type: "string", description: "What this option means or implies (trade-offs)." },
              },
              required: ["label"],
            },
          },
          multiSelect: { type: "boolean", description: "Allow selecting several options (default false)." },
        },
        required: ["question", "header", "options"],
      },
    },
  },
  required: ["questions"],
};

const ASK_DESCRIPTION =
  "Ask the user 1-4 multiple-choice questions in Nyxs' question card and wait for the answers. Use it when a decision is " +
  "genuinely theirs (which library, which approach, which scope) and you can't settle it from the request, the code or a " +
  'sensible default. Give each question a short header and 2-4 options; put a recommended option first with "(Recommended)" ' +
  "in its label. The user can always type their own answer, so don't add an \"Other\" option. Not for asking permission to act.";

const PLAN_DESCRIPTION =
  "In plan mode, hand your finished plan (markdown) to the user for review in Nyxs' plan view, instead of only writing it in " +
  "the chat. Call it once the plan is complete, then end your turn with one short line: don't start implementing until the " +
  "user replies.";

function tools(turn: Registered | undefined): Json[] {
  const list: Json[] = [];
  if (turn?.askUser) list.push({ name: ASK_TOOL, description: ASK_DESCRIPTION, inputSchema: QUESTIONS_SCHEMA, annotations: { readOnlyHint: true } });
  if (turn?.plan) {
    list.push({
      name: PLAN_TOOL,
      description: PLAN_DESCRIPTION,
      inputSchema: { type: "object", properties: { plan: { type: "string", description: "The full plan in markdown." } }, required: ["plan"] },
      annotations: { readOnlyHint: true },
    });
  }
  return list;
}

/** The questions as Nyxs' card takes them; null when there's nothing askable. */
export function questionsOf(args: Json): AskQuestion[] | null {
  const raw = (Array.isArray(args.questions) ? args.questions : []) as Json[];
  const questions = raw
    .map((q) => ({
      question: String(q.question ?? "").trim(),
      header: String(q.header ?? "").trim().slice(0, 30) || "Question",
      options: ((Array.isArray(q.options) ? q.options : []) as unknown[])
        .map((o) => (typeof o === "string" ? { label: o } : { label: String((o as Json)?.label ?? ""), ...(typeof (o as Json)?.description === "string" ? { description: (o as Json).description as string } : {}) }))
        .filter((o) => o.label.trim()),
      multiSelect: q.multiSelect === true,
    }))
    .filter((q) => q.question && q.options.length);
  return questions.length ? questions : null;
}

const text = (id: unknown, body: string, isError = false): Json => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) } });

/** Answers one JSON-RPC message for the chat server, from the agent of `chat`. */
export async function handleChatMcp(message: Json, chat?: string): Promise<Json> {
  const { id, method } = message;
  const params = (message.params ?? {}) as Json;
  if (id === undefined || id === null) return { jsonrpc: "2.0", id: 0, result: {} };
  const conversation = antigravityConversation(params);
  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: CHAT_MCP_SERVER, version: "1.0.0" },
          instructions: "Nyxs' chat: ask the user multiple-choice questions, and in plan mode hand over your plan for review.",
        },
      };
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: tools(turnFor(chat, conversation)) } };
    case "tools/call": {
      const turn = turnFor(chat, conversation);
      const args = (params.arguments ?? {}) as Json;
      if (params.name === ASK_TOOL) {
        const questions = questionsOf(args);
        if (!questions) return text(id, "Give at least one question with two or more options.", true);
        if (!turn?.askUser) return text(id, "Nobody is watching this chat right now: decide with a clearly stated default and say so.", true);
        const answers = await turn.askUser(questions);
        if (!answers) {
          return text(id, "The user dismissed the questions without answering. Don't assume an answer: ask how they'd like to proceed, or go on with a clearly stated default.");
        }
        const given = answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n");
        return text(id, `The user answered your question(s):\n\n${given}\n\nContinue with these answers in mind.`);
      }
      if (params.name === PLAN_TOOL) {
        const plan = typeof args.plan === "string" ? args.plan.trim() : "";
        if (!plan) return text(id, "The plan is empty: send the full plan in markdown.", true);
        if (!turn?.plan) return text(id, "This chat isn't in plan mode: go ahead with the work instead.", true);
        turn.plan(plan);
        return text(id, "The plan is now shown to the user for review. End your turn here with one short line, and don't start implementing until they reply.");
      }
      return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${String(params.name)}` } };
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(method)}` } };
  }
}
