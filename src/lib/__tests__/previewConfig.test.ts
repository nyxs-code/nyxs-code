import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({ invoke }));

const { readPreviewConfig, writePreviewConfig } = await import("@/lib/previewConfig");

beforeEach(() => invoke.mockReset());

describe("the preview config", () => {
  it("is kept with the project's state in Nyxs' data folder, never written into the project", async () => {
    invoke.mockResolvedValue(undefined);
    await writePreviewConfig("E:/proj", { command: "npm run dev", url: "http://localhost:5173" });
    expect(invoke).toHaveBeenCalledWith("agent_preview_config_write", {
      workspace: "E:/proj",
      content: '{\n  "command": "npm run dev",\n  "url": "http://localhost:5173"\n}\n',
    });
    expect(invoke.mock.calls.some(([cmd]) => cmd === "agent_write_file")).toBe(false);
  });

  it("reads it back, and ignores one it can't use", async () => {
    invoke.mockResolvedValueOnce('{"command":"vite","url":"http://localhost:5173"}');
    expect(await readPreviewConfig("E:/proj")).toEqual({ command: "vite", url: "http://localhost:5173" });
    expect(invoke).toHaveBeenCalledWith("agent_preview_config_read", { workspace: "E:/proj" });
    invoke.mockResolvedValueOnce("{not json");
    expect(await readPreviewConfig("E:/proj")).toBeNull();
    invoke.mockResolvedValueOnce(null);
    expect(await readPreviewConfig("E:/proj")).toBeNull();
  });
});
