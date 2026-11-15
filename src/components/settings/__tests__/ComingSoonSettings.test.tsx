// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { getTranslations } from "@/lib/i18n";

const state = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, update: vi.fn() }));

vi.mock("@/lib/useSettings", () => ({ useSettings: () => ({ settings: state.settings, update: state.update }) }));

const { ComingSoonSettings } = await import("@/components/settings/ComingSoonSettings");

afterEach(() => {
  cleanup();
  state.update.mockReset();
  state.settings = {};
});

const t = getTranslations("en-US").codeSettings;

describe("the read-only commands switch", () => {
  it("is on until turned off, and turning it off writes the user layer's permissions", () => {
    render(<ComingSoonSettings />);
    const toggle = screen.getByRole("switch", { name: t.readOnlyAutoTitle });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(state.update).toHaveBeenCalledWith({ permissions: { autoApproveReadOnly: false } }, "user");
  });

  it("shows what settings.json says", () => {
    state.settings = { permissions: { autoApproveReadOnly: false } };
    render(<ComingSoonSettings />);
    const toggle = screen.getByRole("switch", { name: t.readOnlyAutoTitle });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(state.update).toHaveBeenCalledWith({ permissions: { autoApproveReadOnly: true } }, "user");
  });
});
