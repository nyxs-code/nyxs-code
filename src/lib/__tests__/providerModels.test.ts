import { afterEach, describe, expect, it, vi } from "vitest";
import { PROVIDERS } from "@/lib/models";

interface Call {
  url: string;
  headers: Record<string, string>;
}

function stubFetch(body: unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
    return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(body) };
  });
  return calls;
}

// The module captures `fetch` when it loads, so each test loads it after stubbing.
async function loadFetchModels() {
  return (await import("@/lib/providerModels")).fetchProviderModels;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("fetchProviderModels (Anthropic)", () => {
  it("names the workspace when the key is organization-scoped", async () => {
    const calls = stubFetch({ data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }] });
    const fetchProviderModels = await loadFetchModels();

    const models = await fetchProviderModels(PROVIDERS.anthropic, { apiKey: "sk-ant-test", workspaceId: "wrkspc_abc" });

    expect(models.map((m) => m.id)).toEqual(["anthropic:claude-sonnet-5"]);
    expect(calls[0].headers["anthropic-workspace-id"]).toBe("wrkspc_abc");
    expect(calls[0].headers["X-Api-Key"] ?? calls[0].headers["x-api-key"]).toBe("sk-ant-test");
  });

  it("leaves the workspace header out for a key tied to one workspace", async () => {
    const calls = stubFetch({ data: [] });
    const fetchProviderModels = await loadFetchModels();

    await fetchProviderModels(PROVIDERS.anthropic, { apiKey: "sk-ant-test", workspaceId: "   " });

    expect(calls[0].headers["anthropic-workspace-id"]).toBeUndefined();
  });
});

describe("fetchProviderModels (Google)", () => {
  it("sends the key in a header, never in the address", async () => {
    const calls = stubFetch({ models: [{ name: "models/gemini-3-pro", displayName: "Gemini 3 Pro", supportedGenerationMethods: ["generateContent"] }] });
    const fetchProviderModels = await loadFetchModels();
    const models = await fetchProviderModels(PROVIDERS.google, { apiKey: "AIza-secret" });
    expect(models.map((m) => m.id)).toEqual(["google:gemini-3-pro"]);
    expect(calls[0].url).not.toContain("AIza-secret");
    expect(calls[0].headers["x-goog-api-key"]).toBe("AIza-secret");
  });

  it("keeps the key out of the error when the answer isn't JSON", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, statusText: "OK", text: async () => "<html>proxy</html>" }));
    const fetchProviderModels = await loadFetchModels();
    const err = await fetchProviderModels(PROVIDERS.google, { apiKey: "AIza-secret" }).catch((e: unknown) => String(e));
    expect(err).toContain("no devolvió JSON");
    expect(err).not.toContain("AIza-secret");
  });
});
