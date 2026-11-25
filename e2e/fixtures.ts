import { test as base, expect, type Page, type Route } from "@playwright/test";
import { WORKSPACE, type E2ESeed, type E2EState } from "./backend";

type E2EWindow = { __E2E__: E2EState };

export { expect, WORKSPACE };

export const USER = { uid: "4242", email: "e2e@nyxs.test" };

/** An unsigned JWT: the app only decodes it (the /api/me check is answered below). */
function sessionToken(): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ ...USER, exp })}.`;
}

/** One model turn: text, tool calls the app should run before the next turn, or an HTTP error. */
export type ModelTurn =
  | { text: string }
  | { tools: { name: string; args: Record<string, unknown> }[] }
  | { error: { status: number; message: string } };

/** The model the tests talk to: DeepSeek's provider (OpenAI-compatible) with one model. */
export const MODEL = {
  id: "deepseek:e2e-model",
  apiModel: "e2e-model",
  name: "E2E Model",
  description: "DeepSeek",
  provider: "deepseek",
  contextWindow: 128_000,
};
const MODEL_HOST = "api.deepseek.com";

/** Scripted answers for MODEL, served as an OpenAI-compatible stream. */
export class FakeModel {
  private script: ModelTurn[] = [];
  /** Request bodies the app sent, in order. */
  readonly requests: { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] }[] = [];
  sideRequests = 0;

  private side: { match: RegExp; turn: ModelTurn }[] = [];

  /** Answers for side requests (no tools) whose body matches, in order: a goal check, say. */
  queueSide(match: RegExp, ...turns: ModelTurn[]): void {
    for (const turn of turns) this.side.push({ match, turn });
  }

  private takeSide(body: string): ModelTurn | undefined {
    const i = this.side.findIndex((s) => s.match.test(body));
    return i < 0 ? undefined : this.side.splice(i, 1)[0].turn;
  }

  /** Queue the next turns. Without any left, the model answers "OK". */
  queue(...turns: ModelTurn[]): void {
    this.script.push(...turns);
  }

  /** Tool results the app sent back in the latest request. */
  lastToolResults(): string[] {
    const last = this.requests.at(-1);
    return (last?.messages ?? [])
      .filter((m) => m.role === "tool")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
  }

  async answer(route: Route): Promise<void> {
    const body = route.request().postDataJSON();
    // Only the agent's own turns carry tools; side requests (prompt suggestions, summaries)
    // get a short answer and leave the script alone.
    const isAgentTurn = Array.isArray(body?.tools) && body.tools.length > 0;
    if (isAgentTurn) this.requests.push(body);
    else this.sideRequests += 1;
    const turn = (isAgentTurn ? this.script.shift() : this.takeSide(JSON.stringify(body))) ?? { text: "OK" };
    if ("error" in turn) {
      const { status, message } = turn.error;
      await route.fulfill({ status, json: { error: { message, type: "invalid_request_error" } } });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: sse(turn),
    });
  }
}

function sse(turn: Exclude<ModelTurn, { error: unknown }>): string {
  const chunk = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({
      id: "e2e",
      object: "chat.completion.chunk",
      created: 0,
      model: MODEL.apiModel,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  let out = chunk({ role: "assistant", content: "" });
  if ("text" in turn) {
    // Split in a few deltas so the UI goes through its streaming path.
    for (const piece of turn.text.match(/.{1,12}/gs) ?? []) out += chunk({ content: piece });
    out += chunk({}, "stop");
  } else {
    turn.tools.forEach((t, index) => {
      out += chunk({
        tool_calls: [
          { index, id: `call_${index}_${t.name}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } },
        ],
      });
    });
    out += chunk({}, "tool_calls");
  }
  out += `data: ${JSON.stringify({ id: "e2e", object: "chat.completion.chunk", created: 0, model: MODEL.apiModel, choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`;
  return `${out}data: [DONE]\n\n`;
}

/** How long the first page load in `app()` may take, on top of the test's own timeout. */
const FIRST_LOAD_TIMEOUT = 90_000;

export interface AppOptions {
  /** Start signed out (no session in the keychain). */
  signedOut?: boolean;
  /** Files of the open project, relative to WORKSPACE. */
  files?: Record<string, string>;
  /** Permission mode ("ask", the default, asks before every edit). */
  permissionMode?: "ask" | "acceptEdits" | "plan" | "auto";
  /** Open no project. */
  noWorkspace?: boolean;
  /** The project is a git repo on a feature branch with an open PR. */
  repo?: E2ESeed["repo"];
  /** Claude Code is connected and picked (Sonnet); `claude` runs the fake turn in e2e/backend.ts. */
  claudeCode?: boolean;
}

/** Load the app with a fake backend and a fake model; returns once the page has loaded. */
async function openApp(page: Page, origin: string, model: FakeModel, opts: AppOptions = {}): Promise<void> {
  const secrets: Record<string, string> = opts.signedOut
    ? {}
    : {
        "auth:session": sessionToken(),
        [`provider:${USER.uid}:deepseek`]: "sk-e2e",
        // Claude Code is "connected" with this marker instead of a key (CLAUDE_CODE_CONNECTED).
        ...(opts.claudeCode ? { [`provider:${USER.uid}:claude-code`]: "subscription" } : {}),
      };
  const files: E2ESeed["files"] = {};
  for (const [rel, content] of Object.entries(opts.files ?? {})) files[`${WORKSPACE}/${rel}`] = content;

  await page.addInitScript(
    ({ seed, uid, workspace, mode, model }) => {
      (window as unknown as { __E2E_SEED__: unknown }).__E2E_SEED__ = seed;
      // A reload keeps what the app stored; only the first load starts clean.
      if (sessionStorage.getItem("e2e:seeded")) return;
      sessionStorage.setItem("e2e:seeded", "1");
      localStorage.clear();
      if (workspace) {
        localStorage.setItem(`optimicer.workspace.v1::${uid}`, workspace);
        localStorage.setItem(`optimicer.recentWorkspaces.v1::${uid}`, JSON.stringify([workspace]));
      }
      if (mode) localStorage.setItem(`optimicer.permissionMode.last.v1::${uid}`, mode);
      localStorage.setItem("optimicer.providers.adopted.v1", "1");
      const claude = { id: "claude-code:sonnet", apiModel: "sonnet", name: "Sonnet", description: "Claude Code", provider: "claude-code" };
      localStorage.setItem(
        `optimicer.settings.v1::${uid}`,
        JSON.stringify({
          deepseek: { baseUrl: "https://api.deepseek.com", models: [model], enabled: [model.id] },
          ...(seed.claudeCode ? { "claude-code": { apiKey: "subscription", models: [claude], enabled: [claude.id] } } : {}),
        }),
      );
      localStorage.setItem(`optimicer.selectedModel.v1::${uid}`, seed.claudeCode ? claude.id : model.id);
    },
    {
      seed: { files, secrets, repo: opts.repo, claudeCode: opts.claudeCode },
      uid: USER.uid,
      workspace: opts.noWorkspace ? null : WORKSPACE,
      mode: opts.permissionMode ?? null,
      model: MODEL,
    },
  );

  // Everything except the Vite server's own URLs. A RegExp is matched inside Playwright's
  // driver, so the ~550 module requests of each load never reach this handler in the test
  // worker; a predicate function would make Playwright send every request here.
  const external = new RegExp(`^(?!${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/)`);
  await page.route(external, async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === "data:" || url.protocol === "blob:") return route.continue();
    if (url.host === MODEL_HOST) {
      if (url.pathname.endsWith("/chat/completions")) return model.answer(route);
      if (url.pathname.endsWith("/models")) return route.fulfill({ json: { data: [{ id: MODEL.apiModel }] } });
      return route.fulfill({ status: 404, json: {} });
    }
    if (url.host === "api.nyxs.dev") {
      if (url.pathname === "/api/me") {
        return route.fulfill({ json: { id: Number(USER.uid), email: USER.email, name: "E2E" } });
      }
      if (url.pathname === "/api/announcements") return route.fulfill({ json: [] });
      if (url.pathname === "/api/sessions") return route.fulfill({ json: [] });
      if (url.pathname === "/api/title") return route.fulfill({ json: { title: "Sesión de prueba" } });
      return route.fulfill({ json: {} });
    }
    if (url.host === "models.dev") return route.fulfill({ json: {} });
    // A local file the built-in browser shows (bootstrap.ts's convertFileSrc): a real page, so
    // the init scripts that also run in that frame work there.
    if (url.host === "asset.localhost") return route.fulfill({ contentType: "text/plain", body: "" });
    // Nothing else leaves the machine.
    return route.abort();
  });

  // The first load fetches ~550 modules from Vite, and on a busy machine that alone has taken
  // over 40 s. It gets its own limit, and the test keeps its whole timeout for what follows.
  const info = base.info();
  const budget = info.timeout;
  info.setTimeout(budget + FIRST_LOAD_TIMEOUT);
  const start = Date.now();
  await page.goto("/", { timeout: FIRST_LOAD_TIMEOUT });
  info.setTimeout(budget + (Date.now() - start));
}

export const test = base.extend<{ model: FakeModel; app: (opts?: AppOptions) => Promise<void> }>({
  model: async ({}, use) => {
    await use(new FakeModel());
  },
  app: async ({ page, model, baseURL }, use) => {
    const origin = new URL(baseURL ?? "http://localhost:1431").origin;
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await use((opts) => openApp(page, origin, model, opts));
    expect(errors, "uncaught errors in the page").toEqual([]);
  },
});

/** Commands the page invoked on the fake backend. */
export async function backendCalls(page: Page, cmd: string): Promise<Record<string, unknown>[]> {
  return page.evaluate(
    (c) => (window as unknown as E2EWindow).__E2E__.calls.filter((x) => x.cmd === c).map((x) => x.args),
    cmd,
  );
}

export async function readFakeFile(page: Page, rel: string): Promise<string | undefined> {
  return page.evaluate((p) => (window as unknown as E2EWindow).__E2E__.files.get(p), `${WORKSPACE}/${rel}`);
}

/** Every session transcript the app wrote, joined (JSONL). */
export async function savedTranscript(page: Page): Promise<string> {
  return page.evaluate(() =>
    [...(window as unknown as E2EWindow).__E2E__.transcripts.values()].flat().join("\n"),
  );
}

/** Type a prompt in the chat input (the empty-chat one, or the one under a conversation) and
 *  send it. */
export async function sendPrompt(page: Page, text: string): Promise<void> {
  const box = page.getByRole("textbox", { name: /^(Type your coding request…|Type \/ for commands)$/ });
  await box.fill(text);
  await box.press("Enter");
}
