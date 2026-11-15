import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  privacy: {} as Record<string, boolean>,
  requests: [] as { url: string; body: Record<string, unknown> }[],
}));

const respond = async (url: string, init: { body: string }) => {
  fake.requests.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
  const json = url.endsWith("/api/title") ? { title: "Arreglar el login" } : { description: "A login form." };
  return { ok: true, status: 200, json: async () => json };
};

// Stand-ins for the Nyxs service: no real request leaves.
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: respond }));
vi.mock("@/lib/modelClient", () => ({ httpFetch: respond }));
vi.mock("@/lib/auth", () => ({ AUTH_BASE: "https://example.invalid", getToken: async () => "token" }));
vi.mock("@/lib/settingsRuntime", () => ({ getSettingsForSource: async () => ({ privacy: fake.privacy }) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "1.0.0" }));
vi.mock("@/lib/ipc", () => ({
  invoke: async (cmd: string) =>
    cmd === "device_info"
      ? { platform: "windows", os: "Windows 11 Pro", os_version: "24H2", arch: "x86_64", hwid: "abc", cpu: "Ryzen", cpu_cores: "16", total_memory: "32 GB", hostname: "desk" }
      : null,
}));

const { generateChatTitle } = await import("@/lib/titles");
const { describeAttachedImages, toModelMessage } = await import("@/lib/turnInput");
const telemetry = await import("@/lib/telemetry");

const image = { mediaType: "image/png", dataUrl: "data:image/png;base64,AAAA", name: "login.png" };

beforeEach(() => {
  fake.privacy = {};
  fake.requests = [];
});

describe("chat titles", () => {
  it("come from the service when allowed", async () => {
    expect(await generateChatTitle("arregla el login que falla")).toBe("Arreglar el login");
    expect(fake.requests.map((r) => r.url)).toEqual(["https://example.invalid/api/title"]);
  });

  it("come from the message itself when turned off", async () => {
    fake.privacy = { chatTitles: false };
    expect(await generateChatTitle("arregla el login que falla")).toBe("arregla el login que falla");
    expect(fake.requests).toEqual([]);
  });
});

describe("images for models that can't see them", () => {
  const turn = { role: "user" as const, content: "¿Qué ves?", images: [image] };

  it("are described by the service when allowed", async () => {
    const d = await describeAttachedImages([turn]);
    expect(d.get(image.dataUrl)).toBe("A login form.");
  });

  it("aren't sent when turned off, and the model is told there was one", async () => {
    fake.privacy = { imageDescriptions: false };
    const d = await describeAttachedImages([turn]);
    expect(fake.requests).toEqual([]);
    const msg = toModelMessage(turn, false, d);
    expect(msg.content).toContain("image attachment(s) were provided");
  });
});

describe("the device report", () => {
  it("carries only the operating system when turned off", async () => {
    fake.privacy = { deviceDetails: false };
    await telemetry.reportDevice();
    expect(fake.requests[0].body.device).toEqual({ platform: "windows", os: "Windows 11 Pro" });
  });
});
