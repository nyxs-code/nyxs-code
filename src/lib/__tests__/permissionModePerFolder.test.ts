// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ permissions: {} as { defaultMode?: string } }));
vi.mock("@/lib/settingsRuntime", () => ({ getMergedSnapshot: () => settings }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { loadPermissionMode, savePermissionMode } from "@/lib/workspace";

describe("permission mode per folder", () => {
  beforeEach(() => {
    localStorage.clear();
    settings.permissions = {};
  });

  it("remembers the mode chosen in each folder", () => {
    savePermissionMode("auto", "D:\\proj-a");
    savePermissionMode("acceptEdits", "D:\\proj-b");
    expect(loadPermissionMode("D:\\proj-a")).toBe("auto");
    expect(loadPermissionMode("d:/proj-a/")).toBe("auto");
    expect(loadPermissionMode("D:\\proj-b")).toBe("acceptEdits");
  });

  it("doesn't remember Plan: a new chat goes back to the folder's mode", () => {
    savePermissionMode("auto", "D:\\proj");
    savePermissionMode("plan", "D:\\proj");
    expect(loadPermissionMode("D:\\proj")).toBe("auto");
  });

  it("uses settings' defaultMode for a folder with no mode of its own, in either naming", () => {
    savePermissionMode("auto", "D:\\other");
    settings.permissions = { defaultMode: "acceptEdits" };
    expect(loadPermissionMode("D:\\new")).toBe("acceptEdits");
    settings.permissions = { defaultMode: "default" };
    expect(loadPermissionMode("D:\\new")).toBe("ask");
    expect(loadPermissionMode("D:\\other")).toBe("auto");
  });

  it("falls back to the last mode chosen anywhere, then Manual", () => {
    expect(loadPermissionMode("D:\\new")).toBe("ask");
    savePermissionMode("auto", "D:\\other");
    expect(loadPermissionMode("D:\\new")).toBe("auto");
  });
});
