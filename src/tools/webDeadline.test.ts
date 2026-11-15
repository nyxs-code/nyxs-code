import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { createWebFetchTool } from "./WebFetch/tool";
import type { ToolContext } from "./context";
import { WEB_TIMEOUT_MS, withDeadline } from "./web";

const never = () => new Promise<never>(() => {});

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(tauriFetch).mockReset();
});

describe("withDeadline", () => {
  it("returns what the work returns in time", async () => {
    await expect(withDeadline(async () => "page", 1000)).resolves.toBe("page");
  });

  it("rejects after the deadline even when the work ignores its signal", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const p = withDeadline((s) => {
      seen = s;
      return never();
    }, 5000);
    const check = expect(p).rejects.toThrow("timed out after 5 s");
    await vi.advanceTimersByTimeAsync(5000);
    await check;
    expect(seen?.aborted).toBe(true);
  });

  it("rejects at once when the caller aborts, and when it already had", async () => {
    const ctl = new AbortController();
    const p = withDeadline(never, 60_000, ctl.signal);
    ctl.abort();
    await expect(p).rejects.toThrow("cancelled");
    await expect(withDeadline(never, 60_000, ctl.signal)).rejects.toThrow("cancelled");
  });
});

describe("WebFetch never hangs", () => {
  type Execute = (input: { url: string; prompt: string }, opts: { abortSignal?: AbortSignal }) => Promise<string>;
  const run = (ctx: Partial<ToolContext>, url: string, abortSignal?: AbortSignal) =>
    (createWebFetchTool(ctx as ToolContext).execute as unknown as Execute)({ url, prompt: "what is it" }, { abortSignal });
  const URL_ = "https://www.google.com/search?q=Example+Bakery#lrd=0x1111111111111111:0x2222222222222222,3,,,,";

  it("reports a server that never answers instead of spinning", async () => {
    vi.useFakeTimers();
    vi.mocked(tauriFetch).mockImplementation(never as unknown as typeof tauriFetch);
    const out = run({}, URL_);
    await vi.advanceTimersByTimeAsync(WEB_TIMEOUT_MS);
    expect(await out).toMatch(/^WebFetch failed for .*: timed out after 30 s$/);
  });

  it("reports a body that stalls after the headers arrived", async () => {
    vi.useFakeTimers();
    vi.mocked(tauriFetch).mockResolvedValue({ ok: true, status: 200, headers: new Headers({ "content-type": "text/html" }), text: never } as unknown as Response);
    const out = run({}, URL_);
    await vi.advanceTimersByTimeAsync(WEB_TIMEOUT_MS);
    expect(await out).toContain("timed out");
  });

  it("stops as soon as the user interrupts the turn", async () => {
    let requestSignal: AbortSignal | undefined;
    vi.mocked(tauriFetch).mockImplementation(((_url: string, init: { signal?: AbortSignal }) => {
      requestSignal = init.signal;
      return never();
    }) as unknown as typeof tauriFetch);
    const ctl = new AbortController();
    const out = run({}, URL_, ctl.signal);
    await Promise.resolve();
    ctl.abort();
    expect(await out).toContain("cancelled");
    expect(requestSignal?.aborted).toBe(true);
  });

  it("returns the page as it is when the helper model stalls", async () => {
    vi.useFakeTimers();
    const html = `<html><head><title>Example Bakery</title></head><body>${"Reviews and hours. ".repeat(500)}</body></html>`;
    vi.mocked(tauriFetch).mockResolvedValue({ ok: true, status: 200, headers: new Headers({ "content-type": "text/html" }), text: async () => html } as unknown as Response);
    const extract = vi.fn(never);
    const out = run({ extract }, URL_);
    await vi.advanceTimersByTimeAsync(90_000);
    const text = await out;
    expect(extract).toHaveBeenCalled();
    expect(text).toContain("Title: Example Bakery");
    expect(text).toContain("Reviews and hours.");
  });
});
