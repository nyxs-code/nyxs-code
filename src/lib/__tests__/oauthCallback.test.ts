import { beforeEach, describe, expect, it, vi } from "vitest";

const httpFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: httpFetch }));
const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({ invoke }));
vi.mock("@/lib/secureStore", () => ({ getSecret: vi.fn(async () => null), setSecret: vi.fn(), deleteSecret: vi.fn() }));

const { signInWithGoogle } = await import("@/lib/auth");
const { runMcpOAuth } = await import("@/lib/mcpOAuth");

// The example server has no dynamic registration, so the sign-in goes with a registered app.
const app = { clientId: "example-app" };
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
    await expect(runMcpOAuth("https://mcp.example.com/mcp", "Example", app)).rejects.toThrow("no browser");
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
    await expect(runMcpOAuth("https://mcp.example.com/mcp", "Example", app)).rejects.toThrow("access_denied");
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
      await expect(runMcpOAuth("https://mcp.example.com/mcp", "Example", app)).rejects.toThrow("access_denied");
      const es = getTranslations("es-ES").oauthPage;
      expect(es.failedTitle).not.toBe(getTranslations("en-US").oauthPage.failedTitle);
      const pages = waits().map((w) => w.page);
      expect(pages).toEqual([
        {
          connectedTitle: es.signedInTitle,
          connectedText: es.connectedText,
          failedTitle: es.signInFailedTitle,
          failedText: es.failedText,
          serviceIcon: expect.stringContaining("<svg"),
          doneUrl: "https://api.nyxs.dev/auth/done/",
        },
        {
          connectedTitle: "Example conectado a Nyxs",
          connectedText: es.connectedText,
          failedTitle: "No se pudo conectar Example",
          failedText: es.failedText,
          serviceInitial: "E",
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("signs in with a one-time code that only this app can trade, with PKCE", async () => {
    let opened = "";
    invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "oauth_reserve") return 4321;
      if (cmd === "agent_open_external") opened = String(args.url);
      if (cmd === "oauth_wait") return "code=one-time&done=k3y";
      return "";
    });
    let traded: { code?: string; verifier?: string } = {};
    httpFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/token")) {
        traded = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ token: "session.jwt" }), { status: 200 });
      }
      return new Response("", { status: 404 });
    });
    await signInWithGoogle();

    const sent = new URL(opened).searchParams;
    expect(sent.get("return")).toBe("http://127.0.0.1:4321/callback");
    expect(traded.code).toBe("one-time");
    // The challenge that went out is the SHA-256 of the verifier traded with the code.
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(traded.verifier)));
    const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(sent.get("challenge")).toBe(challenge);
    expect(opened).not.toContain(String(traded.verifier));
    const { setSecret } = await import("@/lib/secureStore");
    expect(setSecret).toHaveBeenCalledWith("auth:session", "session.jwt");
  });

  it("doesn't take a session from the callback itself", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "oauth_reserve") return 4321;
      if (cmd === "oauth_wait") return "token=forged";
      return "";
    });
    await expect(signInWithGoogle()).rejects.toThrow();
  });

  it("shows the connector's own logo, drawn light when it is single-colour", async () => {
    const { connectorCallbackPage } = await import("@/lib/oauthPage");
    const svg = '<svg fill="currentColor" viewBox="0 0 24 24"><path d="M0 0h24v24z"/></svg>';
    vi.stubGlobal("fetch", vi.fn(async () => new Response(svg)));
    try {
      const page = await connectorCallbackPage("GitHub", { logo: "/connector-icons/github.svg", color: "#e5e5e5" });
      expect(page.serviceIcon).toBe(svg.replace("currentColor", "#ececec"));
      // The catalog's colour for black logos isn't used for the initial.
      expect(page.serviceColor).toBeUndefined();
      expect((await connectorCallbackPage("Linear", { color: "#5e6ad2" })).serviceColor).toBe("#5e6ad2");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
