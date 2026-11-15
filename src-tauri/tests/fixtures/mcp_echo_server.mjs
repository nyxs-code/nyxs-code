import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const text = (value) => ({ content: [{ type: "text", text: String(value) }] });
const noArgs = { type: "object", properties: {} };

const tools = [
  { name: "echo", description: "Echoes the given text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "env", description: "Returns MCP_TEST_TOKEN", inputSchema: noArgs },
  { name: "hang", description: "Never answers", inputSchema: noArgs },
  { name: "roundtrip", description: "Pings the client before answering", inputSchema: noArgs },
  { name: "spawn_child", description: "Starts a long-lived child process", inputSchema: noArgs },
  { name: "crash", description: "Exits with an error", inputSchema: noArgs },
];

const waiting = new Map();

const callTool = (id, name, args) => {
  switch (name) {
    case "echo":
      return reply(id, text(args?.text ?? ""));
    case "env":
      return reply(id, text(process.env.MCP_TEST_TOKEN ?? ""));
    case "hang":
      return undefined;
    case "roundtrip": {
      const pingId = `srv-${id}`;
      waiting.set(pingId, () => reply(id, text("pong")));
      return send({ jsonrpc: "2.0", id: pingId, method: "ping" });
    }
    case "spawn_child": {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      return reply(id, text(child.pid));
    }
    case "crash":
      return process.stderr.write("boom\n", () => process.exit(3));
    default:
      return fail(id, -32602, `Unknown tool: ${name}`);
  }
};

process.stderr.write("echo-test ready\n");
process.stdout.write("banner: not json\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === undefined) {
    const resume = waiting.get(message.id);
    waiting.delete(message.id);
    resume?.();
    return;
  }
  if (message.id === undefined) return;
  switch (message.method) {
    case "initialize":
      return reply(message.id, {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "echo-test", version: "1.0.0" },
      });
    case "tools/list":
      return reply(message.id, { tools });
    case "tools/call":
      return callTool(message.id, message.params.name, message.params.arguments);
    default:
      return fail(message.id, -32601, `Method not found: ${message.method}`);
  }
});
