// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownText } from "@/components/message/markdown";

afterEach(cleanup);

const words = (el: HTMLElement) => [...el.querySelectorAll(".stream-word")].map((w) => w.textContent);

describe("a reply being written", () => {
  it("animates word by word, only in the last block", () => {
    const { container } = render(<MarkdownText text={"Primer párrafo.\n\nSegundo **en curso** ya"} streaming />);
    const [first, second] = container.querySelectorAll("p");
    expect(first.querySelector(".stream-word")).toBeNull();
    expect(words(second)).toEqual(["Segundo ", "en ", "curso", " ", "ya"]);
  });

  it("keeps the words already on screen when more text arrives", () => {
    const { container, rerender } = render(<MarkdownText text="Hola mundo" streaming />);
    const hola = container.querySelector(".stream-word");
    rerender(<MarkdownText text="Hola mundo, ¿qué tal?" streaming />);
    expect(container.querySelector(".stream-word")).toBe(hola);
    expect(words(container)).toEqual(["Hola ", "mundo, ", "¿qué ", "tal?"]);
  });

  it("is plain text once it is written", () => {
    const { container } = render(<MarkdownText text="Hola mundo" />);
    expect(container.querySelector(".stream-word")).toBeNull();
    expect(container.textContent).toBe("Hola mundo");
  });
});
