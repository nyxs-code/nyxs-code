// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** The merged settings: the project's values are mixed in with the user's. */
const merged = {
  rag: { enabled: true, topK: 99 },
  workflow: { enabled: true, maxAgents: 40 },
  lsp: { enabled: true, diagnosticsWaitMs: 9000 },
  pullRequests: { autoFix: true },
  worktree: { location: "D:/project-worktrees" },
};
const update = vi.fn(async () => {});
vi.mock("@/lib/useSettings", () => ({ useSettings: () => ({ settings: merged, update }) }));

const { RagSettingsSection, WorkflowSettingsSection, LspSettingsSection } = await import("../CapabilitySettings");
const { ComingSoonSettings } = await import("../ComingSoonSettings");
const { getTranslations } = await import("@/lib/i18n");

afterEach(() => {
  cleanup();
  update.mockClear();
});

const flip = (view: ReturnType<typeof render>, label: string) => fireEvent.click(view.getAllByRole("switch", { name: label })[0]);

describe("a settings switch", () => {
  it("writes only its own key to the user's settings, not the project's values beside it", () => {
    const c = getTranslations("en-US");
    let view = render(<RagSettingsSection />);
    flip(view, c.ragSettings.enable);
    expect(update).toHaveBeenLastCalledWith({ rag: { enabled: false } }, "user");
    cleanup();

    view = render(<WorkflowSettingsSection />);
    flip(view, c.settings.capabilitiesPage.workflowEnable);
    expect(update).toHaveBeenLastCalledWith({ workflow: { enabled: false } }, "user");
    cleanup();

    view = render(<LspSettingsSection />);
    flip(view, c.settings.capabilitiesPage.lspEnable);
    expect(update).toHaveBeenLastCalledWith({ lsp: { enabled: false } }, "user");
    cleanup();

    view = render(<ComingSoonSettings />);
    flip(view, c.codeSettings.prCreateTitle);
    expect(update).toHaveBeenLastCalledWith({ pullRequests: { autoCreate: true } }, "user");
    flip(view, c.codeSettings.worktreeIsolateTitle);
    expect(update).toHaveBeenLastCalledWith({ worktree: { isolateSubagents: true } }, "user");
  });
});
