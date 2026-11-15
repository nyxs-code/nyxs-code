// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MessageErrorBoundary } from "@/components/MessageErrorBoundary";
import { setLanguage } from "@/lib/i18n";

function Broken(): never {
  throw new Error("bad markdown");
}

beforeAll(() => setLanguage("es-ES"));
afterEach(cleanup);

describe("a message that can't be shown", () => {
  it("gives way to a notice with its raw text to copy, and the rest of the chat stays", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <>
        <MessageErrorBoundary text="**texto** crudo">
          <Broken />
        </MessageErrorBoundary>
        <MessageErrorBoundary text="ok">
          <p>Mensaje siguiente</p>
        </MessageErrorBoundary>
      </>,
    );
    expect(screen.getByText("No se pudo mostrar este mensaje.")).toBeTruthy();
    expect(screen.getByText("Mensaje siguiente")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copiar texto" }));
    });
    expect(writeText).toHaveBeenCalledWith("**texto** crudo");
  });

  it("tries again when the message changes", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    function Maybe() {
      if (fail) throw new Error("not yet");
      return <p>Ya se ve</p>;
    }
    const view = render(<MessageErrorBoundary text="a"><Maybe /></MessageErrorBoundary>);
    expect(screen.getByText("No se pudo mostrar este mensaje.")).toBeTruthy();
    fail = false;
    view.rerender(<MessageErrorBoundary text="ab"><Maybe /></MessageErrorBoundary>);
    expect(screen.getByText("Ya se ve")).toBeTruthy();
  });
});
