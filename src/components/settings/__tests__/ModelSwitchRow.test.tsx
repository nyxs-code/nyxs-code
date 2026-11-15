// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ModelSwitchRow } from "@/components/settings/ModelSwitchRow";
import { getTranslations } from "@/lib/i18n";

afterEach(cleanup);

const t = getTranslations("en-US").models;

describe("ModelSwitchRow", () => {
  it("is a switch named after what a click does, showing the name alone", () => {
    const onToggle = vi.fn();
    render(<ModelSwitchRow name="GPT Test" checked={false} onToggle={onToggle} />);
    const row = screen.getByRole("switch", { name: `${t.enable} GPT Test` });
    expect(row.getAttribute("aria-checked")).toBe("false");
    expect(row.textContent).toBe("GPT Test");
    fireEvent.click(row);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("offers to turn off a model that is on", () => {
    render(<ModelSwitchRow name="GPT Test" checked onToggle={() => {}} />);
    expect(screen.getByRole("switch", { name: `${t.disable} GPT Test` }).getAttribute("aria-checked")).toBe("true");
  });

  it("keeps the 6px corner unless the list asks for a tighter one", () => {
    const { rerender } = render(<ModelSwitchRow name="GPT Test" checked={false} onToggle={() => {}} />);
    expect(screen.getByRole("switch").className).toContain("rounded-[6px]");
    rerender(<ModelSwitchRow name="GPT Test" checked={false} onToggle={() => {}} className="rounded-[5px]" />);
    expect(screen.getByRole("switch").className).toContain("rounded-[5px]");
    expect(screen.getByRole("switch").className).not.toContain("rounded-[6px]");
  });
});
