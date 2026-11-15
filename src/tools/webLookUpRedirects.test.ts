import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: (...args: unknown[]) => fetchMock(...args) }));

const { lookUpPage } = await import("./web");

const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
const page = (title: string) => new Response(`<html><head><title>${title}</title></head></html>`, { headers: { "content-type": "text/html" } });

beforeEach(() => fetchMock.mockReset());

describe("looking up the page a search query names", () => {
  it("doesn't follow a redirect into this computer or the local network unless allowed", async () => {
    fetchMock.mockResolvedValueOnce(redirect("http://169.254.169.254/latest/meta-data/")).mockResolvedValueOnce(page("Secrets"));
    const allow = vi.fn(async () => false);
    expect(await lookUpPage("https://short.example/x", undefined, allow)).toBeNull();
    expect(allow).toHaveBeenCalledWith("http://169.254.169.254/latest/meta-data/");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ maxRedirections: 0 });
  });

  it("still follows a short link to another public site, like youtu.be", async () => {
    fetchMock.mockResolvedValueOnce(redirect("https://www.youtube.com/watch?v=abc")).mockResolvedValueOnce(page("Song - YouTube"));
    const allow = vi.fn(async () => false);
    const meta = await lookUpPage("https://youtu.be/abc", undefined, allow);
    expect(meta?.title).toContain("Song");
    expect(allow).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[1][0]).toBe("https://www.youtube.com/watch?v=abc");
  });
});
