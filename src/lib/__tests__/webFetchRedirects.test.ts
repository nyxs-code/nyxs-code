import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolSet } from "ai";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
const fetchMock = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: (...args: unknown[]) => fetchMock(...args) }));

const { checkPermission, normalizeFetchUrl } = await import("@/lib/permissions");
const { buildTools } = await import("@/lib/agentTools");

const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });
const page = (text: string) => new Response(`<p>${text}</p>`, { headers: { "content-type": "text/html" } });

type Exec = (input: unknown, o: unknown) => Promise<unknown>;
function webFetch() {
  // The chat in auto mode: public sites go, private addresses ask, and here the user says no.
  const gate = vi.fn(async (tool: string, input: unknown) => checkPermission(tool, input, "auto", []) === "allow");
  const tools: ToolSet = buildTools({ workspace: "E:\\ws", gate, pathScope: { id: "s", extraRoots: [] } });
  const run = (url: string) => (tools.WebFetch.execute as unknown as Exec)({ url, prompt: "" }, { toolCallId: "c", messages: [] });
  return { gate, run };
}

beforeEach(() => fetchMock.mockReset());

describe("WebFetch redirects", () => {
  it("asks again before following a redirect to a private address, and doesn't go when refused", async () => {
    fetchMock.mockResolvedValueOnce(redirect("http://169.254.169.254/latest/meta-data/"));
    const { gate, run } = webFetch();
    expect(String(await run("https://example.com/r"))).toMatch(/Permission denied/);
    expect(gate).toHaveBeenLastCalledWith("WebFetch", { url: "http://169.254.169.254/latest/meta-data/" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ maxRedirections: 0 });
  });

  it("follows a redirect on the same site without asking again, relative locations included", async () => {
    fetchMock.mockResolvedValueOnce(redirect("/docs/latest/", 301)).mockResolvedValueOnce(page("hello"));
    const { gate, run } = webFetch();
    const out = String(await run("https://docs.rs/serde"));
    expect(out).toContain("hello");
    expect(fetchMock.mock.calls[1][0]).toBe("https://docs.rs/docs/latest/");
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it("asks for a redirect to another site, and stops at a loop", async () => {
    fetchMock.mockResolvedValueOnce(redirect("https://raw.example.org/a")).mockResolvedValueOnce(page("raw"));
    const { gate, run } = webFetch();
    expect(String(await run("https://example.com/a"))).toContain("raw");
    expect(gate).toHaveBeenCalledWith("WebFetch", { url: "https://raw.example.org/a" });
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(redirect("https://example.com/loop"));
    expect(String(await run("https://example.com/loop"))).toMatch(/too many redirects/i);
  });
});

describe("normalizeFetchUrl", () => {
  it("keeps http for this computer and the local network, and upgrades it elsewhere", () => {
    expect(normalizeFetchUrl("http://localhost:5173/x")).toBe("http://localhost:5173/x");
    expect(normalizeFetchUrl("localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeFetchUrl("http://192.168.1.20:8080")).toBe("http://192.168.1.20:8080");
    expect(normalizeFetchUrl("http://docs.rs/serde")).toBe("https://docs.rs/serde");
    expect(normalizeFetchUrl("docs.rs")).toBe("https://docs.rs");
  });
});
