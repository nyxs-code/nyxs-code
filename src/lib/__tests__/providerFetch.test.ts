import { describe, it, expect, vi } from "vitest";
import {
  nativeToolSearchUnsupported,
  replayResponse,
  serialToolCallProviders,
  withFatalErrorShortCircuit,
  withNativeToolSearchFallback,
  withSingleToolCalls,
  withUsageAccounting,
} from "@/lib/providerFetch";

type Call = { body: Record<string, unknown> | null };

function scripted(responses: Array<() => Response>) {
  const calls: Call[] = [];
  const base = vi.fn(async (_input: unknown, init?: RequestInit) => {
    calls.push({ body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    return next();
  }) as unknown as typeof fetch;
  return { base, calls };
}

const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const withTools = { model: "m", messages: [], tools: [{ type: "function", function: { name: "Read" } }] };

describe("withSingleToolCalls", () => {
  it("retries once with parallel_tool_calls:false and remembers the provider", async () => {
    const { base, calls } = scripted([
      () => new Response("This model only supports single tool calls at once", { status: 400 }),
      () => new Response("ok", { status: 200 }),
      () => new Response("ok", { status: 200 }),
    ]);
    const f = withSingleToolCalls(base, "serial-provider");
    expect((await f("u", json(withTools))).status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0].body).not.toHaveProperty("parallel_tool_calls");
    expect(calls[1].body?.parallel_tool_calls).toBe(false);
    expect(serialToolCallProviders.has("serial-provider")).toBe(true);

    await f("u", json(withTools));
    expect(calls).toHaveLength(3);
    expect(calls[2].body?.parallel_tool_calls).toBe(false);
  });

  it("passes other errors through with the body intact and stale content headers removed", async () => {
    const { base, calls } = scripted([
      () =>
        new Response("bad request: missing field", {
          status: 400,
          statusText: "Bad Request",
          headers: { "content-encoding": "gzip", "content-length": "999", "x-request-id": "abc" },
        }),
    ]);
    const res = await withSingleToolCalls(base, "other-provider")("u", json(withTools));
    expect(calls).toHaveLength(1);
    expect(res.status).toBe(400);
    expect(res.statusText).toBe("Bad Request");
    expect(await res.text()).toBe("bad request: missing field");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).not.toBe("999");
    expect(res.headers.get("x-request-id")).toBe("abc");
    expect(serialToolCallProviders.has("other-provider")).toBe(false);
  });

  it("does not touch requests without tools or server errors", async () => {
    const { base, calls } = scripted([
      () => new Response("ok", { status: 200 }),
      () => new Response("parallel_tool_calls overloaded", { status: 503 }),
    ]);
    const f = withSingleToolCalls(base, "plain-provider");
    await f("u", json({ model: "m", messages: [] }));
    expect((await f("u", json(withTools))).status).toBe(503);
    expect(calls).toHaveLength(2);
    expect(serialToolCallProviders.has("plain-provider")).toBe(false);
  });
});

describe("withFatalErrorShortCircuit", () => {
  it("turns a billing 429 into a 402 so it is not retried", async () => {
    const { base } = scripted([() => new Response('{"error":"insufficient balance"}', { status: 429 })]);
    const res = await withFatalErrorShortCircuit(base)("u", json({}));
    expect(res.status).toBe(402);
    expect(res.statusText).toBe("Payment Required");
    expect(await res.text()).toContain("insufficient balance");
  });

  it("leaves ordinary rate limits and client errors alone", async () => {
    const { base } = scripted([
      () => new Response("slow down", { status: 429 }),
      () => new Response("insufficient balance", { status: 400 }),
    ]);
    const f = withFatalErrorShortCircuit(base);
    const limited = await f("u", json({}));
    expect(limited.status).toBe(429);
    expect(await limited.text()).toBe("slow down");
    expect((await f("u", json({}))).status).toBe(400);
  });
});

describe("withUsageAccounting", () => {
  it("asks for usage once and never overrides an explicit value", async () => {
    const { base, calls } = scripted([() => new Response("ok"), () => new Response("ok")]);
    const f = withUsageAccounting(base);
    await f("u", json({ model: "m" }));
    await f("u", json({ model: "m", usage: { include: false } }));
    expect(calls[0].body?.usage).toEqual({ include: true });
    expect(calls[1].body?.usage).toEqual({ include: false });
  });
});

describe("withNativeToolSearchFallback", () => {
  const deferred = { tools: [{ name: "Read" }, { name: "WebFetch", defer_loading: true }, { type: "tool_search_tool_bm25_20251119" }] };

  it("drops deferral after the API rejects it and keeps doing so for that model", async () => {
    const { base, calls } = scripted([
      () => new Response("tool_search is not supported for this model", { status: 400 }),
      () => new Response("ok"),
      () => new Response("ok"),
    ]);
    const f = withNativeToolSearchFallback(base, "anthropic:old");
    expect((await f("u", json(deferred))).status).toBe(200);
    expect(calls[1].body?.tools).toEqual([{ name: "Read" }, { name: "WebFetch" }]);
    expect(nativeToolSearchUnsupported.has("anthropic:old")).toBe(true);
    await f("u", json(deferred));
    expect(calls).toHaveLength(3);
    expect(calls[2].body?.tools).toEqual([{ name: "Read" }, { name: "WebFetch" }]);
  });

  it("returns unrelated 400s unchanged", async () => {
    const { base, calls } = scripted([() => new Response("max_tokens too large", { status: 400 })]);
    const res = await withNativeToolSearchFallback(base, "anthropic:new")("u", json(deferred));
    expect(calls).toHaveLength(1);
    expect(await res.text()).toBe("max_tokens too large");
    expect(nativeToolSearchUnsupported.has("anthropic:new")).toBe(false);
  });
});

describe("replayResponse", () => {
  it("keeps status and other headers by default", () => {
    const res = replayResponse(new Response("x", { status: 418, statusText: "Teapot", headers: { "x-a": "1" } }), "y");
    expect(res.status).toBe(418);
    expect(res.statusText).toBe("Teapot");
    expect(res.headers.get("x-a")).toBe("1");
  });
});
