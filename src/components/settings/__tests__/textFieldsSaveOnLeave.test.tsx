// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const update = vi.fn(async () => {});
vi.mock("@/lib/useSettings", () => ({ useSettings: () => ({ settings: {}, update }) }));
const setAppearance = vi.fn();
vi.mock("@/lib/appearance", async (orig) => ({ ...(await orig<typeof import("@/lib/appearance")>()), setAppearance: (p: unknown) => setAppearance(p) }));
const updateGeneralPreferences = vi.fn(async (_p: unknown) => {});
vi.mock("@/lib/globalConfig", async (orig) => ({
  ...(await orig<typeof import("@/lib/globalConfig")>()),
  loadGlobalConfig: async () => ({ general: { displayName: "Ana" } }),
  updateGeneralPreferences: (p: unknown) => updateGeneralPreferences(p),
}));
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/auth")>()), getMe: async () => { throw new Error("offline"); } }));

const { ComingSoonSettings } = await import("../ComingSoonSettings");
const { CodeAppearanceSettings } = await import("../CodeAppearanceSettings");
const { GeneralSettingsSection } = await import("../GeneralSettingsSection");

afterEach(() => {
  cleanup();
  update.mockClear();
  setAppearance.mockClear();
  updateGeneralPreferences.mockClear();
});

describe("Settings text fields", () => {
  it("write nothing when the user only passes through them", () => {
    const view = render(<ComingSoonSettings />);
    for (const placeholder of ["~/.nyxs/worktree", "Nyxs"]) {
      const field = view.getByPlaceholderText(placeholder);
      fireEvent.focus(field);
      fireEvent.blur(field);
    }
    view.unmount();
    expect(update).not.toHaveBeenCalled();
  });

  it("save what was typed when Settings closes before the field lost focus", () => {
    let view = render(<ComingSoonSettings />);
    fireEvent.change(view.getByPlaceholderText("Nyxs"), { target: { value: "feat " } });
    view.unmount();
    expect(update).toHaveBeenCalledWith({ worktree: { branchPrefix: "feat" } }, "user");

    view = render(<CodeAppearanceSettings />);
    fireEvent.change(view.getByPlaceholderText("e.g. JetBrains Mono"), { target: { value: "Fira Code" } });
    view.unmount();
    expect(setAppearance).toHaveBeenCalledWith({ codeFont: "Fira Code" });
  });

  it("save the profile's name and instructions when Settings closes", async () => {
    const view = render(<GeneralSettingsSection />);
    const name = await view.findByDisplayValue("Ana");
    fireEvent.change(name, { target: { value: "Ana María" } });
    view.unmount();
    expect(updateGeneralPreferences).toHaveBeenCalledWith({ displayName: "Ana María" });
  });
});
