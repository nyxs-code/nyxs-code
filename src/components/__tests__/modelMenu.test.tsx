// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ModelSelector } from "@/components/ui/chat-input/ModelSelector";
import { getLanguage, getTranslations } from "@/lib/i18n";

afterEach(cleanup);
// jsdom has no layout: the menu scrolls the open provider's tab into view.
Element.prototype.scrollIntoView = () => {};

const models = [
  { id: "openai:gpt-5", name: "GPT-5", description: "", provider: "openai", providerName: "OpenAI" },
  { id: "openai:gpt-5-mini", name: "GPT-5 mini", description: "", provider: "openai", providerName: "OpenAI" },
];

describe("the model menu", () => {
  // It marked whichever model came first, which says nothing about the model.
  it("doesn't call the first model the recommended one", () => {
    render(
      <ModelSelector models={models} selectedModel="openai:gpt-5-mini" onSelect={() => {}} effort="medium" onEffortChange={() => {}} effortLevels={null} />,
    );
    fireEvent.click(screen.getByText("GPT-5 mini"));
    expect(screen.getByRole("menu").textContent).toContain("GPT-5");
    expect(screen.queryByText(getTranslations(getLanguage()).menu.recommended)).toBeNull();
  });
});
