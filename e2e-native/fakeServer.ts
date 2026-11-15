// The local server the native app talks to in these tests: an OpenAI-compatible model that
// answers from a script (like FakeModel in e2e/fixtures.ts, over real HTTP this time), and the
// few Nyxs backend routes the app calls on its own (/api/me, /api/title…).

import { createServer, type IncomingMessage, type Server } from "node:http";

export type ModelTurn = { text: string } | { tools: { name: string; args: Record<string, unknown> }[] };

export const MODEL_ID = "native-model";
export const USER = { id: 4242, email: "native@nyxs.test", name: "Native E2E" };

type ChatRequest = { messages: { role: string; content: unknown }[]; tools?: unknown[] };

function sse(turn: ModelTurn): string {
  const chunk = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "native", object: "chat.completion.chunk", created: 0, model: MODEL_ID, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  let out = chunk({ role: "assistant", content: "" });
  if ("text" in turn) {
    for (const piece of turn.text.match(/.{1,12}/gs) ?? []) out += chunk({ content: piece });
    out += chunk({}, "stop");
  } else {
    turn.tools.forEach((t, index) => {
      out += chunk({ tool_calls: [{ index, id: `call_${index}_${t.name}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } }] });
    });
    out += chunk({}, "tool_calls");
  }
  out += `data: ${JSON.stringify({ id: "native", object: "chat.completion.chunk", created: 0, model: MODEL_ID, choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`;
  return `${out}data: [DONE]\n\n`;
}

async function body(req: IncomingMessage): Promise<string> {
  let raw = "";
  for await (const part of req) raw += part;
  return raw;
}

export class FakeServer {
  private script: ModelTurn[] = [];
  /** The agent's own turns (they carry tools), in order. */
  readonly requests: ChatRequest[] = [];
  private server: Server | null = null;

  queue(...turns: ModelTurn[]): void {
    this.script.push(...turns);
  }

  /** The tool results the app sent back in its latest turn. */
  lastToolResults(): string[] {
    return (this.requests.at(-1)?.messages ?? [])
      .filter((m) => m.role === "tool")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
  }

  /** Every tool result the app sent in any turn. */
  allToolResults(): string[] {
    return this.requests.flatMap((r) => r.messages.filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))));
  }

  async start(port: number): Promise<void> {
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (url.pathname.endsWith("/chat/completions") && req.method === "POST") {
        const request = JSON.parse(await body(req)) as ChatRequest;
        const agentTurn = Array.isArray(request.tools) && request.tools.length > 0;
        if (agentTurn) this.requests.push(request);
        // Side requests (prompt suggestions, titles) get a short answer and leave the script alone.
        const turn = (agentTurn ? this.script.shift() : undefined) ?? { text: "OK" };
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.end(sse(turn));
        return;
      }
      if (url.pathname.endsWith("/models")) return json(200, { data: [{ id: MODEL_ID, object: "model" }] });
      if (url.pathname === "/api/me") return json(200, USER);
      if (url.pathname === "/api/title") return json(200, { title: "Native session" });
      if (url.pathname === "/api/announcements") return json(200, []);
      if (url.pathname.startsWith("/api/")) return json(200, {});
      json(404, { error: "not found" });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", () => resolve());
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
