// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MenuBar, type MenuBarActions } from "@/components/titlebar/MenuBar";
import { getTranslations } from "@/lib/i18n";
import { takeUpdateCheckRequest } from "@/lib/updateCheckRequest";

const tr = getTranslations("en-US");
const t = tr.menuBar;
afterEach(cleanup);

const actions = (): MenuBarActions => ({
  runShortcut: vi.fn(),
  newTerminal: vi.fn(),
  openFolder: vi.fn(),
  openSettings: vi.fn(),
  whatsNew: vi.fn(),
  goBack: vi.fn(),
  goForward: vi.fn(),
  cycleSession: vi.fn(),
});

const setup = (a = actions(), toggleView = vi.fn(), hasMessages = true) => {
  render(<MenuBar actions={a} onToggleView={toggleView} hasMessages={hasMessages} canGoBack canGoForward={false} />);
  return { a, toggleView };
};
const openMenu = () => fireEvent.click(screen.getByRole("button", { name: tr.titleBar.menu }));
const row = (name: string) => screen.getByRole("menuitem", { name });
const item = (name: string) => screen.getByRole("menuitem", { name: new RegExp(`^${name}`) });

describe("the ☰ menu", () => {
  it("shows each menu's items beside it on hover, and runs the shortcut's action", () => {
    const { a } = setup();
    openMenu();
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    fireEvent.mouseEnter(row(t.file).parentElement!);
    expect(item(t.newSession).textContent).toContain("Ctrl+N");
    fireEvent.click(item(t.newSession));
    expect(a.runShortcut).toHaveBeenCalledWith("newSession");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("swaps the items when another menu is hovered", () => {
    setup();
    openMenu();
    fireEvent.mouseEnter(row(t.file).parentElement!);
    fireEvent.mouseEnter(row(t.view).parentElement!);
    expect(screen.queryByRole("menu", { name: t.file })).toBeNull();
    expect(screen.getByRole("menu", { name: t.view })).toBeTruthy();
  });

  it("works from the keyboard: arrows to move and open, Enter to run, Escape to step back", () => {
    const { toggleView } = setup();
    openMenu();
    fireEvent.keyDown(document, { key: "ArrowDown" });
    fireEvent.keyDown(document, { key: "ArrowDown" });
    fireEvent.keyDown(document, { key: "ArrowDown" });
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(screen.getByRole("menu", { name: t.view })).toBeTruthy();
    fireEvent.keyDown(document, { key: "ArrowDown" });
    fireEvent.keyDown(document, { key: "Enter" });
    expect(toggleView).toHaveBeenCalledWith("terminal");

    openMenu();
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(screen.getByRole("menu", { name: t.file })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: t.file })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("leaves off what can't be done now", () => {
    const { a, toggleView } = setup(actions(), vi.fn(), false);
    openMenu();
    fireEvent.mouseEnter(row(t.view).parentElement!);
    const changes = item(tr.views.diff);
    expect(changes.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(changes);
    expect(toggleView).not.toHaveBeenCalled();

    fireEvent.mouseEnter(row(t.go).parentElement!);
    fireEvent.click(item(tr.titleBar.forward));
    expect(a.goForward).not.toHaveBeenCalled();
    fireEvent.click(item(tr.titleBar.back));
    expect(a.goBack).toHaveBeenCalled();
  });

  it("opens About and asks it to look for an update", () => {
    const { a } = setup();
    openMenu();
    fireEvent.mouseEnter(row(t.help).parentElement!);
    fireEvent.click(item(t.checkUpdates));
    expect(a.openSettings).toHaveBeenCalledWith("acerca");
    expect(takeUpdateCheckRequest()).toBe(true);
    expect(takeUpdateCheckRequest()).toBe(false);
  });
});
