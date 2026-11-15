import { AGENT_CLI_DEFAULT_MODEL, type AgentCliTurn } from "./agentCli";
import { streamAcpAgent, type AcpContext, type AcpSpec, type Json } from "./acpAgent";
import type { AskQuestion, Todo } from "./agentTools";
import { splitAnswer } from "./questionAnswers";

/**
 * Cursor CLI over the Agent Client Protocol (`cursor-agent acp`); the protocol itself is in
 * acpAgent.ts. Cursor adds its own methods, which map onto Nyxs' own features: questions with
 * options (`cursor/ask_question`), a plan to review (`cursor/create_plan`) and the todo list
 * (`cursor/update_todos`).
 */

/** `cursor-agent [--model <model>] acp`: options of the root command go before `acp`. */
function agentArgs(t: AgentCliTurn): string[] {
  const args: string[] = [];
  if (t.model.apiModel !== AGENT_CLI_DEFAULT_MODEL) args.push("--model", t.model.apiModel);
  args.push("acp");
  return args;
}

const TODO_STATUS: Record<string, Todo["status"]> = {
  pending: "pending",
  in_progress: "in_progress",
  inProgress: "in_progress",
  completed: "completed",
  done: "completed",
};

/** Cursor's todo list, kept per turn: `merge` updates items by id, otherwise it's replaced. */
const todoLists = new WeakMap<AcpContext["out"], Map<string, Todo>>();

function updateTodos(ctx: AcpContext, params: Json) {
  const items = Array.isArray(params.todos) ? (params.todos as Json[]) : [];
  let list = todoLists.get(ctx.out);
  if (!list || params.merge === false) {
    list = new Map();
    todoLists.set(ctx.out, list);
  }
  for (const item of items) {
    const id = String(item.id ?? item.content ?? list.size);
    if (item.status === "cancelled") {
      list.delete(id);
      continue;
    }
    list.set(id, { content: String(item.content ?? ""), status: TODO_STATUS[String(item.status)] ?? "pending" });
  }
  ctx.out.todos([...list.values()]);
}

/** Cursor's multiple-choice questions, asked with Nyxs' own question card. */
async function askQuestion(ctx: AcpContext, params: Json): Promise<Json> {
  const raw = (Array.isArray(params.questions) ? params.questions : []) as Json[];
  if (!ctx.t.askUser || !raw.length) return { outcome: { outcome: "skipped" } };
  const header = typeof params.title === "string" && params.title ? params.title.slice(0, 30) : "Cursor";
  const questions: AskQuestion[] = raw.map((q) => ({
    question: String(q.prompt ?? q.question ?? ""),
    header,
    options: ((Array.isArray(q.options) ? q.options : []) as Json[]).map((o) => ({ label: String(o.label ?? o.id ?? "") })),
    multiSelect: q.allowMultiple === true,
  }));
  const answers = await ctx.t.askUser(questions);
  if (!answers) return { outcome: { outcome: "cancelled" } };
  return {
    outcome: {
      outcome: "answered",
      answers: raw.map((q, i) => {
        const given = answers.find((a) => a.question === questions[i].question)?.answer ?? "";
        const options = (Array.isArray(q.options) ? q.options : []) as Json[];
        const { picked, text } = splitAnswer(given, questions[i].options.map((o) => o.label));
        const ids = options.filter((o) => picked.includes(String(o.label ?? o.id))).map((o) => String(o.id));
        // An answer typed in ("Other") rather than picked goes as text.
        return { questionId: String(q.id ?? i), selectedOptionIds: ids, ...(text ? { text } : {}) };
      }),
    },
  };
}

/** A plan Cursor hands over for approval: shown for review like Nyxs' own plan mode, and the
 *  turn ends there; the user's next message says whether to go ahead. */
function createPlan(ctx: AcpContext, params: Json): Json {
  const plan = typeof params.plan === "string" ? params.plan : "";
  const todos = Array.isArray(params.todos) ? (params.todos as Json[]) : [];
  if (todos.length) updateTodos(ctx, { todos, merge: false });
  ctx.out.plan(plan);
  ctx.cancel();
  return { outcome: { outcome: "cancelled" } };
}

export const CURSOR_ACP: AcpSpec = {
  cli: "cursor",
  label: "Cursor CLI",
  args: agentArgs,
  authMethods: ["cursor_login"],
  loginHint: "Inicia sesión con «cursor-agent login».",
  request: (ctx, method, params) => {
    if (method === "cursor/ask_question") return askQuestion(ctx, params);
    if (method === "cursor/create_plan") return Promise.resolve(createPlan(ctx, params));
    // Sent as a notification or, with an id, as a request that waits for an answer.
    if (method === "cursor/update_todos") {
      updateTodos(ctx, params);
      return Promise.resolve({});
    }
    return null;
  },
  notification: (ctx, method, params) => {
    if (method === "cursor/update_todos") updateTodos(ctx, params);
  },
};

export function streamCursorCli(t: AgentCliTurn): Promise<string> {
  return streamAcpAgent(CURSOR_ACP, t);
}
