// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const os = { current: "macos" as "windows" | "macos" | "linux" };
vi.mock("@/lib/desktopOs", () => ({ desktopOs: () => os.current }));
const perms = { current: { platform: "macos", supported: true, accessibility: false, screenRecording: false } };
const invoke = vi.fn(async (cmd: string, _args?: unknown): Promise<unknown> => (cmd === "computer_permissions" ? { ...perms.current } : undefined));
vi.mock("@/lib/ipc", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));

const { ComputerUseSetting } = await import("../ComputerUseSetting");
const { getTranslations } = await import("@/lib/i18n");
const cs = getTranslations("en-US").codeSettings;

async function mount(checked: boolean) {
  const onChange = vi.fn();
  await act(async () => { render(<ComputerUseSetting checked={checked} onChange={onChange} />); });
  return onChange;
}

afterEach(() => {
  cleanup();
  invoke.mockClear();
  os.current = "macos";
  perms.current = { platform: "macos", supported: true, accessibility: false, screenRecording: false };
});

describe("ComputerUseSetting", () => {
  it("on macOS lists the missing permissions and opens System Settings for one", async () => {
    await mount(true);
    expect(screen.getByText(cs.computerPermAccessibility)).toBeTruthy();
    expect(screen.getByText(cs.computerPermScreen)).toBeTruthy();
    expect(screen.getByText(cs.computerPermRestartNote)).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: cs.computerPermOpen });
    expect(buttons).toHaveLength(2);
    await act(async () => { fireEvent.click(buttons[0]); });
    expect(invoke).toHaveBeenCalledWith("computer_request_permission", { kind: "accessibility" });
  });

  it("reads them again when the window regains focus", async () => {
    await mount(true);
    perms.current = { ...perms.current, accessibility: true, screenRecording: true };
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(screen.getAllByText(cs.computerPermGranted)).toHaveLength(2);
    expect(screen.queryByRole("button", { name: cs.computerPermOpen })).toBeNull();
    expect(screen.queryByText(cs.computerPermRestartNote)).toBeNull();
  });

  it("hides the permissions while the switch is off", async () => {
    await mount(false);
    expect(screen.queryByText(cs.computerPermAccessibility)).toBeNull();
    expect(screen.getByRole("switch", { name: cs.computerUseTitle })).toBeTruthy();
  });

  it("keeps the switch off with a note where it isn't supported", async () => {
    os.current = "linux";
    perms.current = { platform: "linux", supported: false, accessibility: false, screenRecording: false };
    await mount(true);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText(cs.computerUseUnsupported)).toBeTruthy();
  });

  it("on Windows asks nothing and shows only the switch", async () => {
    os.current = "windows";
    await mount(true);
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.getByRole("switch", { name: cs.computerUseTitle })).toBeTruthy();
    expect(screen.queryByText(cs.computerPermAccessibility)).toBeNull();
  });
});
