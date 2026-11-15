import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ToolSet } from "ai";
import {
  MCP_TIMEOUTS,
  clearMcpToolsCache,
  configToServer,
  convertMcpResult,
  formatMcpOutput,
  getMcpStatuses,
  isStdioServer,
  loadMcpTools,
  mcpServerTarget,
  mcpToolModelOutput,
  parseCommandLine,
  parseEnvLines,
  type InvokeImpl,
  type McpServer,
} from "@/lib/mcp";

interface InvokeCall {
  cmd: string;
  args?: Record<string, unknown>;
}

function fakeInvoke(handler: (cmd: string, args: Record<string, unknown>) => unknown) {
  const calls: InvokeCall[] = [];
  const impl: InvokeImpl = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    return (await handler(cmd, args ?? {})) as T;
  };
  return { impl, calls };
}

const TOOL_LIST = { tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: {} } }] };

function stdioHandler(overrides: Partial<Record<string, (args: Record<string, unknown>) => unknown>> = {}) {
  return (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "mcp_stdio_start") return { id: args.id, state: "ready" };
    if (cmd === "mcp_stdio_stop") return true;
    const method = String(args.method);
    const override = overrides[method];
    if (override) return override(args);
    if (method === "tools/list") return TOOL_LIST;
    if (method === "tools/call") return { content: [{ type: "text", text: "file body" }] };
    throw new Error(`unexpected ${method}`);
  };
}

const unusedFetch = (async () => {
  throw new Error("fetch must not be used for stdio servers");
}) as typeof fetch;

const noInvoke: InvokeImpl = async () => {
  throw new Error("invoke must not be used for HTTP servers");
};

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
}

function fakeHttpServer(opts: { expireListOnce?: boolean; hang?: string } = {}) {
  const calls: { method: string; session: string | null }[] = [];
  let sessions = 0;
  let expired = false;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const session = new Headers(init?.headers).get("Mcp-Session-Id");
    calls.push({ method: body.method, session });
    if (body.method === opts.hang) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    if (body.method === "initialize") {
      sessions += 1;
      return jsonResponse(
        { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "http" } } },
        { "Mcp-Session-Id": `s${sessions}` },
      );
    }
    if (body.id === undefined) return new Response(null, { status: 202 });
    if (opts.expireListOnce && !expired && body.method === "tools/list") {
      expired = true;
      return new Response("Session not found", { status: 404 });
    }
    if (body.method === "tools/list") return jsonResponse({ jsonrpc: "2.0", id: body.id, result: TOOL_LIST });
    return jsonResponse({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "nope" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function stdioServer(id: string, extra: Partial<McpServer> = {}): McpServer {
  return { id, name: "fs", url: "", transport: "stdio", command: "npx", args: ["-y", "server-fs", "/tmp"], enabled: true, ...extra };
}

function httpServer(id: string): McpServer {
  return { id, name: "remote", url: "https://mcp.example.test/mcp", enabled: true };
}

async function runTool(tools: ToolSet, name: string, input: unknown): Promise<unknown> {
  const tool = tools[name] as { execute: (input: unknown, options: unknown) => Promise<unknown> };
  return tool.execute(input, { toolCallId: "call-1", messages: [] });
}

const originalTimeouts = { ...MCP_TIMEOUTS };

beforeEach(() => {
  clearMcpToolsCache();
});

afterEach(() => {
  Object.assign(MCP_TIMEOUTS, originalTimeouts);
});

describe("configToServer", () => {
  it("keeps stdio servers instead of dropping them", () => {
    const server = configToServer("user", "filesystem", { command: "npx", args: ["-y", "pkg", 3], env: { A: "1" } });
    expect(server).toMatchObject({
      id: "file:user:filesystem",
      transport: "stdio",
      command: "npx",
      args: ["-y", "pkg", "3"],
      env: { A: "1" },
      source: "user",
      enabled: true,
    });
    expect(isStdioServer(server!)).toBe(true);
    expect(mcpServerTarget(server!)).toBe("npx -y pkg 3");
  });

  it("treats explicit type stdio as stdio and url configs as http", () => {
    expect(configToServer("project", "a", { type: "stdio", command: "node", url: "x" })?.transport).toBe("stdio");
    expect(configToServer("project", "b", { type: "stdio" })).toBeNull();
    const http = configToServer("project", "c", { url: "https://x.test/mcp", enabled: false });
    expect(http).toMatchObject({ transport: "http", url: "https://x.test/mcp", enabled: false });
    expect(isStdioServer(http!)).toBe(false);
  });

  it("treats legacy stored servers with a url as http", () => {
    expect(isStdioServer(httpServer("legacy"))).toBe(false);
  });
});

describe("loadMcpTools routing", () => {
  it("sends stdio servers to the Rust host and never to fetch", async () => {
    const { impl, calls } = fakeInvoke(stdioHandler());
    const server = stdioServer("route-stdio", { env: { TOKEN: "t" } });
    const { tools, errors } = await loadMcpTools([server], { fetchImpl: unusedFetch, invokeImpl: impl });

    expect(errors).toEqual([]);
    expect(Object.keys(tools)).toEqual(["mcp__fs__read_file"]);
    expect(calls[0]).toEqual({
      cmd: "mcp_stdio_start",
      args: {
        id: "route-stdio",
        config: { command: "npx", args: ["-y", "server-fs", "/tmp"], env: { TOKEN: "t" }, cwd: null },
        timeoutMs: MCP_TIMEOUTS.initialize,
      },
    });
    expect(calls[1]).toMatchObject({ cmd: "mcp_stdio_request", args: { id: "route-stdio", method: "tools/list" } });

    const out = await runTool(tools, "mcp__fs__read_file", { path: "a.txt" });
    expect(out).toBe("file body");
    expect(calls[2]).toMatchObject({
      cmd: "mcp_stdio_request",
      args: { id: "route-stdio", method: "tools/call", params: { name: "read_file", arguments: { path: "a.txt" } }, timeoutMs: MCP_TIMEOUTS.call },
    });
    expect(getMcpStatuses()["route-stdio"]).toMatchObject({ state: "connected", toolCount: 1 });
  });

  it("sends http servers through fetch and never to the Rust host", async () => {
    const { fetchImpl, calls } = fakeHttpServer();
    const { tools, errors } = await loadMcpTools([httpServer("route-http")], { fetchImpl, invokeImpl: noInvoke });
    expect(errors).toEqual([]);
    expect(Object.keys(tools)).toEqual(["mcp__remote__read_file"]);
    expect(calls.map((c) => c.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
  });

  it("restarts a stdio server that is no longer running and retries once", async () => {
    let failures = 0;
    const { impl, calls } = fakeInvoke(
      stdioHandler({
        "tools/list": () => {
          if (failures++ === 0) return Promise.reject("NOT_RUNNING: el servidor MCP terminó (código 1)");
          return TOOL_LIST;
        },
      }),
    );
    const { tools, errors } = await loadMcpTools([stdioServer("restart-stdio")], { invokeImpl: impl });
    expect(errors).toEqual([]);
    expect(Object.keys(tools)).toHaveLength(1);
    expect(calls.map((c) => c.cmd)).toEqual(["mcp_stdio_start", "mcp_stdio_request", "mcp_stdio_start", "mcp_stdio_request"]);
  });

  it("does not retry a call that crashed the server and reports a clean error", async () => {
    const { impl, calls } = fakeInvoke(
      stdioHandler({ "tools/call": () => Promise.reject("EXITED: el servidor MCP terminó (código 3)\nboom") }),
    );
    const { tools } = await loadMcpTools([stdioServer("crash-stdio")], { invokeImpl: impl });
    await expect(runTool(tools, "mcp__fs__read_file", {})).rejects.toThrow(/^el servidor MCP terminó \(código 3\)\nboom$/);
    expect(calls.filter((c) => c.cmd === "mcp_stdio_start")).toHaveLength(1);
  });

  it("records start failures in the status store for the connectors UI", async () => {
    const { impl } = fakeInvoke((cmd) => {
      if (cmd === "mcp_stdio_start") return Promise.reject("No se pudo lanzar «npx»: not found");
      return null;
    });
    const { tools, errors } = await loadMcpTools([stdioServer("broken-stdio")], { invokeImpl: impl });
    expect(tools).toEqual({});
    expect(errors).toEqual(["fs: No se pudo lanzar «npx»: not found"]);
    expect(getMcpStatuses()["broken-stdio"]).toMatchObject({ state: "error", error: "No se pudo lanzar «npx»: not found" });
  });
});

describe("HTTP client", () => {
  it("re-initializes when the session expires and retries the request", async () => {
    const { fetchImpl, calls } = fakeHttpServer({ expireListOnce: true });
    const { tools, errors } = await loadMcpTools([httpServer("expire-http")], { fetchImpl });
    expect(errors).toEqual([]);
    expect(Object.keys(tools)).toHaveLength(1);
    expect(calls).toEqual([
      { method: "initialize", session: null },
      { method: "notifications/initialized", session: "s1" },
      { method: "tools/list", session: "s1" },
      { method: "initialize", session: null },
      { method: "notifications/initialized", session: "s2" },
      { method: "tools/list", session: "s2" },
    ]);
  });

  it("times out a request that never answers", async () => {
    MCP_TIMEOUTS.list = 50;
    const { fetchImpl } = fakeHttpServer({ hang: "tools/list" });
    const { errors } = await loadMcpTools([httpServer("timeout-http")], { fetchImpl });
    expect(errors).toEqual(['remote: MCP request "tools/list" timed out after 50 ms']);
    expect(getMcpStatuses()["timeout-http"]?.state).toBe("error");
  });
});

describe("tool results", () => {
  const withImage = {
    content: [
      { type: "text", text: "screenshot taken" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "resource", resource: { uri: "file:///a.txt", text: "inner" } },
      { type: "audio", data: "AAAA", mimeType: "audio/wav" },
    ],
  };

  it("keeps images as image parts when the model can see them", () => {
    const out = formatMcpOutput(convertMcpResult(withImage), true);
    expect(mcpToolModelOutput(out)).toEqual({
      type: "content",
      value: [
        { type: "text", text: "screenshot taken\n[resource file:///a.txt]\ninner\n[audio content: audio/wav, 0 KB]" },
        { type: "image-data", data: "aGVsbG8=", mediaType: "image/png" },
      ],
    });
  });

  it("describes images in text when the model cannot see them", () => {
    const out = formatMcpOutput(convertMcpResult(withImage), false);
    expect(typeof out).toBe("string");
    expect(out).toContain("[image: image/png, 0 KB — the current model can't view images]");
    expect(mcpToolModelOutput(out)).toEqual({ type: "text", value: out });
  });

  it("marks tool errors and handles empty or structured results", () => {
    expect(formatMcpOutput(convertMcpResult({ content: [{ type: "text", text: "bad" }], isError: true }), true)).toBe(
      "Tool reported an error:\nbad",
    );
    expect(formatMcpOutput(convertMcpResult({ content: [] }), true)).toBe("(empty result)");
    expect(formatMcpOutput(convertMcpResult({ structuredContent: { ok: 1 } }), true)).toBe('{\n  "ok": 1\n}');
  });

  it("returns image parts from a stdio tool call", async () => {
    const { impl } = fakeInvoke(stdioHandler({ "tools/call": () => withImage }));
    const { tools } = await loadMcpTools([stdioServer("image-stdio")], { invokeImpl: impl, toolImages: true });
    const output = await runTool(tools, "mcp__fs__read_file", {});
    const modelOutput = mcpToolModelOutput(output);
    expect(modelOutput.type).toBe("content");
    expect(modelOutput.value).toContainEqual({ type: "image-data", data: "aGVsbG8=", mediaType: "image/png" });
  });
});

describe("command parsing", () => {
  it("splits a command line respecting quotes and Windows paths", () => {
    expect(parseCommandLine('npx -y @modelcontextprotocol/server-filesystem "C:\\My Projects" \'two words\'')).toEqual([
      "npx",
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "C:\\My Projects",
      "two words",
    ]);
    expect(parseCommandLine('  node  server.js ""  ')).toEqual(["node", "server.js", ""]);
  });

  it("parses KEY=value env lines and rejects malformed ones", () => {
    expect(parseEnvLines("A=1\n\n# note\nB = two=2\r\n")).toEqual({ A: "1", B: "two=2" });
    expect(parseEnvLines("")).toEqual({});
    expect(parseEnvLines("NOVALUE")).toBeNull();
  });
});
