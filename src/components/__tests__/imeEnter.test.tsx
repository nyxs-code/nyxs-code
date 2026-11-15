// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuestionPrompt } from "@/components/QuestionPrompt";
import { isComposingKey } from "@/lib/imeKeys";

afterEach(cleanup);

describe("isComposingKey", () => {
  it("is true while an input method composes, and for the Enter that ends it in WebKit", () => {
    expect(isComposingKey({ key: "Enter", keyCode: 13, nativeEvent: { isComposing: true } })).toBe(true);
    expect(isComposingKey({ key: "Enter", keyCode: 229, nativeEvent: { isComposing: false } })).toBe(true);
    expect(isComposingKey({ key: "Enter", keyCode: 13, nativeEvent: { isComposing: false } })).toBe(false);
    expect(isComposingKey({ key: "Enter", keyCode: 13, isComposing: true })).toBe(true);
  });
});

describe("Enter in the question card", () => {
  it("picks the input method's candidate instead of answering", () => {
    const onAnswer = vi.fn();
    const view = render(
      <QuestionPrompt questions={[{ question: "¿Cuál?", header: "Elige", options: [{ label: "Opción roja" }, { label: "Opción verde" }] }]} onAnswer={onAnswer} onDismiss={() => {}} />,
    );
    const card = view.getAllByText("Opción roja")[0];
    fireEvent.click(card);
    fireEvent.keyDown(card, { key: "Enter", keyCode: 229 });
    expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.keyDown(card, { key: "Enter", keyCode: 13 });
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });
});
