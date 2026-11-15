import { beforeEach, describe, expect, it, vi } from "vitest";

const httpFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: httpFetch }));
const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({ invoke }));
vi.mock("@/lib/secureStore", () => ({ getSecret: vi.fn(async () => null), setSecret: vi.fn(), deleteSecret: vi.fn() }));

const { signInWithGoogle } = await import("@/lib/auth");
const { runMcpOAuth } = await import("@/lib/mcpOAuth");

const waits = () => invoke.mock.calls.filter(([cmd]) => cmd === "oauth_wait").map(([, args]) => args);

beforeEach(() => {
  invoke.mockReset();
  httpFetch.mockReset();
  // No well-known metadata: discovery falls back to the server's /authorize and /token.
  httpFetch.mockResolvedValue(new Response("", { status: 404 }));
});

describe("the OAuth callback port", () => {
  it("is closed when the sign-in fails before waiting for the browser", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "oauth_reserve") return 4321;
      if (cmd === "agent_open_external") throw new Error("no browser");
      return "";
    });
    await expect(signInWithGoogle()).rejects.toThrow("no browser");
    expect(waits()).toEqual([{ port: 4321, timeoutMs: 0 }]);
    invoke.mockClear();
    await expect(runMcpOAuth("https://mcp.example.com/mcp", "Example")).rejects.toThrow("no browser");
    expect(waits()).toEqual([{ port: 4321, timeoutMs: 0 }]);
  });

  it("only takes a connector's callback that carries the state it sent", async () => {
    let sent = "";
    invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "oauth_reserve") return 4321;
      if (cmd === "agent_open_external") sent = new URL(String(args.url)).searchParams.get("state") ?? "";
      if (cmd === "oauth_wait") return "error=access_denied";
      return "";
    });
    await expect(runMcpOAuth("https://mcp.example.com/mcp", "Example")).rejects.toThrow("access_denied");
    expect(sent).not.toBe("");
    expect(waits()).toEqual([{ port: 4321, timeoutMs: 300_000, state: sent, page: expect.any(Object) }]);
  });

  it("tells the browser tab what to say in the app's language", async () => {
    const { getTranslations, LANG_KEY } = await import("@/lib/i18n");
    vi.stubGlobal("localStorage", { getItem: (k: string) => (k === LANG_KEY ? "es-ES" : null) });
    try {
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "oauth_reserve") return 4321;
        if (cmd === "oauth_wait") return "error=access_denied";
        return "";
      });
      await expect(signInWithGoogle()).rejects.toThrow("access_denied");
      await expect(runMcpOAuth("https://mcp.example.com/mcp", "Example")).rejects.toThrow("access_denied");
      const es = getTranslations("es-ES").oauthPage;
      expect(es.failedTitle).not.toBe(getTranslations("en-US").oauthPage.failedTitle);
      const pages = waits().map((w) => w.page);
      expect(pages).toEqual([
        { connectedTitle: es.connectedTitle, connectedText: es.connectedText, failedTitle: es.failedTitle, failedText: es.failedText },
        { connectedTitle: es.connectedTitle, connectedText: es.connectedText, failedTitle: es.failedTitle, failedText: es.failedText },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
