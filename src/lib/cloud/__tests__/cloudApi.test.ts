import { beforeEach, describe, expect, it, vi } from "vitest";

const net = vi.hoisted(() => ({
  token: "tok" as string | null,
  calls: [] as { url: string; method: string; body?: unknown; auth?: string }[],
  answers: [] as { status: number; body: unknown }[],
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(async (url: string, init: { method: string; body?: string; headers: Record<string, string> }) => {
    net.calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.Authorization });
    const next = net.answers.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status });
  }),
}));
vi.mock("@/lib/auth", () => ({ AUTH_BASE: "https://api.test", getToken: async () => net.token }));

const api = await import("@/lib/cloud/cloudApi");

beforeEach(() => {
  net.token = "tok";
  net.calls = [];
  net.answers = [];
});

describe("cloud API client", () => {
  it("creates a thread with the account's token", async () => {
    net.answers.push({ status: 200, body: { id: "t1", status: "queued" } });
    const out = await api.createCloudThread({
      projectId: "p1",
      title: "Acelerar el checkout",
      instructions: "Find why checkout is slow",
      repo: { url: "https://github.com/a/b" },
      model: { id: "anthropic:sonnet", provider: "anthropic" },
      settings: {},
    });
    expect(out).toEqual({ id: "t1", status: "queued" });
    expect(net.calls[0]).toMatchObject({ url: "https://api.test/api/cloud/threads", method: "POST", auth: "Bearer tok" });
    expect((net.calls[0].body as { title: string }).title).toBe("Acelerar el checkout");
  });

  it("refuses to call without a signed-in account", async () => {
    net.token = null;
    await expect(api.listCloudThreads()).rejects.toMatchObject({ status: 401, code: "not_signed_in" });
    expect(net.calls).toHaveLength(0);
  });

  it("says what the cloud refused", async () => {
    net.answers.push({ status: 429, body: { error: "too_many_running", message: "Two cloud threads are already running." } });
    await expect(api.sendCloudMessage("t1", "sigue")).rejects.toMatchObject({ status: 429, code: "too_many_running", message: "Two cloud threads are already running." });
  });

  it("follows events in order until done, skipping ones already seen", async () => {
    net.answers.push({ status: 200, body: { events: [{ seq: 1, at: "", type: "text", data: { text: "Hola" } }] } });
    net.answers.push({ status: 200, body: { events: [
      { seq: 1, at: "", type: "text", data: {} },
      { seq: 2, at: "", type: "status", data: { status: "working" } },
      { seq: 3, at: "", type: "done", data: { status: "review" } },
    ] } });
    const seen: number[] = [];
    const last = await api.followCloudThread("t1", 0, (e) => seen.push(e.seq), new AbortController().signal);
    expect(seen).toEqual([1, 2, 3]);
    expect(last).toBe(3);
    expect(net.calls[1].url).toContain("/threads/t1/events?after=1&wait=25");
  });

  it("stops following a thread that is gone", async () => {
    net.answers.push({ status: 404, body: { error: "not_found" } });
    await expect(api.followCloudThread("t9", 0, () => {}, new AbortController().signal)).rejects.toMatchObject({ status: 404 });
  });

  it("lists stored credential names, never their values", async () => {
    net.answers.push({ status: 200, body: { keys: ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"] } });
    expect(await api.listCloudSecrets()).toEqual(["ANTHROPIC_API_KEY", "GITHUB_TOKEN"]);
  });
});
