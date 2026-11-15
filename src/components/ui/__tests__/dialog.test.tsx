// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

afterEach(cleanup);

/** The dialog waits a microtask (no website is open in the browser panel) before it shows. */
const settle = () => act(async () => {});

function Basic({ onClose = () => {}, dismissible }: { onClose?: () => void; dismissible?: boolean }) {
  return (
    <Dialog open onClose={onClose} dismissible={dismissible}>
      <DialogHeader>
        <DialogTitle>Abrir carpeta</DialogTitle>
      </DialogHeader>
      <input aria-label="Ruta" />
      <DialogFooter>
        <button type="button">Cancelar</button>
        <button type="button">Abrir</button>
      </DialogFooter>
    </Dialog>
  );
}

describe("Dialog", () => {
  it("renders nothing while closed", () => {
    render(<Dialog open={false} onClose={() => {}}>contenido</Dialog>);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is a modal dialog named by its title", async () => {
    render(<Basic />);
    await settle();
    const dialog = screen.getByRole("dialog", { name: "Abrir carpeta" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // It can sit over a website open in the browser panel.
    expect(dialog.hasAttribute("data-webview-hole")).toBe(true);
    expect(dialog.parentElement?.hasAttribute("data-webview-backdrop")).toBe(true);
  });

  it("focuses the first control, not the close button", async () => {
    render(<Basic />);
    await settle();
    expect(document.activeElement).toBe(screen.getByLabelText("Ruta"));
  });

  it("focuses what initialFocus points at", async () => {
    function WithInitial() {
      const ref = useRef<HTMLButtonElement>(null);
      return (
        <Dialog open onClose={() => {}} initialFocus={ref}>
          <DialogTitle>Confirmar</DialogTitle>
          <button type="button">Cancelar</button>
          <button type="button" ref={ref}>Borrar</button>
        </Dialog>
      );
    }
    render(<WithInitial />);
    await settle();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Borrar" }));
  });

  it("closes with Escape, the close button and a click outside, but not a click inside", async () => {
    const onClose = vi.fn();
    render(<Basic onClose={onClose} />);
    await settle();
    const user = userEvent.setup();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);

    const dialog = screen.getByRole("dialog");
    await user.click(dialog.querySelector<HTMLElement>("[data-dialog-close]")!);
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.mouseDown(dialog);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.mouseDown(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("can't be dismissed when dismissible is false, and shows no close button", async () => {
    const onClose = vi.fn();
    render(<Basic onClose={onClose} dismissible={false} />);
    await settle();
    await userEvent.setup().keyboard("{Escape}");
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog").querySelector("[data-dialog-close]")).toBeNull();
  });

  it("keeps Tab inside, in both directions", async () => {
    render(<Basic />);
    await settle();
    const user = userEvent.setup();
    const close = screen.getByRole("dialog").querySelector<HTMLElement>("[data-dialog-close]")!;
    const open = screen.getByRole("button", { name: "Abrir" });

    open.focus();
    await user.tab();
    expect(document.activeElement).toBe(close);

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(open);
  });

  it("gives the focus back to what had it when it closes", async () => {
    function Opener() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Ajustes</button>
          <Dialog open={open} onClose={() => setOpen(false)}>
            <DialogTitle>Ajustes</DialogTitle>
            <button type="button">Guardar</button>
          </Dialog>
        </>
      );
    }
    render(<Opener />);
    const user = userEvent.setup();
    const opener = screen.getByRole("button", { name: "Ajustes" });
    await user.click(opener);
    await settle();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Guardar" }));

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes only the innermost of two nested dialogs on Escape", async () => {
    const outerClose = vi.fn();
    function Nested() {
      const [inner, setInner] = useState(true);
      return (
        <Dialog open onClose={outerClose}>
          <DialogTitle>Ajustes</DialogTitle>
          <button type="button">Fuera</button>
          <Dialog open={inner} onClose={() => setInner(false)} stacked>
            <DialogTitle>Conectar proveedor</DialogTitle>
            <button type="button">Dentro</button>
          </Dialog>
        </Dialog>
      );
    }
    render(<Nested />);
    await settle();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Dentro" }));

    await userEvent.setup().keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Conectar proveedor" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Ajustes" })).toBeTruthy();
    expect(outerClose).not.toHaveBeenCalled();
  });

  it("keeps Tab inside the inner dialog when two are open", async () => {
    render(
      <Dialog open onClose={() => {}}>
        <DialogTitle>Ajustes</DialogTitle>
        <button type="button">Fuera</button>
        <Dialog open onClose={() => {}} stacked>
          <DialogTitle>Conectar</DialogTitle>
          <button type="button">Uno</button>
          <button type="button">Dos</button>
        </Dialog>
      </Dialog>,
    );
    await settle();
    const user = userEvent.setup();
    screen.getByRole("button", { name: "Dos" }).focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Uno" }));
  });
});
