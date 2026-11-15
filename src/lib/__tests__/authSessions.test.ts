import { beforeEach, describe, expect, it, vi } from "vitest";

const httpFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: httpFetch }));
vi.mock("@/lib/ipc", () => ({ invoke: vi.fn() }));

// An unsigned JWT that expires in an hour: getToken only decodes it.
const payload = btoa(JSON.stringify({ uid: 7, email: "a@b.test", exp: Math.floor(Date.now() / 1000) + 3600 }));
vi.mock("@/lib/secureStore", () => ({
  getSecret: vi.fn(async () => `x.${payload}.y`),
  setSecret: vi.fn(),
  deleteSecret: vi.fn(),
}));

const { listSessions } = await import("@/lib/auth");

const answer = (body: unknown) => httpFetch.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));

describe("listSessions", () => {
  beforeEach(() => httpFetch.mockReset());

  it("returns the server's list", async () => {
    const session = { id: "s1", device: "Nyxs Desktop", location: null, createdAt: "", updatedAt: "", current: true };
    answer([session]);
    expect(await listSessions()).toEqual([session]);
  });

  it("falls back to an empty list when the answer is not a list", async () => {
    for (const body of [{}, null, { sessions: [] }, "oops"]) {
      answer(body);
      expect(await listSessions()).toEqual([]);
    }
  });

  it("still fails on an error status", async () => {
    httpFetch.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    await expect(listSessions()).rejects.toThrow("sessions_failed_500");
  });
});
