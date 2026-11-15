// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

let open = "E:/a";
vi.mock("@/lib/ipc", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@/lib/diagnostics", () => ({ clearDiagnosticsCache: () => {} }));
vi.mock("@/lib/skills", () => ({ loadProjectMemory: async () => "memory" }));
vi.mock("@/lib/systemPrompt", () => ({ clearSystemPromptCache: () => {} }));
vi.mock("@/lib/globalConfig", () => ({
  dismissOnboarding: async () => {},
  getOnboardingSeenCount: async () => 99,
  isWorkspaceTrusted: async () => true,
  markOnboardingSeen: async () => {},
  ONBOARDING_MAX_SHOWS: 3,
  trustWorkspace: async () => {},
}));
vi.mock("@/lib/settingsRuntime", () => ({
  getProjectTrustSnapshot: () => null,
  inspectProjectSettings: async () => ({ digest: "", findings: [] }),
  setSettingsWorkspace: () => {},
  subscribeSettings: () => () => {},
  trustProjectSettings: async () => {},
}));
vi.mock("@/lib/workspace", () => ({
  addRecentWorkspace: () => [],
  allowWorkspaceAccess: async () => {},
  loadRecentWorkspaces: () => [],
  loadWorkspace: () => open,
  pickWorkspace: async () => "E:/b",
  removeRecentWorkspace: () => [],
  saveWorkspace: (ws: string | null) => { open = ws ?? ""; },
  workspaceExists: async () => true,
  workspaceName: (p: string) => p,
}));

const { useWorkspace } = await import("@/lib/useWorkspace");
const { setViewCloseGuard } = await import("@/lib/viewCloseGuard");

afterEach(() => setViewCloseGuard("files", null));

describe("changing the open folder with an unsaved file in Files", () => {
  it("stays in the folder when the user keeps the file", async () => {
    const { result } = renderHook(() => useWorkspace(() => {}));
    setViewCloseGuard("files", (_close, cancel) => cancel?.());
    let ok: boolean | string | null = true;
    await act(async () => { ok = await result.current.ensureWorkspaceActive("E:/b"); });
    expect(ok).toBe(false);
    expect(result.current.workspace).toBe("E:/a");
    await act(async () => { ok = await result.current.pickAndTrustWorkspace(); });
    expect(ok).toBeNull();
    expect(result.current.workspace).toBe("E:/a");
    act(() => { result.current.closeWorkspace("E:/a"); });
    expect(result.current.workspace).toBe("E:/a");
  });

  it("changes folder once the user lets the file go", async () => {
    const { result } = renderHook(() => useWorkspace(() => {}));
    setViewCloseGuard("files", (close) => close());
    await act(async () => { await result.current.ensureWorkspaceActive("E:/b"); });
    expect(result.current.workspace).toBe("E:/b");
  });
});
